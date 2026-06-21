'use strict';

const { Router } = require('express');
const { getDb, ok, err, now } = require('./_helper');
const { autoAssign, autoAssignOps, getRunningAccountIds } = require('./proxies');

const router = Router();

// GET /api/accounts  ?enabled=1
router.get('/', (req, res) => {
  try {
    const db = getDb();
    let sql = `SELECT a.*,
      COALESCE(ad.uuid, ad.device_id) AS device_uuid,
      (SELECT COUNT(*) FROM tasks t WHERE t.account_id = a.id) AS task_count,
      (SELECT COUNT(*) FROM proxies p WHERE p.account_id = a.id AND p.enabled = 1) AS proxy_count,
      CASE WHEN op.id IS NULL THEN NULL WHEN op.proxy_type = 'direct' THEN '本机直连' ELSE op.host || ':' || op.port END AS ops_proxy_label
      FROM accounts a
      LEFT JOIN proxies op ON op.id = a.ops_proxy_id
      LEFT JOIN account_devices ad ON ad.account_id = a.id`;
    const params = [];
    if (req.query.enabled !== undefined) {
      sql += ' WHERE a.enabled = ?';
      params.push(req.query.enabled === '1' ? 1 : 0);
    }
    sql += ' ORDER BY a.id ASC';
    ok(res, db.prepare(sql).all(...params));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// GET /api/accounts/:id/request-logs
router.get('/:id/request-logs', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id)) return err(res, '账号不存在', 404);
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const rows = db.prepare(
      'SELECT * FROM account_request_logs WHERE account_id = ? ORDER BY id DESC LIMIT ?'
    ).all(req.params.id, limit);
    ok(res, rows);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// GET /api/accounts/:id/patients
router.get('/:id/patients', (req, res) => {
  try {
    const db = getDb();
    const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
    if (!account) return err(res, '账号不存在', 404);

    const rows = db.prepare('SELECT * FROM account_patients WHERE account_id = ? ORDER BY id').all(req.params.id);
    const patients = rows.map(r => {
      const patientId = String(Math.round(Number(r.patient_id)));
      const idCard = r.id_card || '';
      let gender = '', age = null;
      if (idCard.length >= 18) {
        gender = parseInt(idCard[16]) % 2 === 1 ? '男' : '女';
        age = new Date().getFullYear() - parseInt(idCard.substring(6, 10));
      }
      return { id: patientId, name: r.name || '', gender, age };
    }).filter(p => p.name);
    ok(res, patients);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// PUT /api/accounts/:id
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id)) return err(res, '账号不存在', 404);
    const b = req.body;
    db.prepare(`UPDATE accounts SET
      enabled          = COALESCE(@enabled, enabled),
      account_type     = COALESCE(@account_type, account_type),
      account_platform = COALESCE(@account_platform, account_platform),
      proxy_max_count  = COALESCE(@proxy_max_count, proxy_max_count),
      updated_at       = @updated_at
      WHERE id = @id`).run({
      id:               req.params.id,
      enabled:          b.enabled != null ? (b.enabled ? 1 : 0) : null,
      account_type:     b.account_type ?? null,
      account_platform: b.account_platform ?? null,
      proxy_max_count:  b.proxy_max_count ?? null,
      updated_at:       now(),
    });
    if (b.proxy_max_count != null) {
      const runningAccs = getRunningAccountIds(db, req.taskRunner);
      if (runningAccs.has(Number(req.params.id))) return err(res, '该账号有任务正在运行，请先停止后再调整代理上限', 400);
      const excess = db.prepare(
        'SELECT id FROM proxies WHERE account_id = ? ORDER BY id ASC LIMIT -1 OFFSET ?'
      ).all(req.params.id, b.proxy_max_count);
      if (excess.length > 0) {
        const release = db.prepare('UPDATE proxies SET account_id = NULL, updated_at = ? WHERE id = ?');
        db.transaction(() => excess.forEach(p => release.run(now(), p.id)))();
      }
      const updatedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
      if (updatedAccount.enabled) autoAssign(db, updatedAccount, false);
    }
    ok(res, db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// DELETE /api/accounts/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id)) return err(res, '账号不存在', 404);

    // 释放该账号占用的代理
    db.prepare('UPDATE proxies SET account_id = NULL, updated_at = ? WHERE account_id = ?')
      .run(now(), req.params.id);
    // 解除任务关联
    db.prepare('UPDATE tasks SET account_id = NULL WHERE account_id = ?').run(req.params.id);
    // 删除账号（子表通过 ON DELETE CASCADE 自动清理）
    db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);

    ok(res, { deleted: true });
  } catch (e) {
    err(res, e.message, 500);
  }
});

// PATCH /api/accounts/:id/enabled
router.patch('/:id/enabled', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id)) return err(res, '账号不存在', 404);
    const enabled = req.body.enabled ? 1 : 0;
    db.prepare('UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled, now(), req.params.id);
    if (!enabled) {
      db.prepare('UPDATE proxies SET account_id = NULL, updated_at = ? WHERE account_id = ?').run(now(), req.params.id);
      db.prepare('UPDATE accounts SET ops_proxy_id = NULL, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    } else {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
      const assigned = autoAssign(db, account, false);
      if (assigned > 0) console.log(`✅ 账号 ${account.mobile} 启用，自动分配 ${assigned} 个任务代理`);
      autoAssignOps(db, account);
    }
    ok(res, db.prepare(`
      SELECT a.*,
        COALESCE(ad.uuid, ad.device_id) AS device_uuid,
        (SELECT COUNT(*) FROM tasks t WHERE t.account_id = a.id) AS task_count,
        (SELECT COUNT(*) FROM proxies p WHERE p.account_id = a.id AND p.enabled = 1) AS proxy_count,
        CASE WHEN op.id IS NULL THEN NULL WHEN op.proxy_type = 'direct' THEN '本机直连' ELSE op.host || ':' || op.port END AS ops_proxy_label
      FROM accounts a
      LEFT JOIN proxies op ON op.id = a.ops_proxy_id
      LEFT JOIN account_devices ad ON ad.account_id = a.id
      WHERE a.id = ?`).get(req.params.id));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// PATCH /api/accounts/:id/ops-proxy  body: { proxyId: number|null }
router.patch('/:id/ops-proxy', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id)) return err(res, '账号不存在', 404);
    const { proxyId } = req.body;
    if (proxyId != null) {
      const proxy = db.prepare('SELECT id, proxy_type, port, real_ip FROM proxies WHERE id = ? AND ops_enabled = 1').get(proxyId);
      if (!proxy) return err(res, '代理不存在或未开启操作模式', 404);
      if (proxy.proxy_type === 'ssh' && !proxy.port) {
        return err(res, `该 SSH 代理（${proxy.real_ip || '?'}）为"仅云端"代理，无本地端口，不能作账号操作代理`, 400);
      }
    }
    db.prepare('UPDATE accounts SET ops_proxy_id = ?, updated_at = ? WHERE id = ?').run(proxyId ?? null, now(), req.params.id);
    ok(res, db.prepare(`
      SELECT a.*,
        COALESCE(ad.uuid, ad.device_id) AS device_uuid,
        (SELECT COUNT(*) FROM tasks t WHERE t.account_id = a.id) AS task_count,
        (SELECT COUNT(*) FROM proxies p WHERE p.account_id = a.id AND p.enabled = 1) AS proxy_count,
        CASE WHEN op.id IS NULL THEN NULL WHEN op.proxy_type = 'direct' THEN '本机直连' ELSE op.host || ':' || op.port END AS ops_proxy_label
      FROM accounts a
      LEFT JOIN proxies op ON op.id = a.ops_proxy_id
      LEFT JOIN account_devices ad ON ad.account_id = a.id
      WHERE a.id = ?`).get(req.params.id));
  } catch (e) { err(res, e.message, 500); }
});

module.exports = router;
