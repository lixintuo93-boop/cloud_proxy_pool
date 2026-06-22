'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const CREATE_TABLES = require('./schema');
const C = require('../../account/constants');

const DB_PATH = path.join(__dirname, '../../data/config.db');

let _db = null;

function runMigrations(db) {
  const accountCols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);

  // accounts 表旧结构（有 task_id）→ 重建为顶级实体
  if (accountCols.includes('task_id')) {
    console.log('📦 迁移: 重建 accounts 表为顶级实体...');
    db.exec(`
      DROP TABLE IF EXISTS accounts;
      CREATE TABLE accounts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        enabled          INTEGER NOT NULL DEFAULT 0,
        mobile           TEXT    NOT NULL,
        account_type     TEXT    NOT NULL DEFAULT 'wechat',
        account_platform TEXT    NOT NULL DEFAULT 'android',
        created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(mobile)
      );
    `);
  }

  // accounts 表去掉 patient_id（患者ID移到任务层）
  if (accountCols.includes('patient_id')) {
    console.log('📦 迁移: accounts 表删除 patient_id 列...');
    try {
      db.prepare("ALTER TABLE accounts DROP COLUMN patient_id").run();
    } catch (e) {
      console.warn('  DROP COLUMN patient_id 失败（SQLite版本可能不支持），跳过:', e.message);
    }
  }

  // tasks 表新增字段（历史迁移，仍保留以兼容老库）
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (taskCols.length > 0) {
    if (!taskCols.includes('account_id')) {
      console.log('📦 迁移: tasks 表添加 account_id 列...');
      db.prepare("ALTER TABLE tasks ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL").run();
    }
    if (!taskCols.includes('doctor_code')) {
      db.prepare("ALTER TABLE tasks ADD COLUMN doctor_code TEXT").run();
    }
    if (!taskCols.includes('lock_plan_date')) {
      db.prepare("ALTER TABLE tasks ADD COLUMN lock_plan_date TEXT").run();
    }
    if (!taskCols.includes('patient_id')) {
      db.prepare("ALTER TABLE tasks ADD COLUMN patient_id TEXT").run();
    }
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id)");

  const accountColsNow = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  if (!accountColsNow.includes('proxy_max_count')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN proxy_max_count INTEGER NOT NULL DEFAULT 10").run();
  }

  const accountColsNow2 = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  if (!accountColsNow2.includes('ext_db_path')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN ext_db_path TEXT").run();
    const sysConfigCols = db.prepare("PRAGMA table_info(system_config)").all().map(c => c.name);
    if (sysConfigCols.includes('wechat_db_path')) {
      const sys = db.prepare('SELECT wechat_db_path, app_db_path FROM system_config WHERE id = 1').get();
      if (sys?.wechat_db_path) {
        db.prepare("UPDATE accounts SET ext_db_path = ? WHERE account_type = 'wechat' AND ext_db_path IS NULL")
          .run(sys.wechat_db_path);
      }
      if (sys?.app_db_path) {
        db.prepare("UPDATE accounts SET ext_db_path = ? WHERE account_type = 'app' AND ext_db_path IS NULL")
          .run(sys.app_db_path);
      }
    }
  }

  const accountColsLatest = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  if (!accountColsLatest.includes('open_id')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN open_id TEXT").run();
  }
  if (!accountColsLatest.includes('password')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN password TEXT").run();
  }
  if (!accountColsLatest.includes('status')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'").run();
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_account_patients_account_id      ON account_patients(account_id);
    CREATE INDEX IF NOT EXISTS idx_account_source_records_account_id ON account_source_records(account_id);
    CREATE INDEX IF NOT EXISTS idx_account_messages_account_id       ON account_messages(account_id);
  `);

  const proxyCols = db.prepare("PRAGMA table_info(proxies)").all().map(c => c.name);
  if (!proxyCols.includes('account_id')) {
    db.prepare("ALTER TABLE proxies ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL").run();
    db.exec("CREATE INDEX IF NOT EXISTS idx_proxies_account_id ON proxies(account_id)");
  }

  const proxyPoolCols = [
    ['username',      'TEXT'],
    ['password',      'TEXT'],
    ['real_ip',       'TEXT'],
    ['expire_time',   'TEXT'],
    ['is_working',    'INTEGER DEFAULT 1'],
    ['response_time', 'REAL'],
    ['last_tested_at','TEXT'],
    ['ip_risk_level', 'TEXT'],
    ['ip_location',   'TEXT'],
    ['ip_isp',        'TEXT'],
    ['ip_scene',      'TEXT'],
  ];
  const proxyCols2 = db.prepare("PRAGMA table_info(proxies)").all().map(c => c.name);
  for (const [col, type] of proxyPoolCols) {
    if (!proxyCols2.includes(col)) {
      db.prepare(`ALTER TABLE proxies ADD COLUMN ${col} ${type}`).run();
    }
  }

  const hostsToFix = db.prepare(
    "SELECT id, extra_info FROM proxies WHERE host IS NULL AND extra_info IS NOT NULL AND extra_info != '{}'"
  ).all();
  if (hostsToFix.length > 0) {
    const fixHost = db.prepare('UPDATE proxies SET host = ? WHERE id = ?');
    db.transaction(() => {
      for (const p of hostsToFix) {
        try {
          const ei = JSON.parse(p.extra_info || '{}');
          if (ei.ip) fixHost.run(ei.ip, p.id);
        } catch (_) {}
      }
    })();
  }

  const proxColsTH = db.prepare("PRAGMA table_info(proxies)").all().map(c => c.name);
  if (!proxColsTH.includes('target_hosts')) {
    db.prepare("ALTER TABLE proxies ADD COLUMN target_hosts TEXT DEFAULT NULL").run();
  }

  const ptCols = db.prepare("PRAGMA table_info(proxy_templates)").all().map(c => c.name);
  if (ptCols.length > 0 && !ptCols.includes('target_hosts')) {
    db.prepare("ALTER TABLE proxy_templates ADD COLUMN target_hosts TEXT DEFAULT NULL").run();
  }

  // system_config: 客户端配置等列
  const sysCols = db.prepare("PRAGMA table_info(system_config)").all().map(c => c.name);
  if (!sysCols.includes('default_proxy_max_count')) {
    db.prepare("ALTER TABLE system_config ADD COLUMN default_proxy_max_count INTEGER NOT NULL DEFAULT 10").run();
  }
  if (!sysCols.includes('app_client_config')) {
    db.prepare("ALTER TABLE system_config ADD COLUMN app_client_config TEXT NOT NULL DEFAULT '{}'").run();
  }
  if (!sysCols.includes('android_client_config')) {
    db.prepare("ALTER TABLE system_config ADD COLUMN android_client_config TEXT NOT NULL DEFAULT '{}'").run();
  }
  if (!sysCols.includes('wechat_client_config')) {
    db.prepare("ALTER TABLE system_config ADD COLUMN wechat_client_config TEXT NOT NULL DEFAULT '{}'").run();
  }
  if (!sysCols.includes('cloud_unreachable_action')) {
    db.prepare("ALTER TABLE system_config ADD COLUMN cloud_unreachable_action TEXT NOT NULL DEFAULT 'fallback'").run();
  }
  if (!sysCols.includes('cloud_dispatch_via_proxy')) {
    db.prepare("ALTER TABLE system_config ADD COLUMN cloud_dispatch_via_proxy INTEGER NOT NULL DEFAULT 1").run();
  }
  // UA 池字段（按端独立的 JSON 数组）
  for (const col of ['app_ua_pool', 'android_ua_pool', 'wechat_ua_pool']) {
    if (!sysCols.includes(col)) {
      db.prepare(`ALTER TABLE system_config ADD COLUMN ${col} TEXT NOT NULL DEFAULT '[]'`).run();
    }
  }

  // account_devices: client_version 列（按账号 snapshot 的客户端版本基线）
  const devCols = db.prepare("PRAGMA table_info(account_devices)").all().map(c => c.name);
  if (!devCols.includes('client_version')) {
    db.prepare("ALTER TABLE account_devices ADD COLUMN client_version TEXT").run();
  }

  // ===== 心跳/keepAlive 配置下沉：system_config → proxy_templates / proxies =====
  // 心跳已改为代理级（兜底链：代理覆盖列 → 模板列 → 代码默认），系统层不再持有。
  // 1) proxy_templates 加 7 列（NOT NULL 默认 = 兜底地板）
  const tmplHbCols = db.prepare("PRAGMA table_info(proxy_templates)").all().map(c => c.name);
  const TMPL_HB_ADDS = [
    ['keepalive_enabled',            "INTEGER NOT NULL DEFAULT 1"],
    ['keepalive_interval_min',       "INTEGER NOT NULL DEFAULT 40000"],
    ['keepalive_interval_max',       "INTEGER NOT NULL DEFAULT 70000"],
    ['keepalive_request_type',       "TEXT NOT NULL DEFAULT 'head'"],
    ['keepalive_business_endpoints', "TEXT NOT NULL DEFAULT '[]'"],
    ['direct_keepalive_enabled',     "INTEGER NOT NULL DEFAULT 0"],
    ['heartbeat_timeout',            "INTEGER NOT NULL DEFAULT 300000"],
  ];
  for (const [col, def] of TMPL_HB_ADDS) {
    if (!tmplHbCols.includes(col)) db.prepare(`ALTER TABLE proxy_templates ADD COLUMN ${col} ${def}`).run();
  }
  // 2) proxies 加 7 列（可空 = 跟随模板）
  const proxyHbCols = db.prepare("PRAGMA table_info(proxies)").all().map(c => c.name);
  for (const [col] of TMPL_HB_ADDS) {
    const type = col === 'keepalive_request_type' || col === 'keepalive_business_endpoints' ? 'TEXT' : 'INTEGER';
    if (!proxyHbCols.includes(col)) db.prepare(`ALTER TABLE proxies ADD COLUMN ${col} ${type}`).run();
  }
  // 3) 一次性：把现存 system_config 心跳值迁移到「默认配置」模板（保留升级前行为），再 DROP 系统层列
  const sysHbCols = db.prepare("PRAGMA table_info(system_config)").all().map(c => c.name);
  if (sysHbCols.includes('keepalive_enabled')) {
    const sys = db.prepare('SELECT * FROM system_config WHERE id = 1').get() || {};
    const min = sysHbCols.includes('keepalive_interval_min') && sys.keepalive_interval_min != null
      ? sys.keepalive_interval_min : (sys.keepalive_interval ?? 40000);
    const max = sysHbCols.includes('keepalive_interval_max') && sys.keepalive_interval_max != null
      ? sys.keepalive_interval_max : (sys.keepalive_interval ?? 70000);
    const tmpl = db.prepare("SELECT id FROM proxy_templates WHERE name = '默认配置'").get();
    if (tmpl) {
      db.prepare(`UPDATE proxy_templates SET
        keepalive_enabled = ?, keepalive_interval_min = ?, keepalive_interval_max = ?,
        keepalive_request_type = ?, keepalive_business_endpoints = ?,
        direct_keepalive_enabled = ?, heartbeat_timeout = ?
        WHERE name = '默认配置'`).run(
        sys.keepalive_enabled ?? 1, min, max,
        sys.keepalive_request_type ?? 'head',
        sysHbCols.includes('keepalive_business_endpoints') ? (sys.keepalive_business_endpoints ?? '[]') : '[]',
        sys.direct_keepalive_enabled ?? 0,
        sys.heartbeat_timeout ?? 300000,
      );
    }
    for (const col of ['heartbeat_timeout', 'keepalive_enabled', 'keepalive_interval', 'keepalive_interval_min',
                       'keepalive_interval_max', 'keepalive_business_endpoints', 'keepalive_request_type',
                       'direct_keepalive_enabled']) {
      if (sysHbCols.includes(col)) {
        try { db.prepare(`ALTER TABLE system_config DROP COLUMN ${col}`).run(); }
        catch (e) { console.warn(`  system_config DROP COLUMN ${col} 失败，跳过:`, e.message); }
      }
    }
  }
  // 4) system_config_versions 同步 DROP 心跳列
  const sysVerHbCols = db.prepare("PRAGMA table_info(system_config_versions)").all().map(c => c.name);
  for (const col of ['heartbeat_timeout', 'keepalive_enabled', 'keepalive_interval',
                     'keepalive_request_type', 'direct_keepalive_enabled']) {
    if (sysVerHbCols.includes(col)) {
      try { db.prepare(`ALTER TABLE system_config_versions DROP COLUMN ${col}`).run(); }
      catch (e) { console.warn(`  system_config_versions DROP COLUMN ${col} 失败，跳过:`, e.message); }
    }
  }

  const proxyCols4 = db.prepare("PRAGMA table_info(proxies)").all().map(c => c.name);
  if (!proxyCols4.includes('ops_enabled')) {
    db.prepare("ALTER TABLE proxies ADD COLUMN ops_enabled INTEGER NOT NULL DEFAULT 0").run();
  }

  const acctCols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  if (!acctCols.includes('ops_proxy_id')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN ops_proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL").run();
  }

  const arlCols = db.prepare("PRAGMA table_info(account_request_logs)").all().map(c => c.name);
  if (!arlCols.includes('request_headers')) {
    db.prepare('ALTER TABLE account_request_logs ADD COLUMN request_headers TEXT').run();
  }
  if (!arlCols.includes('response_headers')) {
    db.prepare('ALTER TABLE account_request_logs ADD COLUMN response_headers TEXT').run();
  }

  const accountColsRisk = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  if (!accountColsRisk.includes('is_risk_flagged')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN is_risk_flagged INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!accountColsRisk.includes('is_banned')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0").run();
  }

  const accountColsRemark = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  if (!accountColsRemark.includes('remark')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN remark TEXT").run();
  }

  const riskTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='risk_flagged_ips'").get();
  if (!riskTableExists) {
    db.exec("CREATE TABLE risk_flagged_ips (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL UNIQUE)");
  }

  // (system_config_versions 心跳列已在上方下沉迁移中 DROP)

  const proxyCols3 = db.prepare("PRAGMA table_info(proxies)").all().map(c => c.name);
  if (!proxyCols3.includes('cloud_agent_url')) {
    db.prepare("ALTER TABLE proxies ADD COLUMN cloud_agent_url TEXT DEFAULT NULL").run();
  }

  const needMigrate = db.prepare(
    "SELECT id, extra_info FROM proxies WHERE username IS NULL AND extra_info IS NOT NULL AND extra_info != '{}'"
  ).all();
  if (needMigrate.length > 0) {
    const stmt = db.prepare('UPDATE proxies SET username=?, password=?, real_ip=? WHERE id=?');
    db.transaction(() => {
      for (const p of needMigrate) {
        try {
          const ei = JSON.parse(p.extra_info || '{}');
          if (ei.username || ei.password || ei.real_ip) {
            stmt.run(ei.username || null, ei.password || null, ei.real_ip || null, p.id);
          }
        } catch (_) {}
      }
    })();
  }

  // ====== 配置下沉迁移：任务级配置 → 代理级配置 ======
  // 任务保留 3 字段（doctor_code / lock_plan_date / patient_id）
  // 其他配置全部下沉到 proxies / proxy_templates
  migrateTaskConfigToProxy(db);

  // ====== task_proxies 快照表迁移：把现存任务的代理切片落到 task_proxies ======
  migrateSnapshotTaskProxies(db);
}

// 一次性迁移：为现存任务用旧的 sliceProxiesForTask 逻辑生成快照
function migrateSnapshotTaskProxies(db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='task_proxies'"
  ).get();
  if (!exists) return;

  // 已有快照说明迁移过；跳过
  const have = db.prepare('SELECT COUNT(*) AS n FROM task_proxies').get().n;
  if (have > 0) return;

  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE account_id IS NOT NULL ORDER BY id ASC"
  ).all();
  if (tasks.length === 0) return;

  console.log('📦 迁移: 为现存任务生成 task_proxies 快照...');

  // 按账号分组，复刻 sliceProxiesForTask 的切片逻辑
  const insert = db.prepare('INSERT OR IGNORE INTO task_proxies (task_id, proxy_id) VALUES (?, ?)');
  const byAccount = new Map();
  for (const t of tasks) {
    if (!byAccount.has(t.account_id)) byAccount.set(t.account_id, []);
    byAccount.get(t.account_id).push(t);
  }

  db.transaction(() => {
    for (const [accountId, accountTasks] of byAccount.entries()) {
      const allProxies = db.prepare(
        'SELECT id FROM proxies WHERE account_id = ? AND enabled = 1 ORDER BY id ASC'
      ).all(accountId);
      if (allProxies.length === 0) continue;

      const enabledTaskIds = accountTasks.filter(t => t.enabled === 1).map(t => t.id);
      const m = enabledTaskIds.length;
      const n = allProxies.length;

      for (const t of accountTasks) {
        let slice;
        if (t.enabled !== 1 || m <= 1 || n < m) {
          slice = allProxies; // 单任务 / 禁用任务（也写一份保留语义）
        } else {
          const idx = enabledTaskIds.indexOf(t.id);
          const base = Math.floor(n / m);
          const rem = n % m;
          const start = idx < rem ? idx * (base + 1) : rem * (base + 1) + (idx - rem) * base;
          const size  = idx < rem ? base + 1 : base;
          slice = allProxies.slice(start, start + size);
        }
        for (const p of slice) {
          insert.run(t.id, p.id);
        }
      }
    }
  })();

  console.log('✅ task_proxies 快照迁移完成');
}

// 一次性迁移：把任务级配置下沉到代理级
function migrateTaskConfigToProxy(db) {
  const ptCols = db.prepare("PRAGMA table_info(proxy_templates)").all().map(c => c.name);
  if (ptCols.includes('check_start_time')) return; // 已迁移

  console.log('📦 迁移: 配置下沉（任务级 → 代理级）...');

  const proxyTmplNewCols = [
    ['check_mode',                   "TEXT NOT NULL DEFAULT 'doctor'"],
    ['check_start_time',             'TEXT'],
    ['check_window_time',            'INTEGER'],
    ['check_min_interval',           'INTEGER'],
    ['check_distribution',           "TEXT NOT NULL DEFAULT 'uniform'"],
    ['check_stop_after_found_count', 'INTEGER NOT NULL DEFAULT 3'],
    ['check_reuse_channel',          "TEXT NOT NULL DEFAULT '{}'"],
    ['lock_config',                  "TEXT NOT NULL DEFAULT '{}'"],
    ['doctor_source',                "TEXT NOT NULL DEFAULT 'config'"],
    ['doctor_select_mode',           "TEXT NOT NULL DEFAULT 'random'"],
    ['doctor_codes',                 "TEXT NOT NULL DEFAULT '[]'"],
    ['doctor_plan_date_start',       'TEXT'],
    ['dept_code',                    'TEXT'],
    ['dept_plan_date_start',         'TEXT'],
    ['dept_plan_date_end',           'TEXT'],
  ];
  for (const [col, def] of proxyTmplNewCols) {
    if (!ptCols.includes(col)) {
      db.prepare(`ALTER TABLE proxy_templates ADD COLUMN ${col} ${def}`).run();
    }
  }

  // proxies 表加同名覆盖列（全部 nullable，null = 跟随模板）
  const proxyColsNow = db.prepare("PRAGMA table_info(proxies)").all().map(c => c.name);
  const proxyOverrideCols = [
    'check_mode', 'check_start_time', 'check_window_time', 'check_min_interval',
    'check_distribution', 'check_stop_after_found_count', 'check_reuse_channel',
    'lock_config', 'doctor_source', 'doctor_select_mode', 'doctor_codes',
    'doctor_plan_date_start', 'dept_code', 'dept_plan_date_start', 'dept_plan_date_end',
  ];
  const intCols = new Set(['check_window_time', 'check_min_interval', 'check_stop_after_found_count']);
  for (const col of proxyOverrideCols) {
    if (!proxyColsNow.includes(col)) {
      const type = intCols.has(col) ? 'INTEGER' : 'TEXT';
      db.prepare(`ALTER TABLE proxies ADD COLUMN ${col} ${type}`).run();
    }
  }

  // 1) task_templates 内容迁到 proxy_templates（命名加后缀避免冲突）
  const ttExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_templates'").get();
  if (ttExists) {
    const taskTmpls = db.prepare("SELECT * FROM task_templates").all();
    const insertPT = db.prepare(`
      INSERT OR IGNORE INTO proxy_templates
        (name, description, check_mode, check_start_time, check_window_time, check_min_interval,
         check_distribution, check_stop_after_found_count, check_reuse_channel,
         lock_config, channel_build_overrides,
         doctor_source, doctor_select_mode, doctor_codes, doctor_plan_date_start,
         dept_code, dept_plan_date_start, dept_plan_date_end, target_hosts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const tt of taskTmpls) {
      const ptName = tt.name === '默认配置'
        ? '默认配置'
        : `${tt.name} (任务模板迁移)`;
      // 默认配置已有同名 proxy_template 的话用 INSERT OR IGNORE 跳过；下面再合并
      insertPT.run(
        ptName, tt.description ?? null,
        tt.check_mode ?? 'doctor',
        tt.check_start_time ?? null,
        tt.check_window_time ?? null,
        tt.check_min_interval ?? null,
        tt.check_distribution ?? 'uniform',
        tt.check_stop_after_found_count ?? 3,
        tt.check_reuse_channel ?? '{}',
        tt.lock_config ?? '{}',
        tt.channel_build_config ?? '{}',
        tt.doctor_source ?? 'config',
        tt.doctor_select_mode ?? 'random',
        tt.doctor_codes ?? '[]',
        tt.doctor_plan_date_start ?? null,
        tt.dept_code ?? null,
        tt.dept_plan_date_start ?? null,
        tt.dept_plan_date_end ?? null,
        tt.target_hosts ?? null
      );

      // 若同名（"默认配置"）已存在，更新对应字段
      if (tt.name === '默认配置') {
        db.prepare(`UPDATE proxy_templates SET
          check_mode = ?, check_start_time = ?, check_window_time = ?, check_min_interval = ?,
          check_distribution = ?, check_stop_after_found_count = ?, check_reuse_channel = ?,
          lock_config = ?, channel_build_overrides = ?,
          doctor_source = ?, doctor_select_mode = ?, doctor_codes = ?,
          doctor_plan_date_start = ?, dept_code = ?, dept_plan_date_start = ?, dept_plan_date_end = ?,
          target_hosts = COALESCE(?, target_hosts),
          updated_at = datetime('now')
          WHERE name = '默认配置'`).run(
          tt.check_mode ?? 'doctor',
          tt.check_start_time ?? null,
          tt.check_window_time ?? null,
          tt.check_min_interval ?? null,
          tt.check_distribution ?? 'uniform',
          tt.check_stop_after_found_count ?? 3,
          tt.check_reuse_channel ?? '{}',
          tt.lock_config ?? '{}',
          tt.channel_build_config ?? '{}',
          tt.doctor_source ?? 'config',
          tt.doctor_select_mode ?? 'random',
          tt.doctor_codes ?? '[]',
          tt.doctor_plan_date_start ?? null,
          tt.dept_code ?? null,
          tt.dept_plan_date_start ?? null,
          tt.dept_plan_date_end ?? null,
          tt.target_hosts ?? null
        );
      }
    }
  }

  // 2) 把每个任务的配置写到该任务下所有代理的覆盖列
  const tCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (tCols.includes('check_start_time')) {
    const tasks = db.prepare("SELECT * FROM tasks").all();
    const updateProxy = db.prepare(`UPDATE proxies SET
      check_mode = COALESCE(check_mode, ?),
      check_start_time = COALESCE(check_start_time, ?),
      check_window_time = COALESCE(check_window_time, ?),
      check_min_interval = COALESCE(check_min_interval, ?),
      check_distribution = COALESCE(check_distribution, ?),
      check_stop_after_found_count = COALESCE(check_stop_after_found_count, ?),
      check_reuse_channel = COALESCE(check_reuse_channel, ?),
      lock_config = COALESCE(lock_config, ?),
      doctor_source = COALESCE(doctor_source, ?),
      doctor_select_mode = COALESCE(doctor_select_mode, ?),
      doctor_codes = COALESCE(doctor_codes, ?),
      doctor_plan_date_start = COALESCE(doctor_plan_date_start, ?),
      dept_code = COALESCE(dept_code, ?),
      dept_plan_date_start = COALESCE(dept_plan_date_start, ?),
      dept_plan_date_end = COALESCE(dept_plan_date_end, ?),
      target_hosts = COALESCE(target_hosts, ?),
      updated_at = datetime('now')
      WHERE id = ?`);
    for (const t of tasks) {
      if (!t.account_id) continue;
      const proxies = db.prepare(
        'SELECT id FROM proxies WHERE account_id = ?'
      ).all(t.account_id);
      for (const p of proxies) {
        updateProxy.run(
          t.check_mode ?? null,
          t.check_start_time ?? null,
          t.check_window_time ?? null,
          t.check_min_interval ?? null,
          t.check_distribution ?? null,
          t.check_stop_after_found_count ?? null,
          t.check_reuse_channel ?? null,
          t.lock_config ?? null,
          t.doctor_source ?? null,
          t.doctor_select_mode ?? null,
          t.doctor_codes ?? null,
          t.doctor_plan_date_start ?? null,
          t.dept_code ?? null,
          t.dept_plan_date_start ?? null,
          t.dept_plan_date_end ?? null,
          t.target_hosts ?? null,
          p.id
        );
      }
    }
  }

  // 3) 把 task_proxy_overrides 的内容合并到 proxies.channel_build_overrides
  const tpoExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_proxy_overrides'").get();
  if (tpoExists) {
    const overrides = db.prepare("SELECT * FROM task_proxy_overrides").all();
    for (const ov of overrides) {
      const cur = db.prepare("SELECT channel_build_overrides, target_hosts FROM proxies WHERE id = ?").get(ov.proxy_id);
      if (!cur) continue;
      const curCh = JSON.parse(cur.channel_build_overrides || '{}');
      const ovCh = JSON.parse(ov.channel_build_overrides || '{}');
      const merged = { ...curCh, ...ovCh };
      db.prepare("UPDATE proxies SET channel_build_overrides = ? WHERE id = ?")
        .run(JSON.stringify(merged), ov.proxy_id);
      if (ov.target_hosts) {
        db.prepare("UPDATE proxies SET target_hosts = COALESCE(target_hosts, ?) WHERE id = ?")
          .run(ov.target_hosts, ov.proxy_id);
      }
    }
  }

  // 4) tasks 表删除已下沉字段
  const dropTaskCols = [
    'template_id', 'check_mode', 'doctor_source', 'doctor_select_mode',
    'doctor_codes', 'doctor_plan_date_start', 'dept_code', 'dept_plan_date_start',
    'dept_plan_date_end', 'proxy_assignment_mode', 'proxy_max_count', 'proxy_filter',
    'check_start_time', 'check_window_time', 'check_min_interval', 'check_distribution',
    'check_stop_after_found_count', 'check_reuse_channel',
    'lock_config', 'channel_build_config', 'target_hosts',
    'check_continue_after_found',
  ];
  for (const col of dropTaskCols) {
    try { db.prepare(`ALTER TABLE tasks DROP COLUMN ${col}`).run(); } catch (_) {}
  }

  // 5) 删除已废弃表
  db.exec(`
    DROP TABLE IF EXISTS task_templates;
    DROP TABLE IF EXISTS task_proxy_overrides;
    DROP TABLE IF EXISTS task_config_versions;
  `);

  console.log('✅ 配置下沉迁移完成');
}

function seedDefaultProxyTemplate(db) {
  const channelBuildConfig = {
    startTime: '14:55:15.000',
    windowTime: 270000,
    attempts: 200,
    distribution: 'random',
    earlyStop: {
      enabled: true,
      algorithm: 'dynamic',
      fixedThreshold: 5000,
      multiplier: 15,
    },
    autoCloseExcess: {
      enabled: false,
      maxSuccessChannels: 'auto',
      monitorInterval: 0,
    },
  };

  const lockConfig = {
    reservedChannels: 0,
    firstLockDelayMs: 0,
    windowTime: 20000,
    minInterval: 250,
    directRequestOnNoChannel: false,
    submitSignStrategy: 'rotate',
  };

  const reuseChannel = {
    enabled: false,
    minInterval: 10000,
    reuseOnTimeout: false,
    reuseOnError: true,
  };

  db.prepare(`
    INSERT INTO proxy_templates
      (name, description,
       check_mode, check_start_time, check_window_time, check_min_interval,
       check_distribution, check_stop_after_found_count,
       check_reuse_channel, lock_config, channel_build_overrides,
       doctor_source, doctor_select_mode, doctor_codes)
    VALUES
      (@name, @description,
       @check_mode, @check_start_time, @check_window_time, @check_min_interval,
       @check_distribution, @check_stop_after_found_count,
       @check_reuse_channel, @lock_config, @channel_build_overrides,
       @doctor_source, @doctor_select_mode, @doctor_codes)
    ON CONFLICT(name) DO UPDATE SET
      description                  = COALESCE(excluded.description, proxy_templates.description),
      updated_at                   = datetime('now')
  `).run({
    name:                         '默认配置',
    description:                  '系统默认代理配置',
    check_mode:                   'doctor',
    check_start_time:             '14:59:50.000',
    check_window_time:            10000,
    check_min_interval:           250,
    check_distribution:           'random',
    check_stop_after_found_count: 3,
    check_reuse_channel:          JSON.stringify(reuseChannel),
    lock_config:                  JSON.stringify(lockConfig),
    channel_build_overrides:      JSON.stringify(channelBuildConfig),
    doctor_source:                'config',
    doctor_select_mode:           'random',
    doctor_codes:                 '[]',
  });
}

// 客户端身份基线种子：
//   1) system_config.{app,android,wechat}_ua_pool 为空数组时，写入 constants 中的 15 条种子
//   2) system_config.{app,android,wechat}_client_config 为 {} 时，写入最新版本基线 + 固定参数
//   3) account_devices.client_version 为 NULL 时，按账号类型/平台从当前基线回填
function seedClientIdentityDefaults(db) {
  const sys = db.prepare(`
    SELECT app_client_config, android_client_config, wechat_client_config,
           app_ua_pool, android_ua_pool, wechat_ua_pool
    FROM system_config WHERE id = 1
  `).get();
  if (!sys) return;

  const safeParse = (v, def) => { try { const o = JSON.parse(v || ''); return (o && typeof o === 'object') ? o : def; } catch { return def; } };

  // 1) UA 池种子
  const seedPool = (col, seed) => {
    const cur = safeParse(sys[col], []);
    if (Array.isArray(cur) && cur.length === 0) {
      db.prepare(`UPDATE system_config SET ${col} = ? WHERE id = 1`).run(JSON.stringify(seed));
    }
  };
  seedPool('app_ua_pool',     C.APP_UA_POOL);
  seedPool('android_ua_pool', C.ANDROID_UA_POOL);
  seedPool('wechat_ua_pool',  C.WECHAT_UA_POOL);

  // 2) client_config 基线（仅在 {} 时填）。已写入的旧值不动；其中残留的 USER_AGENT 字段
  //    运行期已不再读取，可留可清，此处不主动删除以避免破坏管理员的历史快照。
  const seedCfg = (col, baseline) => {
    const cur = safeParse(sys[col], {});
    if (cur && typeof cur === 'object' && Object.keys(cur).length === 0) {
      db.prepare(`UPDATE system_config SET ${col} = ? WHERE id = 1`).run(JSON.stringify(baseline));
    }
  };
  seedCfg('app_client_config',     C.APP_CONFIG);
  seedCfg('android_client_config', C.ANDROID_CONFIG);
  seedCfg('wechat_client_config',  C.WECHAT_CONFIG);

  // 3) 回填 account_devices.client_version：
  //    现存账号在加 client_version 列前已建账；统一按账号当前基线写一遍
  const sysNow = db.prepare(`
    SELECT app_client_config, android_client_config, wechat_client_config
    FROM system_config WHERE id = 1
  `).get();
  const appCfg     = safeParse(sysNow.app_client_config,     C.APP_CONFIG);
  const androidCfg = safeParse(sysNow.android_client_config, C.ANDROID_CONFIG);
  const wechatCfg  = safeParse(sysNow.wechat_client_config,  C.WECHAT_CONFIG);

  const rows = db.prepare(`
    SELECT d.id, a.account_type, a.account_platform
    FROM account_devices d
    JOIN accounts a ON a.id = d.account_id
    WHERE d.client_version IS NULL OR d.client_version = ''
  `).all();
  if (rows.length > 0) {
    const upd = db.prepare('UPDATE account_devices SET client_version = ? WHERE id = ?');
    db.transaction(() => {
      for (const r of rows) {
        let ver;
        if (r.account_type === 'wechat')          ver = wechatCfg.CLIENT_VERSION;
        else if (r.account_platform === 'android') ver = androidCfg.CLIENT_VERSION;
        else                                       ver = appCfg.CLIENT_VERSION;
        if (ver) upd.run(ver, r.id);
      }
    })();
  }
}

// 若 system_config_versions 为空，将当前系统配置作为初始版本写入
function seedSystemConfigVersion(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM system_config_versions').get().n;
  if (count > 0) return;
  const sys = db.prepare('SELECT * FROM system_config WHERE id = 1').get();
  if (!sys) return;
  db.prepare(`
    INSERT INTO system_config_versions
      (target_hosts, connect_timeout, request_timeout, proxy_classifier)
    VALUES (?, ?, ?, ?)
  `).run(
    sys.target_hosts,
    sys.connect_timeout, sys.request_timeout,
    sys.proxy_classifier,
  );
}

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(CREATE_TABLES);
    runMigrations(_db);
    seedDefaultProxyTemplate(_db);
    seedClientIdentityDefaults(_db);
    seedSystemConfigVersion(_db);
  }
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, closeDb };
