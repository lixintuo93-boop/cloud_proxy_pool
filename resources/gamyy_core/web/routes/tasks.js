'use strict';

const { Router } = require('express');
const { getDb, ok, err, now } = require('./_helper');

const router = Router();

// GET /api/tasks  ?enabled=1  ?account_id=X
router.get('/', (req, res) => {
  try {
    const db = getDb();
    let sql = `SELECT t.*,
      a.mobile AS account_mobile,
      (SELECT CASE
         WHEN tc <= 1 OR pc < tc THEN pc
         WHEN task_rank < (pc % tc) THEN (pc / tc) + 1
         ELSE (pc / tc)
       END
       FROM (SELECT
         (SELECT COUNT(*) FROM proxies p  WHERE p.account_id  = t.account_id AND p.enabled = 1) AS pc,
         (SELECT COUNT(*) FROM tasks   t2 WHERE t2.account_id = t.account_id AND t2.enabled = 1) AS tc,
         (SELECT COUNT(*) FROM tasks   t3 WHERE t3.account_id = t.account_id AND t3.enabled = 1 AND t3.id < t.id) AS task_rank
       )
      ) AS proxy_count
      FROM tasks t
      LEFT JOIN accounts a ON a.id = t.account_id`;
    const params = [];
    const conditions = [];
    if (req.query.enabled !== undefined) {
      conditions.push('t.enabled = ?');
      params.push(req.query.enabled === '1' ? 1 : 0);
    }
    if (req.query.account_id !== undefined) {
      conditions.push('t.account_id = ?');
      params.push(req.query.account_id);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY t.id';
    ok(res, db.prepare(sql).all(...params).map(parseTask));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// POST /api/tasks  仅需 account_id + doctor_code + lock_plan_date + patient_id
//
// 可选：
//   proxy_template_ids       数组，N 个代理模板，按 round-robin 给该任务下的代理逐个应用
//   proxy_template_id        单值兼容：等价于 proxy_template_ids = [single]
//   proxy_template_offset    全局轮询偏移量；按 (offset+i) % len 分配
//
// 行为：
//   1. 建 task 行
//   2. 取该账号下"未在任何 task_proxies 里"的可用代理（enabled=1, account_id=本账号），
//      按 id ASC 写入 task_proxies（快照）
//   3. 按 round-robin 给这些代理 apply 模板（写代理覆盖列）
//
// 返回：
//   ...task,
//   assigned_count           本任务实际写入了多少个代理（前端用于累加 offset）
router.post('/', (req, res) => {
  try {
    const b = req.body;
    const db = getDb();

    if (!b.account_id) return err(res, 'account_id is required', 400);

    // 兼容单值与数组
    let templateIds = Array.isArray(b.proxy_template_ids) ? b.proxy_template_ids.filter(Boolean) : [];
    if (templateIds.length === 0 && b.proxy_template_id) templateIds = [b.proxy_template_id];
    const offset = Number.isInteger(b.proxy_template_offset) ? b.proxy_template_offset : 0;

    const autoName = b.name || `task_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;

    let assignedCount = 0;
    let lastInsertRowid;

    db.transaction(() => {
      const result = db.prepare(`INSERT INTO tasks
        (name, enabled, account_id, doctor_code, lock_plan_date, patient_id)
        VALUES (@name, @enabled, @account_id, @doctor_code, @lock_plan_date, @patient_id)`).run({
        name:           autoName,
        enabled:        b.enabled !== false ? 1 : 0,
        account_id:     b.account_id ?? null,
        doctor_code:    b.doctor_code ?? null,
        lock_plan_date: b.lock_plan_date ?? null,
        patient_id:     b.patient_id ?? null,
      });
      lastInsertRowid = result.lastInsertRowid;

      // 取账号下未被任何任务占用的代理（方案 a：only free proxies）
      const freeProxies = db.prepare(`
        SELECT p.id FROM proxies p
        WHERE p.account_id = ? AND p.enabled = 1
          AND p.id NOT IN (
            SELECT tp.proxy_id FROM task_proxies tp
            JOIN tasks t ON t.id = tp.task_id
            WHERE t.account_id = ?
          )
        ORDER BY p.id ASC
      `).all(b.account_id, b.account_id);

      // 写 task_proxies 快照
      const insertTP = db.prepare('INSERT OR IGNORE INTO task_proxies (task_id, proxy_id) VALUES (?, ?)');
      for (const p of freeProxies) {
        insertTP.run(lastInsertRowid, p.id);
      }
      assignedCount = freeProxies.length;

      // 按 round-robin 给这些代理 apply 模板
      if (templateIds.length > 0 && freeProxies.length > 0) {
        applyTemplatesRoundRobin(db, freeProxies.map(p => p.id), templateIds, offset);
      }
    })();

    const created = parseTask(db.prepare(`
      SELECT t.*, a.mobile AS account_mobile
      FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.id = ?`).get(lastInsertRowid));
    created.assigned_count = assignedCount;
    ok(res, created, 201);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, '任务名称已存在');
    err(res, e.message, 500);
  }
});

// GET /api/tasks/running
router.get('/running', (req, res) => {
  try {
    ok(res, req.taskRunner.getAllStatuses());
  } catch (e) {
    err(res, e.message, 500);
  }
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  try {
    const row = getDb().prepare(`
      SELECT t.*, a.mobile AS account_mobile
      FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.id = ?`).get(req.params.id);
    if (!row) return err(res, '任务不存在', 404);
    ok(res, parseTask(row));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// PUT /api/tasks/:id  只更新 4 个字段：name/enabled/account_id 和 3 个目标字段
router.put('/:id', (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id)) return err(res, '任务不存在', 404);
    db.prepare(`UPDATE tasks SET
      name = COALESCE(@name, name),
      enabled = COALESCE(@enabled, enabled),
      account_id = COALESCE(@account_id, account_id),
      doctor_code = COALESCE(@doctor_code, doctor_code),
      lock_plan_date = COALESCE(@lock_plan_date, lock_plan_date),
      patient_id = COALESCE(@patient_id, patient_id),
      updated_at = @updated_at
      WHERE id = @id`).run({
      id:             req.params.id,
      name:           b.name ?? null,
      enabled:        b.enabled != null ? (b.enabled ? 1 : 0) : null,
      account_id:     b.account_id ?? null,
      doctor_code:    b.doctor_code ?? null,
      lock_plan_date: b.lock_plan_date ?? null,
      patient_id:     b.patient_id ?? null,
      updated_at:     now(),
    });
    ok(res, parseTask(db.prepare(`
      SELECT t.*, a.mobile AS account_mobile
      FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.id = ?`).get(req.params.id)));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, '任务名称已存在');
    err(res, e.message, 500);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id)) return err(res, '任务不存在', 404);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    ok(res, { deleted: true });
  } catch (e) {
    err(res, e.message, 500);
  }
});

// PATCH /api/tasks/:id/enabled
router.patch('/:id/enabled', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id)) return err(res, '任务不存在', 404);
    const enabled = req.body.enabled ? 1 : 0;
    db.prepare('UPDATE tasks SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled, now(), req.params.id);
    ok(res, { enabled: !!enabled });
  } catch (e) {
    err(res, e.message, 500);
  }
});

// 工具：按 round-robin 把多个代理模板应用到一组代理
//   proxyIds: [proxyId, ...]（按一致顺序排列，从 i=0 开始算）
//   templateIds: [tmplId, ...]
//   offset: 全局偏移；第 i 个代理用 templateIds[(offset + i) % len]
// 行为：把模板的所有字段复制到代理的覆盖列（含 template_id 关联）
function applyTemplatesRoundRobin(db, proxyIds, templateIds, offset = 0) {
  if (!proxyIds.length || !templateIds.length) return;

  // 缓存模板，避免重复读
  const tmplCache = new Map();
  for (const tid of templateIds) {
    if (!tmplCache.has(tid)) {
      const t = db.prepare('SELECT * FROM proxy_templates WHERE id = ?').get(tid);
      if (t) tmplCache.set(tid, t);
    }
  }

  const stmt = db.prepare(`UPDATE proxies SET
    template_id = @tid,
    check_mode = @check_mode,
    check_start_time = @check_start_time,
    check_window_time = @check_window_time,
    check_min_interval = @check_min_interval,
    check_distribution = @check_distribution,
    check_stop_after_found_count = @check_stop_after_found_count,
    check_reuse_channel = @check_reuse_channel,
    lock_config = @lock_config,
    channel_build_overrides = @channel_build_overrides,
    doctor_source = @doctor_source,
    doctor_select_mode = @doctor_select_mode,
    doctor_codes = @doctor_codes,
    doctor_plan_date_start = @doctor_plan_date_start,
    dept_code = @dept_code,
    dept_plan_date_start = @dept_plan_date_start,
    dept_plan_date_end = @dept_plan_date_end,
    target_hosts = @target_hosts,
    updated_at = @updated_at
    WHERE id = @id`);

  const updatedAt = now();
  for (let i = 0; i < proxyIds.length; i++) {
    const tid = templateIds[(offset + i) % templateIds.length];
    const tmpl = tmplCache.get(tid);
    if (!tmpl) continue;
    stmt.run({
      id:                           proxyIds[i],
      tid:                          tmpl.id,
      check_mode:                   tmpl.check_mode,
      check_start_time:             tmpl.check_start_time,
      check_window_time:            tmpl.check_window_time,
      check_min_interval:           tmpl.check_min_interval,
      check_distribution:           tmpl.check_distribution,
      check_stop_after_found_count: tmpl.check_stop_after_found_count,
      check_reuse_channel:          tmpl.check_reuse_channel,
      lock_config:                  tmpl.lock_config,
      channel_build_overrides:      tmpl.channel_build_overrides,
      doctor_source:                tmpl.doctor_source,
      doctor_select_mode:           tmpl.doctor_select_mode,
      doctor_codes:                 tmpl.doctor_codes,
      doctor_plan_date_start:       tmpl.doctor_plan_date_start,
      dept_code:                    tmpl.dept_code,
      dept_plan_date_start:         tmpl.dept_plan_date_start,
      dept_plan_date_end:           tmpl.dept_plan_date_end,
      target_hosts:                 tmpl.target_hosts,
      updated_at:                   updatedAt,
    });
  }
}

// 工具：合并系统 → proxy_template → proxy 三层产生该代理的有效配置
// 返回按云端 agent 期望的 shape 组织的对象
function resolveProxyEffectiveConfig(sys, proxy, tmpl) {
  // 标量字段：proxy 列非空非'' 优先；否则 fall back 到 tmpl
  const pick = (col) => {
    const v = proxy[col];
    if (v != null && v !== '') return v;
    if (tmpl && tmpl[col] != null && tmpl[col] !== '') return tmpl[col];
    return null;
  };
  // JSON 对象/数组字段：tmpl 与 proxy 解析后 merge（proxy 覆盖 tmpl 的同名键）
  // 对象类型 → 合并；数组类型 → proxy 非空数组优先，否则用 tmpl
  const safeParse = (raw) => {
    if (raw == null) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return null; }
  };
  const pickJson = (col, fallback) => {
    const tmplVal  = safeParse(tmpl ? tmpl[col] : null);
    const proxyVal = safeParse(proxy[col]);
    const isArrFb  = Array.isArray(fallback);
    if (isArrFb) {
      if (Array.isArray(proxyVal) && proxyVal.length) return proxyVal;
      if (Array.isArray(tmplVal)  && tmplVal.length)  return tmplVal;
      return fallback;
    }
    return { ...(tmplVal || {}), ...(proxyVal || {}) };
  };
  // 心跳标量小工具：整数 / 布尔，跟随 pick 的"代理→模板→默认"优先级
  const pickInt = (col, dflt) => {
    const n = parseInt(pick(col), 10);
    return Number.isFinite(n) ? n : dflt;
  };
  const toBool = (v, dflt) => (v == null ? dflt : !!Number(v));

  const channelBuild     = pickJson('channel_build_overrides', {});
  const lockCfg          = pickJson('lock_config', {});
  const reuseCh          = pickJson('check_reuse_channel', {});
  const doctorCodes      = pickJson('doctor_codes', []);
  const proxyTargetHosts = pickJson('target_hosts', null);
  const kaEndpoints      = pickJson('keepalive_business_endpoints', []);
  const proxyClassifier  = JSON.parse(sys.proxy_classifier || '{}');

  const channelTargetHosts = (proxyTargetHosts?.length) ? proxyTargetHosts : null;

  return {
    checkMode:        pick('check_mode') || 'doctor',
    doctorSource:     pick('doctor_source') || 'config',
    doctorSelectMode: pick('doctor_select_mode') || 'random',
    queryParams: {
      doctorCodes:    doctorCodes,
      planDateStart:  pick('doctor_plan_date_start'),
      hospitalId:     '10097',
    },
    deptQueryParams: {
      deptCode:       pick('dept_code'),
      planDateStart:  pick('dept_plan_date_start'),
      planDateEnd:    pick('dept_plan_date_end'),
      hospitalId:     '10097',
    },
    connectionPool:   { targetHosts: JSON.parse(sys.target_hosts || '[]') },
    timeout: {
      connectTimeout:   sys.connect_timeout,
      requestTimeout:   sys.request_timeout,
      // 心跳超时已下沉到代理/模板（heartbeat_timeout 列）
      heartbeatTimeout: pickInt('heartbeat_timeout', 300000),
    },
    // 心跳/keepAlive 全部 per-proxy：代理覆盖列 → 模板列 → 代码默认
    keepAlive: (() => {
      const kaMin = pickInt('keepalive_interval_min', 40000);
      const kaMax = pickInt('keepalive_interval_max', 70000);
      return {
        enabled:                toBool(pick('keepalive_enabled'), true),
        interval:               Math.floor((kaMin + kaMax) / 2),  // 兼容老云端（只认 interval）
        intervalMin:            kaMin,
        intervalMax:            kaMax,
        request:                { type: pick('keepalive_request_type') || 'head', enabledEndpoints: kaEndpoints },
        directKeepaliveEnabled: toBool(pick('direct_keepalive_enabled'), false),
      };
    })(),
    channelBuildPhase1: { ...channelBuild, targetHosts: channelTargetHosts || undefined },
    checkRequest: {
      startTime:           pick('check_start_time'),
      windowTime:          pick('check_window_time'),
      minInterval:         pick('check_min_interval'),
      distribution:        pick('check_distribution'),
      stopAfterFoundCount: pick('check_stop_after_found_count') ?? 3,
      reuseChannel:        reuseCh,
    },
    lockRequest:            { global: lockCfg },
    proxyClassifier,
    cloudUnreachableAction: sys.cloud_unreachable_action || 'fallback',
  };
}

function parseTask(row) {
  return { ...row };
}

module.exports = router;
module.exports.resolveProxyEffectiveConfig = resolveProxyEffectiveConfig;
module.exports.applyTemplatesRoundRobin = applyTemplatesRoundRobin;
