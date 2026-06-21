'use strict';

const { Router } = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { ok, err, getDb } = require('./_helper');

const router = Router();

const LOG_DB_PATH = path.join(__dirname, '../../data/ticket_checker.db');

function getLogDb() {
  try { return new Database(LOG_DB_PATH, { readonly: true }); }
  catch { return null; }
}

function paginate(req) {
  const page  = Math.max(1, parseInt(req.query.page  || '1'));
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '50')));
  return { page, limit, offset: (page - 1) * limit };
}

function buildWhere(req, extra = []) {
  const params = [];
  const clauses = ['1=1', ...extra];
  if (req.query.runId)    { clauses.push('run_id = ?');              params.push(Number(req.query.runId)); }
  if (req.query.taskId)   { clauses.push('task_id = ?');             params.push(Number(req.query.taskId)); }
  if (req.query.startDate){ clauses.push('created_at >= ?');         params.push(req.query.startDate); }
  if (req.query.endDate)  { clauses.push('created_at <= ?');         params.push(req.query.endDate + ' 23:59:59'); }
  return { where: clauses.join(' AND '), params };
}

// GET /api/logs/ticket-db  — download ticket_checker.db binary for browser-side sql.js
router.get('/ticket-db', (req, res) => {
  if (!fs.existsSync(LOG_DB_PATH)) return res.status(404).json({ error: '数据库文件不存在' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="ticket_checker.db"');
  res.sendFile(path.resolve(LOG_DB_PATH));
});

// GET /api/logs/requests?runId=&taskId=&page=&limit=&startDate=&endDate=
router.get('/requests', (req, res) => {
  try {
    const logDb = getLogDb();
    if (!logDb) return ok(res, { total: 0, rows: [] });
    const { page, limit, offset } = paginate(req);
    const { where, params } = buildWhere(req);
    try {
      const total = logDb.prepare(`SELECT COUNT(*) AS n FROM check_logs WHERE ${where}`).get(...params).n;
      const rows  = logDb.prepare(`SELECT * FROM check_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      logDb.close();
      ok(res, { total, page, limit, rows });
    } catch {
      logDb.close();
      ok(res, { total: 0, rows: [], note: 'table not found' });
    }
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/logs/locks?runId=&taskId=&page=&limit=&startDate=&endDate=
router.get('/locks', (req, res) => {
  try {
    const logDb = getLogDb();
    if (!logDb) return ok(res, { total: 0, rows: [] });
    const { page, limit, offset } = paginate(req);
    const { where, params } = buildWhere(req);
    try {
      const total = logDb.prepare(`SELECT COUNT(*) AS n FROM lock_logs WHERE ${where}`).get(...params).n;
      const rows  = logDb.prepare(`SELECT * FROM lock_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      logDb.close();
      ok(res, { total, page, limit, rows });
    } catch {
      logDb.close();
      ok(res, { total: 0, rows: [], note: 'table not found' });
    }
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/logs/channels?runId=&taskId=&page=&limit=
router.get('/channels', (req, res) => {
  try {
    const logDb = getLogDb();
    if (!logDb) return ok(res, { total: 0, rows: [] });
    const { page, limit, offset } = paginate(req);
    const { where, params } = buildWhere(req);
    try {
      const total = logDb.prepare(`SELECT COUNT(*) AS n FROM channel_logs WHERE ${where}`).get(...params).n;
      const rows  = logDb.prepare(`SELECT * FROM channel_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      logDb.close();
      ok(res, { total, page, limit, rows });
    } catch {
      logDb.close();
      ok(res, { total: 0, rows: [], note: 'table not found' });
    }
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/logs/runs?taskId=&page=&limit=
router.get('/runs', (req, res) => {
  try {
    const logDb = getLogDb();
    if (!logDb) return ok(res, { total: 0, rows: [] });
    const { page, limit, offset } = paginate(req);
    const params = [];
    let where = '1=1';
    if (req.query.taskId) { where += ' AND task_id = ?'; params.push(Number(req.query.taskId)); }
    try {
      const total = logDb.prepare(`SELECT COUNT(*) AS n FROM task_runs WHERE ${where}`).get(...params).n;
      const rows  = logDb.prepare(`SELECT * FROM task_runs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      logDb.close();
      ok(res, { total, page, limit, rows });
    } catch {
      logDb.close();
      ok(res, { total: 0, rows: [], note: 'table not found' });
    }
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/logs/runs/:runId  — 单次运行详情，附带配置版本快照
router.get('/runs/:runId', (req, res) => {
  try {
    const logDb = getLogDb();
    if (!logDb) return err(res, 'log db not available', 503);
    try {
      const run = logDb.prepare('SELECT * FROM task_runs WHERE id = ?').get(Number(req.params.runId));
      if (!run) { logDb.close(); return err(res, '运行记录不存在', 404); }

      // 从 config.db 读取配置版本快照
      let systemConfigVersion = null;
      let taskConfigVersion = null;
      try {
        const configDb = getDb();
        if (run.system_config_version_id) {
          systemConfigVersion = configDb.prepare('SELECT * FROM system_config_versions WHERE id = ?').get(run.system_config_version_id);
        }
        if (run.task_config_version_id) {
          taskConfigVersion = configDb.prepare('SELECT * FROM task_config_versions WHERE id = ?').get(run.task_config_version_id);
        }
      } catch (_) {}

      const stats = {};
      try {
        stats.check = logDb.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status_code=200 THEN 1 ELSE 0 END) AS success FROM check_logs WHERE run_id = ?`).get(run.id);
        stats.lock  = logDb.prepare(`SELECT COUNT(*) AS total, SUM(lock_success) AS success FROM lock_logs WHERE run_id = ?`).get(run.id);
      } catch (_) {}

      logDb.close();
      ok(res, {
        ...run,
        account_snapshot:    run.account_snapshot    ? JSON.parse(run.account_snapshot)    : null,
        proxy_snapshot:      run.proxy_snapshot      ? JSON.parse(run.proxy_snapshot)      : null,
        system_config_version: systemConfigVersion,
        task_config_version:   taskConfigVersion,
        stats,
      });
    } catch (e2) {
      logDb.close();
      err(res, e2.message, 500);
    }
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/logs/source-events?runId=&taskId=&planId=&page=&limit=
router.get('/source-events', (req, res) => {
  try {
    const logDb = getLogDb();
    if (!logDb) return ok(res, { total: 0, rows: [] });
    const { page, limit, offset } = paginate(req);
    const { where, params } = buildWhere(req);
    const finalWhere = req.query.planId
      ? `${where} AND plan_id = ?`
      : where;
    if (req.query.planId) params.push(req.query.planId);
    try {
      const total = logDb.prepare(`SELECT COUNT(*) AS n FROM source_status_events WHERE ${finalWhere}`).get(...params).n;
      const rows  = logDb.prepare(`SELECT * FROM source_status_events WHERE ${finalWhere} ORDER BY id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      logDb.close();
      ok(res, { total, page, limit, rows });
    } catch {
      logDb.close();
      ok(res, { total: 0, rows: [], note: 'table not found' });
    }
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/stats/tasks/:id
router.get('/stats/tasks/:id', (req, res) => {
  try {
    const logDb = getLogDb();
    if (!logDb) return ok(res, {});
    try {
      const taskId = Number(req.params.id);
      const checkStats = logDb.prepare(`
        SELECT COUNT(*) AS total_checks,
          SUM(CASE WHEN status_code = 200 THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN error_message IS NOT NULL AND error_message != '' THEN 1 ELSE 0 END) AS error_count
        FROM check_logs WHERE task_id = ?`).get(taskId);
      const lockStats = logDb.prepare(`
        SELECT COUNT(*) AS total_locks,
          SUM(lock_success) AS success_count
        FROM lock_logs WHERE task_id = ?`).get(taskId);
      logDb.close();
      ok(res, { checkStats, lockStats });
    } catch {
      logDb.close();
      ok(res, {});
    }
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/logs/risk-data  — 返回风控 IP 集合和风控账号手机号集合（供 channel-viewer 使用）
router.get('/risk-data', (_req, res) => {
  try {
    const db = getDb();
    const riskIps     = db.prepare('SELECT ip FROM risk_flagged_ips').all().map(r => r.ip);
    const riskMobiles = db.prepare('SELECT mobile FROM accounts WHERE is_risk_flagged = 1').all().map(r => r.mobile);
    ok(res, { riskIps, riskMobiles });
  } catch (_) {
    ok(res, { riskIps: [], riskMobiles: [] });
  }
});

module.exports = router;
