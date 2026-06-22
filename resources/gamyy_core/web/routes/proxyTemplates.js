'use strict';

const { Router } = require('express');
const { getDb, ok, err, now } = require('./_helper');
const { isTimeString, validateChannelOverrides, validateTargetHosts, validateKeepaliveInterval, validateHeartbeatEndpoints } = require('./_validate');
const { ALL_IDS: HEARTBEAT_ALL_IDS } = require('../../services/HeartbeatEndpointPool');

const router = Router();

router.get('/', (_req, res) => {
  try {
    ok(res, getDb().prepare('SELECT * FROM proxy_templates ORDER BY id').all().map(parse));
  } catch (e) { err(res, e.message, 500); }
});

router.post('/', (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return err(res, 'name is required');
    if (!isTimeString(b.check_start_time)) return err(res, 'check_start_time 格式不正确，应为 HH:MM:SS', 400);
    if (b.channel_build_overrides && typeof b.channel_build_overrides === 'object') {
      const e = validateChannelOverrides(b.channel_build_overrides);
      if (e) return err(res, e, 400);
    }
    const thErr = validateTargetHosts(b.target_hosts);
    if (thErr) return err(res, thErr, 400);
    const kaErr = validateKeepaliveInterval(b.keepalive_interval_min, b.keepalive_interval_max);
    if (kaErr) return err(res, kaErr, 400);
    const epErr = validateHeartbeatEndpoints(b.keepalive_business_endpoints, HEARTBEAT_ALL_IDS);
    if (epErr) return err(res, epErr, 400);
    const r = getDb().prepare(`INSERT INTO proxy_templates
      (name, description, check_mode, check_start_time, check_window_time, check_min_interval,
       check_distribution, check_stop_after_found_count, check_reuse_channel,
       lock_config, channel_build_overrides, target_hosts,
       doctor_source, doctor_select_mode, doctor_codes, doctor_plan_date_start,
       dept_code, dept_plan_date_start, dept_plan_date_end,
       keepalive_enabled, keepalive_interval_min, keepalive_interval_max,
       keepalive_request_type, keepalive_business_endpoints, direct_keepalive_enabled, heartbeat_timeout)
      VALUES (@name, @description, @check_mode, @check_start_time, @check_window_time, @check_min_interval,
       @check_distribution, @check_stop_after_found_count, @check_reuse_channel,
       @lock_config, @channel_build_overrides, @target_hosts,
       @doctor_source, @doctor_select_mode, @doctor_codes, @doctor_plan_date_start,
       @dept_code, @dept_plan_date_start, @dept_plan_date_end,
       @keepalive_enabled, @keepalive_interval_min, @keepalive_interval_max,
       @keepalive_request_type, @keepalive_business_endpoints, @direct_keepalive_enabled, @heartbeat_timeout)`).run({
      name:                       b.name,
      description:                b.description ?? null,
      check_mode:                 b.check_mode ?? 'doctor',
      check_start_time:           b.check_start_time ?? null,
      check_window_time:          b.check_window_time ?? null,
      check_min_interval:         b.check_min_interval ?? null,
      check_distribution:         b.check_distribution ?? 'uniform',
      check_stop_after_found_count: b.check_stop_after_found_count != null ? parseInt(b.check_stop_after_found_count) : 3,
      check_reuse_channel:        JSON.stringify(b.check_reuse_channel ?? {}),
      lock_config:                JSON.stringify(b.lock_config ?? {}),
      channel_build_overrides:    JSON.stringify(b.channel_build_overrides ?? {}),
      target_hosts:               Array.isArray(b.target_hosts) && b.target_hosts.length ? JSON.stringify(b.target_hosts) : null,
      doctor_source:              b.doctor_source ?? 'config',
      doctor_select_mode:         b.doctor_select_mode ?? 'random',
      doctor_codes:               JSON.stringify(Array.isArray(b.doctor_codes) ? b.doctor_codes : []),
      doctor_plan_date_start:     b.doctor_plan_date_start ?? null,
      dept_code:                  b.dept_code ?? null,
      dept_plan_date_start:       b.dept_plan_date_start ?? null,
      dept_plan_date_end:         b.dept_plan_date_end ?? null,
      // 心跳/keepAlive（模板层默认；未传时落 schema 默认值）
      keepalive_enabled:            b.keepalive_enabled != null ? (b.keepalive_enabled ? 1 : 0) : 1,
      keepalive_interval_min:       b.keepalive_interval_min != null ? parseInt(b.keepalive_interval_min, 10) : 40000,
      keepalive_interval_max:       b.keepalive_interval_max != null ? parseInt(b.keepalive_interval_max, 10) : 70000,
      keepalive_request_type:       b.keepalive_request_type ?? 'head',
      keepalive_business_endpoints: JSON.stringify(Array.isArray(b.keepalive_business_endpoints) ? b.keepalive_business_endpoints : []),
      direct_keepalive_enabled:     b.direct_keepalive_enabled != null ? (b.direct_keepalive_enabled ? 1 : 0) : 0,
      heartbeat_timeout:            b.heartbeat_timeout != null ? parseInt(b.heartbeat_timeout, 10) : 300000,
    });
    ok(res, parse(getDb().prepare('SELECT * FROM proxy_templates WHERE id = ?').get(r.lastInsertRowid)), 201);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, '模板名称已存在');
    err(res, e.message, 500);
  }
});

router.get('/:id', (req, res) => {
  try {
    const row = getDb().prepare('SELECT * FROM proxy_templates WHERE id = ?').get(req.params.id);
    if (!row) return err(res, '模板不存在', 404);
    ok(res, parse(row));
  } catch (e) { err(res, e.message, 500); }
});

router.put('/:id', (req, res) => {
  try {
    const b = req.body;
    if (!isTimeString(b.check_start_time)) return err(res, 'check_start_time 格式不正确，应为 HH:MM:SS', 400);
    if (b.channel_build_overrides && typeof b.channel_build_overrides === 'object') {
      const e = validateChannelOverrides(b.channel_build_overrides);
      if (e) return err(res, e, 400);
    }
    const thErr = validateTargetHosts(b.target_hosts);
    if (thErr) return err(res, thErr, 400);
    const kaErr = validateKeepaliveInterval(b.keepalive_interval_min, b.keepalive_interval_max);
    if (kaErr) return err(res, kaErr, 400);
    const epErr = validateHeartbeatEndpoints(b.keepalive_business_endpoints, HEARTBEAT_ALL_IDS);
    if (epErr) return err(res, epErr, 400);
    const db = getDb();
    if (!db.prepare('SELECT id FROM proxy_templates WHERE id = ?').get(req.params.id)) return err(res, '模板不存在', 404);
    db.prepare(`UPDATE proxy_templates SET
      name = COALESCE(@name, name),
      description = COALESCE(@description, description),
      check_mode = COALESCE(@check_mode, check_mode),
      check_start_time = COALESCE(@check_start_time, check_start_time),
      check_window_time = COALESCE(@check_window_time, check_window_time),
      check_min_interval = COALESCE(@check_min_interval, check_min_interval),
      check_distribution = COALESCE(@check_distribution, check_distribution),
      check_stop_after_found_count = COALESCE(@check_stop_after_found_count, check_stop_after_found_count),
      check_reuse_channel = COALESCE(@check_reuse_channel, check_reuse_channel),
      lock_config = COALESCE(@lock_config, lock_config),
      channel_build_overrides = COALESCE(@channel_build_overrides, channel_build_overrides),
      target_hosts = @target_hosts,
      doctor_source = COALESCE(@doctor_source, doctor_source),
      doctor_select_mode = COALESCE(@doctor_select_mode, doctor_select_mode),
      doctor_codes = COALESCE(@doctor_codes, doctor_codes),
      doctor_plan_date_start = @doctor_plan_date_start,
      dept_code = @dept_code,
      dept_plan_date_start = @dept_plan_date_start,
      dept_plan_date_end = @dept_plan_date_end,
      keepalive_enabled = COALESCE(@keepalive_enabled, keepalive_enabled),
      keepalive_interval_min = COALESCE(@keepalive_interval_min, keepalive_interval_min),
      keepalive_interval_max = COALESCE(@keepalive_interval_max, keepalive_interval_max),
      keepalive_request_type = COALESCE(@keepalive_request_type, keepalive_request_type),
      keepalive_business_endpoints = COALESCE(@keepalive_business_endpoints, keepalive_business_endpoints),
      direct_keepalive_enabled = COALESCE(@direct_keepalive_enabled, direct_keepalive_enabled),
      heartbeat_timeout = COALESCE(@heartbeat_timeout, heartbeat_timeout),
      updated_at = @updated_at WHERE id = @id`).run({
      id:                         req.params.id,
      name:                       b.name ?? null,
      description:                b.description ?? null,
      check_mode:                 b.check_mode ?? null,
      check_start_time:           b.check_start_time ?? null,
      check_window_time:          b.check_window_time ?? null,
      check_min_interval:         b.check_min_interval ?? null,
      check_distribution:         b.check_distribution ?? null,
      check_stop_after_found_count: b.check_stop_after_found_count != null ? parseInt(b.check_stop_after_found_count) : null,
      check_reuse_channel:        b.check_reuse_channel != null ? JSON.stringify(b.check_reuse_channel) : null,
      lock_config:                b.lock_config != null ? JSON.stringify(b.lock_config) : null,
      channel_build_overrides:    b.channel_build_overrides != null ? JSON.stringify(b.channel_build_overrides) : null,
      target_hosts:               Array.isArray(b.target_hosts) && b.target_hosts.length ? JSON.stringify(b.target_hosts) : null,
      doctor_source:              b.doctor_source ?? null,
      doctor_select_mode:         b.doctor_select_mode ?? null,
      doctor_codes:               b.doctor_codes != null ? JSON.stringify(Array.isArray(b.doctor_codes) ? b.doctor_codes : []) : null,
      doctor_plan_date_start:     b.doctor_plan_date_start ?? null,
      dept_code:                  b.dept_code ?? null,
      dept_plan_date_start:       b.dept_plan_date_start ?? null,
      dept_plan_date_end:         b.dept_plan_date_end ?? null,
      keepalive_enabled:            b.keepalive_enabled != null ? (b.keepalive_enabled ? 1 : 0) : null,
      keepalive_interval_min:       b.keepalive_interval_min != null ? parseInt(b.keepalive_interval_min, 10) : null,
      keepalive_interval_max:       b.keepalive_interval_max != null ? parseInt(b.keepalive_interval_max, 10) : null,
      keepalive_request_type:       b.keepalive_request_type ?? null,
      keepalive_business_endpoints: b.keepalive_business_endpoints != null ? JSON.stringify(Array.isArray(b.keepalive_business_endpoints) ? b.keepalive_business_endpoints : []) : null,
      direct_keepalive_enabled:     b.direct_keepalive_enabled != null ? (b.direct_keepalive_enabled ? 1 : 0) : null,
      heartbeat_timeout:            b.heartbeat_timeout != null ? parseInt(b.heartbeat_timeout, 10) : null,
      updated_at:                 now(),
    });
    ok(res, parse(db.prepare('SELECT * FROM proxy_templates WHERE id = ?').get(req.params.id)));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, '模板名称已存在');
    err(res, e.message, 500);
  }
});

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT id, name FROM proxy_templates WHERE id = ?').get(req.params.id);
    if (!row) return err(res, '模板不存在', 404);
    if (row.name === '默认配置') return err(res, '默认配置模板不可删除', 400);
    db.prepare('UPDATE proxies SET template_id = NULL WHERE template_id = ?').run(req.params.id);
    db.prepare('DELETE FROM proxy_templates WHERE id = ?').run(req.params.id);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message, 500); }
});

function parse(row) {
  return {
    ...row,
    check_reuse_channel:     JSON.parse(row.check_reuse_channel || '{}'),
    lock_config:             JSON.parse(row.lock_config || '{}'),
    channel_build_overrides: JSON.parse(row.channel_build_overrides || '{}'),
    target_hosts:            row.target_hosts ? JSON.parse(row.target_hosts) : null,
    doctor_codes:            JSON.parse(row.doctor_codes || '[]'),
    keepalive_business_endpoints: JSON.parse(row.keepalive_business_endpoints || '[]'),
  };
}

module.exports = router;
