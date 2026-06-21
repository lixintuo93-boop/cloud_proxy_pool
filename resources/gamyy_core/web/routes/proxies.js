'use strict';

const { Router } = require('express');
const { getDb, ok, err, now } = require('./_helper');
const { isTimeString, validateChannelOverrides, validateTargetHosts, validateKeepaliveInterval, validateHeartbeatEndpoints } = require('./_validate');
const { resolveProxyEffectiveConfig } = require('./tasks');
const { ALL_IDS: HEARTBEAT_ALL_IDS } = require('../../services/HeartbeatEndpointPool');

const router = Router();

// 把这些代理从所有 task_proxies 快照里移除
// 调用时机：代理被 unassign / 重新 assign（account_id 改变）时
function cleanupTaskProxies(db, proxyIds) {
  if (!proxyIds || proxyIds.length === 0) return;
  const placeholders = proxyIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM task_proxies WHERE proxy_id IN (${placeholders})`).run(...proxyIds);
}

function getRunningAccountIds(db, taskRunner) {
  const statuses = taskRunner.getAllStatuses();
  const runningIds = Object.entries(statuses)
    .filter(([, s]) => s.status === 'running' || s.status === 'initializing')
    .map(([id]) => Number(id));
  if (runningIds.length === 0) return new Set();
  const rows = db.prepare(
    `SELECT DISTINCT account_id FROM tasks WHERE id IN (${runningIds.map(() => '?').join(',')}) AND account_id IS NOT NULL`
  ).all(...runningIds);
  return new Set(rows.map(r => r.account_id));
}

function parse(row) {
  return {
    ...row,
    extra_info:               JSON.parse(row.extra_info || '{}'),
    channel_build_overrides:  JSON.parse(row.channel_build_overrides || '{}'),
    target_hosts:             row.target_hosts ? JSON.parse(row.target_hosts) : null,
    check_reuse_channel:      row.check_reuse_channel ? JSON.parse(row.check_reuse_channel) : null,
    lock_config:              row.lock_config ? JSON.parse(row.lock_config) : null,
    doctor_codes:             row.doctor_codes ? JSON.parse(row.doctor_codes) : null,
    keepalive_business_endpoints: row.keepalive_business_endpoints ? JSON.parse(row.keepalive_business_endpoints) : null,
    fingerprint_config:       row.fingerprint_config ? JSON.parse(row.fingerprint_config) : null,
  };
}

// 工具：附带"有效配置"展开（合并 system + template + proxy）
function parseWithEffective(db, row) {
  const sys = db.prepare('SELECT * FROM system_config WHERE id = 1').get();
  // template_id 为空时用"默认配置"代理模板兜底
  let tmpl = null;
  if (row.template_id) {
    tmpl = db.prepare('SELECT * FROM proxy_templates WHERE id = ?').get(row.template_id);
  }
  if (!tmpl) {
    tmpl = db.prepare("SELECT * FROM proxy_templates WHERE name = '默认配置'").get();
  }
  const eff = resolveProxyEffectiveConfig(sys, row, tmpl);
  return {
    ...parse(row),
    effective: {
      check_mode:                   eff.checkMode,
      check_start_time:             eff.checkRequest.startTime,
      check_window_time:            eff.checkRequest.windowTime,
      check_min_interval:           eff.checkRequest.minInterval,
      check_distribution:           eff.checkRequest.distribution,
      check_stop_after_found_count: eff.checkRequest.stopAfterFoundCount,
      check_reuse_channel:          eff.checkRequest.reuseChannel,
      lock_config:                  eff.lockRequest.global,
      channel_build_overrides:      eff.channelBuildPhase1,
      target_hosts:                 eff.channelBuildPhase1?.targetHosts || null,
      doctor_source:                eff.doctorSource,
      doctor_select_mode:           eff.doctorSelectMode,
      doctor_codes:                 eff.queryParams?.doctorCodes,
      doctor_plan_date_start:       eff.queryParams?.planDateStart,
      dept_code:                    eff.deptQueryParams?.deptCode,
      dept_plan_date_start:         eff.deptQueryParams?.planDateStart,
      dept_plan_date_end:           eff.deptQueryParams?.planDateEnd,
      // 心跳/keepAlive 有效值（合并模板/代理后）
      keepalive_enabled:            eff.keepAlive?.enabled,
      keepalive_interval_min:       eff.keepAlive?.intervalMin,
      keepalive_interval_max:       eff.keepAlive?.intervalMax,
      keepalive_request_type:       eff.keepAlive?.request?.type,
      keepalive_business_endpoints: eff.keepAlive?.request?.enabledEndpoints,
      direct_keepalive_enabled:     eff.keepAlive?.directKeepaliveEnabled,
      heartbeat_timeout:            eff.timeout?.heartbeatTimeout,
      fingerprint:                  eff.fingerprint,
    },
  };
}


// GET /api/proxies  ?accountId=&unassigned=true&enabled=1&group=&type=&with_effective=1
router.get('/', (req, res) => {
  try {
    const q = req.query;
    let sql = 'SELECT * FROM proxies WHERE 1=1';
    const params = [];
    if (q.accountId)              { sql += ' AND account_id = ?';    params.push(q.accountId); }
    if (q.unassigned === 'true')  { sql += ' AND account_id IS NULL'; }
    if (q.enabled !== undefined)  { sql += ' AND enabled = ?';       params.push(q.enabled === '1' ? 1 : 0); }
    if (q.ops_enabled !== undefined) { sql += ' AND ops_enabled = ?'; params.push(q.ops_enabled === '1' ? 1 : 0); }
    if (q.group)                  { sql += ' AND group_name = ?';    params.push(q.group); }
    if (q.type)                   { sql += ' AND proxy_type = ?';    params.push(q.type); }
    sql += ' ORDER BY id';
    const db = getDb();
    const rows = db.prepare(sql).all(...params);
    if (q.with_effective === '1') {
      ok(res, rows.map(r => parseWithEffective(db, r)));
    } else {
      ok(res, rows.map(parse));
    }
  } catch (e) { err(res, e.message, 500); }
});

// PATCH /api/proxies/:id/enabled
router.patch('/:id/enabled', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM proxies WHERE id = ?').get(req.params.id)) return err(res, '代理不存在', 404);
    db.prepare('UPDATE proxies SET enabled = ?, updated_at = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, now(), req.params.id);
    ok(res, { enabled: !!req.body.enabled });
  } catch (e) { err(res, e.message, 500); }
});

// PATCH /api/proxies/:id/template  应用模板：把模板各字段复制到代理覆盖列
router.patch('/:id/template', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM proxies WHERE id = ?').get(req.params.id)) return err(res, '代理不存在', 404);
    const tmpl = db.prepare('SELECT * FROM proxy_templates WHERE id = ?').get(req.body.templateId);
    if (!tmpl) return err(res, '模板不存在', 404);
    db.prepare(`UPDATE proxies SET
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
      keepalive_enabled = @keepalive_enabled,
      keepalive_interval_min = @keepalive_interval_min,
      keepalive_interval_max = @keepalive_interval_max,
      keepalive_request_type = @keepalive_request_type,
      keepalive_business_endpoints = @keepalive_business_endpoints,
      direct_keepalive_enabled = @direct_keepalive_enabled,
      heartbeat_timeout = @heartbeat_timeout,
      fingerprint_config = @fingerprint_config,
      updated_at = @updated_at WHERE id = @id`).run({
      id:                           req.params.id,
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
      keepalive_enabled:            tmpl.keepalive_enabled,
      keepalive_interval_min:       tmpl.keepalive_interval_min,
      keepalive_interval_max:       tmpl.keepalive_interval_max,
      keepalive_request_type:       tmpl.keepalive_request_type,
      keepalive_business_endpoints: tmpl.keepalive_business_endpoints,
      direct_keepalive_enabled:     tmpl.direct_keepalive_enabled,
      heartbeat_timeout:            tmpl.heartbeat_timeout,
      fingerprint_config:           tmpl.fingerprint_config,
      updated_at:                   now(),
    });
    ok(res, parse(db.prepare('SELECT * FROM proxies WHERE id = ?').get(req.params.id)));
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/batch/apply-template  批量给一个账号下的所有代理应用模板
router.post('/batch/apply-template', (req, res) => {
  try {
    const { accountId, templateId } = req.body;
    if (!accountId || !templateId) return err(res, 'accountId and templateId are required', 400);
    const db = getDb();
    const tmpl = db.prepare('SELECT * FROM proxy_templates WHERE id = ?').get(templateId);
    if (!tmpl) return err(res, '模板不存在', 404);
    db.prepare(`UPDATE proxies SET
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
      keepalive_enabled = @keepalive_enabled,
      keepalive_interval_min = @keepalive_interval_min,
      keepalive_interval_max = @keepalive_interval_max,
      keepalive_request_type = @keepalive_request_type,
      keepalive_business_endpoints = @keepalive_business_endpoints,
      direct_keepalive_enabled = @direct_keepalive_enabled,
      heartbeat_timeout = @heartbeat_timeout,
      fingerprint_config = @fingerprint_config,
      updated_at = @updated_at
      WHERE account_id = @account_id`).run({
      account_id:                   accountId,
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
      keepalive_enabled:            tmpl.keepalive_enabled,
      keepalive_interval_min:       tmpl.keepalive_interval_min,
      keepalive_interval_max:       tmpl.keepalive_interval_max,
      keepalive_request_type:       tmpl.keepalive_request_type,
      keepalive_business_endpoints: tmpl.keepalive_business_endpoints,
      direct_keepalive_enabled:     tmpl.direct_keepalive_enabled,
      heartbeat_timeout:            tmpl.heartbeat_timeout,
      fingerprint_config:           tmpl.fingerprint_config,
      updated_at:                   now(),
    });
    const updated = db.prepare('SELECT COUNT(*) AS n FROM proxies WHERE account_id = ?').get(accountId).n;
    ok(res, { updated });
  } catch (e) { err(res, e.message, 500); }
});

// PUT /api/proxies/:id/config  更新单个代理的配置覆盖（任何字段都可设为 null = 跟随模板）
// 行为：只更新 body 中"显式存在"的字段；body 里没传的字段保持当前 DB 值不变。
// 这避免了前端弹窗只关心通道配置时，把查号/锁号/科室相关代理级覆盖列误清空。
router.put('/:id/config', (req, res) => {
  try {
    const b = req.body;
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

    if (has('check_start_time') && !isTimeString(b.check_start_time)) {
      return err(res, 'check_start_time 格式不正确，应为 HH:MM:SS', 400);
    }
    if (has('channel_build_overrides') && b.channel_build_overrides && typeof b.channel_build_overrides === 'object') {
      const e = validateChannelOverrides(b.channel_build_overrides);
      if (e) return err(res, e, 400);
    }
    if (has('target_hosts')) {
      const thErr = validateTargetHosts(b.target_hosts);
      if (thErr) return err(res, thErr, 400);
    }
    if (has('keepalive_interval_min') || has('keepalive_interval_max')) {
      const kaErr = validateKeepaliveInterval(b.keepalive_interval_min, b.keepalive_interval_max);
      if (kaErr) return err(res, kaErr, 400);
    }
    if (has('keepalive_business_endpoints')) {
      const epErr = validateHeartbeatEndpoints(b.keepalive_business_endpoints, HEARTBEAT_ALL_IDS);
      if (epErr) return err(res, epErr, 400);
    }

    const db = getDb();
    if (!db.prepare('SELECT id FROM proxies WHERE id = ?').get(req.params.id)) return err(res, '代理不存在', 404);

    // 动态构造 SET 子句：只覆盖 body 中显式出现的字段
    const setClauses = [];
    const params = { id: req.params.id };
    const setIfPresent = (col, transform) => {
      if (!has(col)) return;
      setClauses.push(`${col} = @${col}`);
      params[col] = transform ? transform(b[col]) : (b[col] ?? null);
    };

    setIfPresent('check_mode');
    setIfPresent('check_start_time');
    setIfPresent('check_window_time');
    setIfPresent('check_min_interval');
    setIfPresent('check_distribution');
    setIfPresent('check_stop_after_found_count', v => v != null ? parseInt(v) : null);
    setIfPresent('check_reuse_channel',          v => v != null ? JSON.stringify(v) : null);
    setIfPresent('lock_config',                  v => v != null ? JSON.stringify(v) : null);
    // channel_build_overrides 列声明为 NOT NULL DEFAULT '{}'，null 时落 '{}'
    setIfPresent('channel_build_overrides',      v => v != null ? JSON.stringify(v) : '{}');
    setIfPresent('doctor_source');
    setIfPresent('doctor_select_mode');
    setIfPresent('doctor_codes',                 v => v != null ? JSON.stringify(v) : null);
    setIfPresent('doctor_plan_date_start');
    setIfPresent('dept_code');
    setIfPresent('dept_plan_date_start');
    setIfPresent('dept_plan_date_end');
    setIfPresent('target_hosts',                 v => Array.isArray(v) && v.length ? JSON.stringify(v) : null);
    // 心跳/keepAlive 代理级覆盖（null = 跟随模板）
    setIfPresent('keepalive_enabled',            v => v != null ? (v ? 1 : 0) : null);
    setIfPresent('keepalive_interval_min',       v => v != null ? parseInt(v, 10) : null);
    setIfPresent('keepalive_interval_max',       v => v != null ? parseInt(v, 10) : null);
    setIfPresent('keepalive_request_type');
    setIfPresent('keepalive_business_endpoints', v => Array.isArray(v) ? JSON.stringify(v) : null);
    setIfPresent('direct_keepalive_enabled',     v => v != null ? (v ? 1 : 0) : null);
    setIfPresent('heartbeat_timeout',            v => v != null ? parseInt(v, 10) : null);
    setIfPresent('fingerprint_config',           v => v != null ? JSON.stringify(v) : null);

    if (setClauses.length > 0) {
      setClauses.push('updated_at = @updated_at');
      params.updated_at = now();
      db.prepare(`UPDATE proxies SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
    }

    ok(res, parseWithEffective(db, db.prepare('SELECT * FROM proxies WHERE id = ?').get(req.params.id)));
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/batch/assign
router.post('/batch/assign', (req, res) => {
  try {
    const { ids, accountId } = req.body;
    if (!Array.isArray(ids) || !accountId) return err(res, 'ids and accountId are required');
    const db = getDb();
    if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId)) return err(res, '账号不存在', 404);
    const runningAccs = getRunningAccountIds(db, req.taskRunner);
    if (runningAccs.has(Number(accountId))) return err(res, '该账号有任务正在运行，请先停止后再调整代理分配', 400);
    const update = db.transaction((idList) => {
      for (const id of idList) db.prepare('UPDATE proxies SET account_id = ?, updated_at = ? WHERE id = ?').run(accountId, now(), id);
      cleanupTaskProxies(db, idList);
    });
    update(ids);
    req.broadcast('proxy-assignment-changed', { accountIds: [accountId] });
    ok(res, { assigned: ids.length, accountId });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/batch/unassign
router.post('/batch/unassign', (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return err(res, 'ids array is required');
    const db = getDb();
    const affectedAccounts = db.prepare(
      `SELECT DISTINCT account_id FROM proxies WHERE id IN (${ids.map(() => '?').join(',')}) AND account_id IS NOT NULL`
    ).all(...ids).map(r => r.account_id);
    const runningAccs = getRunningAccountIds(db, req.taskRunner);
    const blocked = affectedAccounts.filter(id => runningAccs.has(id));
    if (blocked.length) {
      const mobiles = db.prepare(`SELECT mobile FROM accounts WHERE id IN (${blocked.map(() => '?').join(',')})`).all(...blocked).map(r => r.mobile);
      return err(res, `以下账号有任务正在运行，请先停止后再取消分配：${mobiles.join('、')}`, 400);
    }
    const update = db.transaction((idList) => {
      for (const id of idList) db.prepare('UPDATE proxies SET account_id = NULL, updated_at = ? WHERE id = ?').run(now(), id);
      cleanupTaskProxies(db, idList);
    });
    update(ids);
    if (affectedAccounts.length) req.broadcast('proxy-assignment-changed', { accountIds: affectedAccounts });
    ok(res, { unassigned: ids.length });
  } catch (e) { err(res, e.message, 500); }
});

// PATCH /api/proxies/batch/enabled
router.patch('/batch/enabled', (req, res) => {
  try {
    const { ids, enabled } = req.body;
    if (!Array.isArray(ids)) return err(res, 'ids array is required');
    const val = enabled ? 1 : 0;
    const db = getDb();
    const update = db.transaction((idList) => {
      for (const id of idList) db.prepare('UPDATE proxies SET enabled = ?, updated_at = ? WHERE id = ?').run(val, now(), id);
    });
    update(ids);
    ok(res, { updated: ids.length, enabled: !!val });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/:id/assign
router.post('/:id/assign', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM proxies WHERE id = ?').get(req.params.id)) return err(res, '代理不存在', 404);
    if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.body.accountId)) return err(res, '账号不存在', 404);
    const runningAccs = getRunningAccountIds(db, req.taskRunner);
    if (runningAccs.has(Number(req.body.accountId))) return err(res, '该账号有任务正在运行，请先停止后再调整代理分配', 400);
    db.transaction(() => {
      db.prepare('UPDATE proxies SET account_id = ?, updated_at = ? WHERE id = ?').run(req.body.accountId, now(), req.params.id);
      cleanupTaskProxies(db, [Number(req.params.id)]);
    })();
    req.broadcast('proxy-assignment-changed', { accountIds: [req.body.accountId] });
    ok(res, { assigned: true, accountId: req.body.accountId });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/:id/unassign
router.post('/:id/unassign', (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT account_id FROM proxies WHERE id = ?').get(req.params.id);
    if (!existing) return err(res, '代理不存在', 404);
    const prevAccountId = existing.account_id;
    if (prevAccountId) {
      const runningAccs = getRunningAccountIds(db, req.taskRunner);
      if (runningAccs.has(prevAccountId)) return err(res, '该账号有任务正在运行，请先停止后再取消代理分配', 400);
    }
    db.transaction(() => {
      db.prepare('UPDATE proxies SET account_id = NULL, updated_at = ? WHERE id = ?').run(now(), req.params.id);
      cleanupTaskProxies(db, [Number(req.params.id)]);
    })();
    if (prevAccountId) req.broadcast('proxy-assignment-changed', { accountIds: [prevAccountId] });
    ok(res, { unassigned: true });
  } catch (e) { err(res, e.message, 500); }
});

// DELETE /api/proxies/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM proxies WHERE id = ?').get(req.params.id)) return err(res, '代理不存在', 404);
    const affected = db.prepare('SELECT mobile FROM accounts WHERE ops_proxy_id = ?').all(req.params.id);
    if (affected.length > 0 && req.query.force !== '1') {
      return err(res, `该代理被 ${affected.length} 个账号用作操作代理（${affected.map(a => a.mobile).join('、')}），删除后这些账号将失去操作代理，请确认后加 ?force=1 重试`, 409);
    }
    db.prepare('DELETE FROM proxies WHERE id = ?').run(req.params.id);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/auto-assign-all
router.post('/auto-assign-all', (req, res) => {
  try {
    const db = getDb();
    const accounts = db.prepare('SELECT * FROM accounts WHERE enabled = 1').all();
    const runningAccs = getRunningAccountIds(db, req.taskRunner);
    const skipped = [];
    const eligibleAccounts = accounts.filter(account => {
      if (runningAccs.has(account.id)) { skipped.push(account.mobile); return false; }
      return true;
    });
    const { totalAssigned, details } = autoAssignRoundRobin(db, eligibleAccounts, false);
    const changedIds = details.map(d => d.accountId);
    if (changedIds.length) req.broadcast('proxy-assignment-changed', { accountIds: changedIds });
    ok(res, { accountsProcessed: eligibleAccounts.length, totalAssigned, details, skipped });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/:accountId/auto-assign
router.post('/:accountId/auto-assign', (req, res) => {
  try {
    const db = getDb();
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.accountId);
    if (!account) return err(res, '账号不存在', 404);
    const runningAccs = getRunningAccountIds(db, req.taskRunner);
    if (runningAccs.has(account.id)) return err(res, '该账号有任务正在运行，请先停止后再分配代理', 400);
    const count = autoAssign(db, account, false);
    if (count > 0) req.broadcast('proxy-assignment-changed', { accountIds: [account.id] });
    ok(res, { assigned: count });
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxies/:accountId/auto-assign/preview
router.get('/:accountId/auto-assign/preview', (req, res) => {
  try {
    const db = getDb();
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.accountId);
    if (!account) return err(res, '账号不存在', 404);
    const count = autoAssign(db, account, true);
    ok(res, { wouldAssign: count });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/rebalance
router.post('/rebalance', (req, res) => {
  try {
    const db = getDb();
    const accounts = db.prepare('SELECT * FROM accounts WHERE enabled = 1').all();
    const accountIds = accounts.map(a => a.id);
    const runningAccs = getRunningAccountIds(db, req.taskRunner);
    const blockedIds = accountIds.filter(id => runningAccs.has(id));
    if (blockedIds.length) {
      const mobiles = db.prepare(`SELECT mobile FROM accounts WHERE id IN (${blockedIds.map(() => '?').join(',')})`).all(...blockedIds).map(r => r.mobile);
      return err(res, `以下账号有任务正在运行，无法重新均衡代理：${mobiles.join('、')}`, 400);
    }
    if (accountIds.length > 0) {
      // 找到将被解绑的代理，先解绑再清理 task_proxies
      const affectedProxyIds = db.prepare(
        `SELECT id FROM proxies WHERE account_id IN (${accountIds.map(() => '?').join(',')})`
      ).all(...accountIds).map(r => r.id);
      db.prepare(`UPDATE proxies SET account_id = NULL WHERE account_id IN (${accountIds.map(() => '?').join(',')})`).run(...accountIds);
      cleanupTaskProxies(db, affectedProxyIds);
    }
    const { totalAssigned } = autoAssignRoundRobin(db, accounts, false);
    if (accountIds.length) req.broadcast('proxy-assignment-changed', { accountIds });
    ok(res, { accountsRebalanced: accounts.length, totalAssigned });
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxies/rebalance/preview
router.get('/rebalance/preview', (_req, res) => {
  try {
    const db = getDb();
    const accounts = db.prepare('SELECT * FROM accounts WHERE enabled = 1').all();
    const { details } = autoAssignRoundRobin(db, accounts, true);
    const detailMap = new Map(details.map(d => [d.accountId, d.assigned]));
    const preview = accounts.map(account => ({
      accountId: account.id,
      accountMobile: account.mobile,
      wouldAssign: detailMap.get(account.id) || 0,
    }));
    ok(res, preview);
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxies/auto-assign-ops-all
router.post('/auto-assign-ops-all', (req, res) => {
  try {
    const db = getDb();
    const accounts = db.prepare('SELECT * FROM accounts WHERE enabled = 1 AND ops_proxy_id IS NULL').all();
    let assigned = 0;
    const details = [];
    db.transaction(() => {
      for (const account of accounts) {
        if (autoAssignOps(db, account)) {
          assigned++;
          details.push({ accountId: account.id, mobile: account.mobile });
        }
      }
    })();
    ok(res, { accountsProcessed: accounts.length, assigned, details });
  } catch (e) { err(res, e.message, 500); }
});

// ---- helpers ----

function autoAssign(db, account, dryRun) {
  const sys = db.prepare('SELECT default_proxy_max_count FROM system_config WHERE id = 1').get();
  const maxCount = account.proxy_max_count || sys?.default_proxy_max_count || 10;
  const already = db.prepare('SELECT COUNT(*) AS n FROM proxies WHERE account_id = ? AND enabled = 1').get(account.id).n;
  const need = Math.max(0, maxCount - already);
  if (need === 0) return 0;
  const candidates = db.prepare('SELECT id FROM proxies WHERE account_id IS NULL AND enabled = 1 ORDER BY RANDOM() LIMIT ?').all(need);
  if (!dryRun && candidates.length > 0) {
    const assign = db.transaction((list) => {
      for (const p of list) db.prepare('UPDATE proxies SET account_id = ?, updated_at = ? WHERE id = ?').run(account.id, now(), p.id);
    });
    assign(candidates);
  }
  return candidates.length;
}

function autoAssignRoundRobin(db, accounts, dryRun) {
  const sys = db.prepare('SELECT default_proxy_max_count FROM system_config WHERE id = 1').get();
  const defaultMax = sys?.default_proxy_max_count || 10;

  const eligible = accounts.map(account => {
    const maxCount = account.proxy_max_count || defaultMax;
    const already = db.prepare('SELECT COUNT(*) AS n FROM proxies WHERE account_id = ? AND enabled = 1').get(account.id).n;
    const need = Math.max(0, maxCount - already);
    return { id: account.id, mobile: account.mobile, need };
  }).filter(a => a.need > 0);

  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }

  if (eligible.length === 0) return { totalAssigned: 0, details: [] };

  const proxies = db.prepare('SELECT id FROM proxies WHERE account_id IS NULL AND enabled = 1 ORDER BY RANDOM()').all();
  if (proxies.length === 0) return { totalAssigned: 0, details: [] };

  const assignments = new Map();
  let proxyIdx = 0;
  let accountIdx = 0;

  while (proxyIdx < proxies.length && eligible.length > 0) {
    const account = eligible[accountIdx];
    if (!assignments.has(account.id)) assignments.set(account.id, []);
    assignments.get(account.id).push(proxies[proxyIdx].id);
    proxyIdx++;
    account.need--;
    if (account.need === 0) {
      eligible.splice(accountIdx, 1);
      if (eligible.length > 0) accountIdx = accountIdx % eligible.length;
    } else {
      accountIdx = (accountIdx + 1) % eligible.length;
    }
  }

  if (!dryRun && assignments.size > 0) {
    const stmt = db.prepare('UPDATE proxies SET account_id = ?, updated_at = ? WHERE id = ?');
    db.transaction(() => {
      for (const [accountId, proxyIds] of assignments) {
        for (const proxyId of proxyIds) stmt.run(accountId, now(), proxyId);
      }
    })();
  }

  const accountMobileMap = new Map(accounts.map(a => [a.id, a.mobile]));
  const details = [];
  let totalAssigned = 0;
  for (const [accountId, proxyIds] of assignments) {
    details.push({ accountId, mobile: accountMobileMap.get(accountId), assigned: proxyIds.length });
    totalAssigned += proxyIds.length;
  }
  return { totalAssigned, details };
}

function autoAssignOps(db, account) {
  if (account.ops_proxy_id) return 0;
  // 排除仅云端 SSH 代理（无本地端口）：账号操作必须走本地 SOCKS5
  const candidate = db.prepare(`
    SELECT p.id, COUNT(a.id) AS usage_count
    FROM proxies p
    LEFT JOIN accounts a ON a.ops_proxy_id = p.id
    WHERE p.ops_enabled = 1 AND NOT (p.proxy_type = 'ssh' AND p.port IS NULL)
    GROUP BY p.id
    ORDER BY usage_count ASC, RANDOM()
    LIMIT 1
  `).get();
  if (!candidate) return 0;
  db.prepare('UPDATE accounts SET ops_proxy_id = ?, updated_at = ? WHERE id = ?').run(candidate.id, now(), account.id);
  return 1;
}

module.exports = router;
module.exports.autoAssign = autoAssign;
module.exports.autoAssignRoundRobin = autoAssignRoundRobin;
module.exports.autoAssignOps = autoAssignOps;
module.exports.getRunningAccountIds = getRunningAccountIds;
