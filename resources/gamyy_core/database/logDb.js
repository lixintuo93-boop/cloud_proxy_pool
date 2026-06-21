// database/logDb.js
// sqlite3 是可选依赖：本地模式下写入 SQLite；云端 agent 若未安装则降级为只打印 console
let sqlite3;
try {
  sqlite3 = require('sqlite3').verbose();
} catch (_) {
  sqlite3 = null;
}

const path = require('path');

class LogDatabase {
  constructor() {
    this.dbPath   = path.join(__dirname, '../data/ticket_checker.db');
    this.db       = null;
    this.runId    = null;
    this.taskId   = null;
    this.disabled = !sqlite3;  // sqlite3 不可用时进入无操作模式
  }

  // ─── 初始化入口（由 TicketService.init() await 调用）────────────────────
  async init(runContext = {}) {
    if (this.disabled) {
      this.taskId = runContext.taskId ?? null;
      console.log('📋 日志数据库不可用（sqlite3 未安装），日志仅输出到 console');
      return;
    }
    await this._openDb();
    await this._createTables();
    this.runId  = await this._createRun(runContext);
    this.taskId = runContext.taskId ?? null;
    console.log(`📋 任务运行记录已创建 (run_id: ${this.runId}, task_id: ${this.taskId})`);
  }

  // ─── 打开数据库 ──────────────────────────────────────────────────────────
  _openDb() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ─── 建表（固定表名，IF NOT EXISTS）────────────────────────────────────
  _createTables() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS task_runs (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id                  INTEGER,
            task_name                TEXT,
            account_id               INTEGER,
            account_snapshot         TEXT,
            system_config_version_id INTEGER,
            task_config_version_id   INTEGER,
            proxy_snapshot           TEXT,
            started_at               TEXT NOT NULL,
            ended_at                 TEXT,
            status                   TEXT NOT NULL DEFAULT 'running',
            stop_reason              TEXT,
            created_at               TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now', 'localtime'))
          )
        `, (err) => { if (err) console.error('❌ 创建 task_runs 表失败:', err); });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS channel_logs (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id               INTEGER,
            task_id              INTEGER,
            channel_id           TEXT,
            proxy_ip             TEXT,
            proxy_port           INTEGER,
            real_proxy_ip        TEXT,
            proxy_index          INTEGER,
            target_host          TEXT,
            target_port          INTEGER,
            channel_type         TEXT DEFAULT 'check',
            connection_start_time TEXT,
            connection_end_time  TEXT,
            connection_duration  INTEGER,
            connection_status    TEXT,
            retry_count          INTEGER DEFAULT 0,
            max_retries          INTEGER DEFAULT 0,
            error_message        TEXT,
            created_at           TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now', 'localtime'))
          )
        `, (err) => { if (err) console.error('❌ 创建 channel_logs 表失败:', err); });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS check_logs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id           INTEGER,
            task_id          INTEGER,
            account_id       INTEGER,
            mobile           TEXT,
            proxy_ip         TEXT,
            proxy_port       INTEGER,
            channel_id       TEXT,
            request_index    INTEGER,
            start_time       TEXT,
            end_time         TEXT,
            duration         INTEGER,
            status_code      INTEGER,
            request_data     TEXT,
            request_headers  TEXT,
            response_data    TEXT,
            response_headers TEXT,
            error_message    TEXT,
            submit_sign      TEXT,
            created_at       TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now', 'localtime'))
          )
        `, (err) => { if (err) console.error('❌ 创建 check_logs 表失败:', err); });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS lock_logs (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id              INTEGER,
            task_id             INTEGER,
            account_id          INTEGER,
            mobile              TEXT,
            proxy_ip            TEXT,
            proxy_port          INTEGER,
            channel_id          TEXT,
            request_index       INTEGER,
            start_time          TEXT,
            end_time            TEXT,
            duration            INTEGER,
            status_code         INTEGER,
            request_data        TEXT,
            request_headers     TEXT,
            request_body        TEXT,
            response_data       TEXT,
            response_headers    TEXT,
            error_message       TEXT,
            lock_success        INTEGER DEFAULT 0,
            plan_id             TEXT,
            patient_id          INTEGER,
            lock_details        TEXT,
            submit_sign         TEXT,
            submit_sign_source  TEXT,
            created_at          TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now', 'localtime'))
          )
        `, (err) => { if (err) console.error('❌ 创建 lock_logs 表失败:', err); });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS heartbeat_logs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id           INTEGER,
            task_id          INTEGER,
            channel_id       TEXT,
            proxy_ip         TEXT,
            proxy_port       INTEGER,
            target_host      TEXT,
            target_port      INTEGER,
            start_time       TEXT,
            end_time         TEXT,
            duration         INTEGER,
            success          INTEGER DEFAULT 0,
            status_code      INTEGER,
            error_message    TEXT,
            response_headers TEXT,
            heartbeat_type   TEXT,
            created_at       TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now', 'localtime'))
          )
        `, (err) => { if (err) console.error('❌ 创建 heartbeat_logs 表失败:', err); });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS source_status_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id      INTEGER,
            task_id     INTEGER,
            plan_id     TEXT,
            doctor_code TEXT,
            doctor_name TEXT,
            dept_name   TEXT,
            date        TEXT,
            time_from   TEXT,
            time_to     TEXT,
            fee         TEXT,
            remain_num  INTEGER,
            event_type  TEXT NOT NULL,
            created_at  TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now', 'localtime'))
          )
        `, (err) => {
          if (err) console.error('❌ 创建 source_status_events 表失败:', err);
          resolve();
        });
      });
    });
  }

  // ─── 创建 task_runs 记录 ─────────────────────────────────────────────────
  _createRun(ctx) {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO task_runs
          (task_id, task_name, account_id, account_snapshot,
           system_config_version_id, task_config_version_id, proxy_snapshot, started_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
      `;
      const params = [
        ctx.taskId ?? null,
        ctx.taskName ?? null,
        ctx.accountId ?? null,
        ctx.accountSnapshot ?? null,
        ctx.systemConfigVersionId ?? null,
        ctx.taskConfigVersionId ?? null,
        ctx.proxySnapshot ?? null,
        this.getBeijingTimeWithMillis(),
      ];
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  // ─── 更新 task_runs 记录（停止/报错时调用）──────────────────────────────
  updateRun(runId, { status, endedAt, stopReason } = {}) {
    if (this.disabled || !this.db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sql = `
        UPDATE task_runs
        SET status = ?, ended_at = ?, stop_reason = ?
        WHERE id = ?
      `;
      this.db.run(sql, [status ?? 'stopped', endedAt ?? this.getBeijingTimeWithMillis(), stopReason ?? null, runId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ─── 时间格式化工具 ──────────────────────────────────────────────────────
  getBeijingTimeWithMillis(timestamp = Date.now()) {
    const d = new Date(timestamp);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  // ─── 写入通道日志 ────────────────────────────────────────────────────────
  async saveChannelLog(log) {
    if (this.disabled || !this.db) return null;
    return new Promise((resolve, reject) => {
      const obj = log.toDatabaseObject();
      if (!obj) { resolve(null); return; }

      const start    = this.getBeijingTimeWithMillis(obj.startTime);
      const end      = obj.endTime ? this.getBeijingTimeWithMillis(obj.endTime) : null;
      const duration = obj.endTime && obj.startTime ? obj.endTime - obj.startTime : 0;

      const sql = `
        INSERT INTO channel_logs
          (run_id, task_id, channel_id, proxy_ip, proxy_port, real_proxy_ip, proxy_index,
           target_host, target_port, channel_type, connection_start_time, connection_end_time,
           connection_duration, connection_status, retry_count, max_retries, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      this.db.run(sql, [
        this.runId, this.taskId,
        obj.channelId, obj.proxyIp, obj.proxyPort, obj.realProxyIp, obj.proxyIndex,
        obj.targetHost, obj.targetPort, obj.channelType,
        start, end, duration, obj.status, obj.retryCount, obj.maxRetries, obj.error,
      ], function (err) {
        if (err) { console.error('❌ 保存通道日志失败:', err); reject(err); }
        else resolve(this.lastID);
      });
    });
  }

  // ─── 写入查票日志 ────────────────────────────────────────────────────────
  async saveRequestLog(log) {
    if (this.disabled || !this.db) return null;
    return new Promise((resolve, reject) => {
      const duration = log.endTime && log.startTime ? log.endTime - log.startTime : 0;
      const sql = `
        INSERT INTO check_logs
          (run_id, task_id, account_id, mobile, proxy_ip, proxy_port, channel_id, request_index,
           start_time, end_time, duration, status_code, request_data, request_headers,
           response_data, response_headers, error_message, submit_sign)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      this.db.run(sql, [
        this.runId, this.taskId,
        log.accountId, log.mobile,
        log.proxyInfo?.realProxyIp || log.proxyInfo?.host, log.proxyInfo?.port,
        log.channelId, log.requestIndex,
        this.getBeijingTimeWithMillis(log.startTime),
        log.endTime ? this.getBeijingTimeWithMillis(log.endTime) : null,
        duration, log.statusCode,
        JSON.stringify(log.requestData),
        log.requestHeaders ? JSON.stringify(log.requestHeaders) : null,
        log.responseData ? JSON.stringify(log.responseData) : null,
        log.responseHeaders ? JSON.stringify(log.responseHeaders) : null,
        log.error, log.submitSign,
      ], function (err) {
        if (err) { console.error('❌ 保存查票日志失败:', err); reject(err); }
        else resolve(this.lastID);
      });
    });
  }

  // ─── 写入锁号日志 ────────────────────────────────────────────────────────
  async saveLockRequestLog(log) {
    if (this.disabled || !this.db) return null;
    return new Promise((resolve, reject) => {
      const duration = log.endTime && log.startTime ? log.endTime - log.startTime : 0;
      const sql = `
        INSERT INTO lock_logs
          (run_id, task_id, account_id, mobile, proxy_ip, proxy_port, channel_id, request_index,
           start_time, end_time, duration, status_code, request_data, request_headers, request_body,
           response_data, response_headers, error_message, lock_success, plan_id, patient_id,
           lock_details, submit_sign, submit_sign_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      this.db.run(sql, [
        this.runId, this.taskId,
        log.accountId, log.mobile,
        log.proxyInfo?.realProxyIp || log.proxyInfo?.host, log.proxyInfo?.port,
        log.channelId, log.requestIndex,
        this.getBeijingTimeWithMillis(log.startTime),
        log.endTime ? this.getBeijingTimeWithMillis(log.endTime) : null,
        duration, log.statusCode,
        JSON.stringify(log.requestData),
        log.requestHeaders ? JSON.stringify(log.requestHeaders) : null,
        log.requestBody ? JSON.stringify(log.requestBody) : null,
        log.responseData ? JSON.stringify(log.responseData) : null,
        log.responseHeaders ? JSON.stringify(log.responseHeaders) : null,
        log.error, log.lockSuccess ? 1 : 0,
        log.planId, log.patientId,
        log.lockDetails ? JSON.stringify(log.lockDetails) : null,
        log.submitSign, log.submitSignSource,
      ], function (err) {
        if (err) { console.error('❌ 保存锁号日志失败:', err); reject(err); }
        else resolve(this.lastID);
      });
    });
  }

  // ─── 写入号源状态事件 ────────────────────────────────────────────────────
  async saveSourceStatusEvent({ planId, doctorCode, doctorName, deptName, date, timeFrom, timeTo, fee, remainNum, eventType }) {
    if (this.disabled || !this.db) return null;
    return new Promise((resolve) => {
      const sql = `
        INSERT INTO source_status_events
          (run_id, task_id, plan_id, doctor_code, doctor_name, dept_name,
           date, time_from, time_to, fee, remain_num, event_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      this.db.run(sql, [
        this.runId, this.taskId,
        planId ?? null, doctorCode ?? null, doctorName ?? null, deptName ?? null,
        date ?? null, timeFrom ?? null, timeTo ?? null, fee ?? null,
        remainNum ?? null, eventType,
      ], function (err) {
        if (err) console.error('❌ 保存号源状态事件失败:', err);
        resolve(err ? null : this.lastID);
      });
    });
  }

  // ─── 写入心跳日志 ────────────────────────────────────────────────────────
  async saveHeartbeatLog(log) {
    if (this.disabled || !this.db) return null;
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO heartbeat_logs
          (run_id, task_id, channel_id, proxy_ip, proxy_port, target_host, target_port,
           start_time, end_time, duration, success, status_code, error_message,
           response_headers, heartbeat_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      this.db.run(sql, [
        this.runId, this.taskId,
        log.channelId, log.proxyIp, log.proxyPort, log.targetHost, log.targetPort,
        this.getBeijingTimeWithMillis(log.startTime),
        log.endTime ? this.getBeijingTimeWithMillis(log.endTime) : null,
        log.duration || 0, log.success ? 1 : 0, log.statusCode,
        log.errorMessage, log.responseHeaders || null, log.heartbeatType || null,
      ], function (err) {
        if (err) { console.error('❌ 保存心跳日志失败:', err); reject(err); }
        else resolve(this.lastID);
      });
    });
  }

  // ─── 查询方法（供内部/调试使用）─────────────────────────────────────────
  async getRecentLogs(limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM check_logs WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`,
        [this.runId, limit], (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  async getRecentLockLogs(limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM lock_logs WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`,
        [this.runId, limit], (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  async getLogsByChannel(channelId, limit = 20) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM check_logs WHERE run_id = ? AND channel_id = ? ORDER BY request_index ASC LIMIT ?`,
        [this.runId, channelId, limit], (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  async getChannelLogs(limit = 100) {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM channel_logs WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`,
        [this.runId, limit], (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  async getLogsByAccount(accountId, limit = 20) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM check_logs WHERE run_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT ?`,
        [this.runId, accountId, limit], (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  // ─── 当前 session 某代理的心跳聚合统计 ──────────────────────────────────
  queryHeartbeatStatsByProxy(proxyIp) {
    if (this.disabled || !this.db) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (!this.runId) { resolve(null); return; }
      const sql = `
        SELECT
          COUNT(*) AS attempts,
          SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS success_count,
          MAX(CASE WHEN success=1 THEN end_time ELSE NULL END) AS last_success_time,
          AVG(CASE WHEN success=1 THEN duration ELSE NULL END) AS avg_duration
        FROM heartbeat_logs
        WHERE run_id = ? AND proxy_ip = ?
      `;
      this.db.get(sql, [this.runId, proxyIp], (err, row) => {
        if (err || !row) { resolve(null); return; }
        const attempts = row.attempts || 0;
        const success  = row.success_count || 0;
        resolve({
          attempts,
          success,
          successRate:     attempts > 0 ? success / attempts : 0,
          lastSuccessTime: row.last_success_time || null,
          avgDurationMs:   row.avg_duration ? Math.round(row.avg_duration) : null,
        });
      });
    });
  }

  // ─── 关闭连接 ────────────────────────────────────────────────────────────
  close() {
    return new Promise((resolve) => {
      if (this.db) {
        this.db.serialize(() => {
          this.db.close((err) => {
            if (err) console.error('⚠️ 关闭日志数据库时出错:', err.message);
            this.db = null;
            resolve();
          });
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = LogDatabase;
