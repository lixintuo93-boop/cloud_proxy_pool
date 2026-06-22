'use strict';

const { Router } = require('express');
const { getDb, ok, err, now } = require('./_helper');
const { isTimeString, validateChannelOverrides, validateTargetHosts } = require('./_validate');

const router = Router();

// GET /api/task-templates
router.get('/', (_req, res) => {
  try {
    const rows = getDb().prepare('SELECT * FROM task_templates ORDER BY id').all();
    ok(res, rows.map(parseTemplate));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// POST /api/task-templates
router.post('/', (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return err(res, 'name is required');
    if (!isTimeString(b.check_start_time)) return err(res, 'check_start_time 格式不正确，应为 HH:MM:SS', 400);
    if (b.channel_build_config && typeof b.channel_build_config === 'object') {
      const e = validateChannelOverrides(b.channel_build_config);
      if (e) return err(res, e, 400);
    }
    const thErr = validateTargetHosts(b.target_hosts);
    if (thErr) return err(res, thErr, 400);
    const db = getDb();
    const result = db.prepare(`INSERT INTO task_templates
      (name, description, check_start_time, check_window_time, check_min_interval,
       check_distribution, check_stop_after_found_count, check_reuse_channel,
       lock_config, channel_build_config, target_hosts,
       check_mode, doctor_source, doctor_select_mode, doctor_codes, doctor_plan_date_start,
       dept_code, dept_plan_date_start, dept_plan_date_end)
      VALUES (@name, @description, @check_start_time, @check_window_time, @check_min_interval,
       @check_distribution, @check_stop_after_found_count, @check_reuse_channel,
       @lock_config, @channel_build_config, @target_hosts,
       @check_mode, @doctor_source, @doctor_select_mode, @doctor_codes, @doctor_plan_date_start,
       @dept_code, @dept_plan_date_start, @dept_plan_date_end)`).run({
      name:                       b.name,
      description:                b.description ?? null,
      check_start_time:           b.check_start_time ?? null,
      check_window_time:          b.check_window_time ?? null,
      check_min_interval:         b.check_min_interval ?? null,
      check_distribution:         b.check_distribution ?? 'uniform',
      check_stop_after_found_count: b.check_stop_after_found_count != null ? parseInt(b.check_stop_after_found_count) : 3,
      check_reuse_channel:        JSON.stringify(b.check_reuse_channel ?? {}),
      lock_config:                JSON.stringify(b.lock_config ?? {}),
      channel_build_config:       JSON.stringify(b.channel_build_config ?? {}),
      target_hosts:               Array.isArray(b.target_hosts) && b.target_hosts.length ? JSON.stringify(b.target_hosts) : null,
      check_mode:                 b.check_mode ?? 'doctor',
      doctor_source:              b.doctor_source ?? 'config',
      doctor_select_mode:         b.doctor_select_mode ?? 'random',
      doctor_codes:               JSON.stringify(Array.isArray(b.doctor_codes) ? b.doctor_codes : []),
      doctor_plan_date_start:     b.doctor_plan_date_start ?? null,
      dept_code:                  b.dept_code ?? null,
      dept_plan_date_start:       b.dept_plan_date_start ?? null,
      dept_plan_date_end:         b.dept_plan_date_end ?? null,
    });
    const row = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(result.lastInsertRowid);
    ok(res, parseTemplate(row), 201);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, '模板名称已存在');
    err(res, e.message, 500);
  }
});

// GET /api/task-templates/:id
router.get('/:id', (req, res) => {
  try {
    const row = getDb().prepare('SELECT * FROM task_templates WHERE id = ?').get(req.params.id);
    if (!row) return err(res, '模板不存在', 404);
    ok(res, parseTemplate(row));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// PUT /api/task-templates/:id
router.put('/:id', (req, res) => {
  try {
    const b = req.body;
    if (!isTimeString(b.check_start_time)) return err(res, 'check_start_time 格式不正确，应为 HH:MM:SS', 400);
    if (b.channel_build_config && typeof b.channel_build_config === 'object') {
      const e = validateChannelOverrides(b.channel_build_config);
      if (e) return err(res, e, 400);
    }
    const thErr = validateTargetHosts(b.target_hosts);
    if (thErr) return err(res, thErr, 400);
    const db = getDb();
    const row = db.prepare('SELECT id FROM task_templates WHERE id = ?').get(req.params.id);
    if (!row) return err(res, '模板不存在', 404);
    db.prepare(`UPDATE task_templates SET
      name = COALESCE(@name, name),
      description = COALESCE(@description, description),
      check_start_time = COALESCE(@check_start_time, check_start_time),
      check_window_time = COALESCE(@check_window_time, check_window_time),
      check_min_interval = COALESCE(@check_min_interval, check_min_interval),
      check_distribution = COALESCE(@check_distribution, check_distribution),
      check_stop_after_found_count = COALESCE(@check_stop_after_found_count, check_stop_after_found_count),
      check_reuse_channel = COALESCE(@check_reuse_channel, check_reuse_channel),
      lock_config = COALESCE(@lock_config, lock_config),
      channel_build_config = COALESCE(@channel_build_config, channel_build_config),
      target_hosts = @target_hosts,
      check_mode = COALESCE(@check_mode, check_mode),
      doctor_source = COALESCE(@doctor_source, doctor_source),
      doctor_select_mode = COALESCE(@doctor_select_mode, doctor_select_mode),
      doctor_codes = COALESCE(@doctor_codes, doctor_codes),
      doctor_plan_date_start = @doctor_plan_date_start,
      dept_code = @dept_code,
      dept_plan_date_start = @dept_plan_date_start,
      dept_plan_date_end = @dept_plan_date_end,
      updated_at = @updated_at
      WHERE id = @id`).run({
      id:                         req.params.id,
      name:                       b.name ?? null,
      description:                b.description ?? null,
      check_start_time:           b.check_start_time ?? null,
      check_window_time:          b.check_window_time ?? null,
      check_min_interval:         b.check_min_interval ?? null,
      check_distribution:         b.check_distribution ?? null,
      check_stop_after_found_count: b.check_stop_after_found_count != null ? parseInt(b.check_stop_after_found_count) : null,
      check_reuse_channel:        b.check_reuse_channel != null ? JSON.stringify(b.check_reuse_channel) : null,
      lock_config:                b.lock_config != null ? JSON.stringify(b.lock_config) : null,
      channel_build_config:       b.channel_build_config != null ? JSON.stringify(b.channel_build_config) : null,
      target_hosts:               Array.isArray(b.target_hosts) && b.target_hosts.length ? JSON.stringify(b.target_hosts) : null,
      check_mode:                 b.check_mode ?? null,
      doctor_source:              b.doctor_source ?? null,
      doctor_select_mode:         b.doctor_select_mode ?? null,
      doctor_codes:               b.doctor_codes != null ? JSON.stringify(Array.isArray(b.doctor_codes) ? b.doctor_codes : []) : null,
      doctor_plan_date_start:     b.doctor_plan_date_start ?? null,
      dept_code:                  b.dept_code ?? null,
      dept_plan_date_start:       b.dept_plan_date_start ?? null,
      dept_plan_date_end:         b.dept_plan_date_end ?? null,
      updated_at:                 now(),
    });
    ok(res, parseTemplate(db.prepare('SELECT * FROM task_templates WHERE id = ?').get(req.params.id)));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, '模板名称已存在');
    err(res, e.message, 500);
  }
});

// DELETE /api/task-templates/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT id, name FROM task_templates WHERE id = ?').get(req.params.id);
    if (!row) return err(res, '模板不存在', 404);
    if (row.name === '默认配置') return err(res, '默认配置模板不可删除', 400);
    // 将引用该模板的任务改为指向默认模板
    const defaultTmpl = db.prepare("SELECT id FROM task_templates WHERE name = '默认配置'").get();
    if (defaultTmpl) {
      db.prepare('UPDATE tasks SET template_id = ? WHERE template_id = ?').run(defaultTmpl.id, req.params.id);
    } else {
      db.prepare('UPDATE tasks SET template_id = NULL WHERE template_id = ?').run(req.params.id);
    }
    db.prepare('DELETE FROM task_templates WHERE id = ?').run(req.params.id);
    ok(res, { deleted: true });
  } catch (e) {
    err(res, e.message, 500);
  }
});

function parseTemplate(row) {
  return {
    ...row,
    check_reuse_channel:  JSON.parse(row.check_reuse_channel || '{}'),
    lock_config:          JSON.parse(row.lock_config || '{}'),
    channel_build_config: JSON.parse(row.channel_build_config || '{}'),
    target_hosts:         row.target_hosts ? JSON.parse(row.target_hosts) : null,
    doctor_codes:         JSON.parse(row.doctor_codes || '[]'),
  };
}

module.exports = router;
