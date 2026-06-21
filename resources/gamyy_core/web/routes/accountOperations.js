'use strict';

const crypto  = require('crypto');
const { Router } = require('express');
const { getDb, ok, err, now } = require('./_helper');
const { autoAssign } = require('./proxies');
const AccountOperationService = require('../../account/AccountOperationService');
const AccountCreator          = require('../../account/AccountCreator');
const { generatePatientInfo } = require('../../account/PatientGenerator');
const C = require('../../account/constants');

const router = Router();

function getService() {
  return new AccountOperationService(getDb());
}

// GET /api/accounts/generate-patient-info?minAge=X&maxAge=Y
router.get('/generate-patient-info', (req, res) => {
  try {
    const minAge  = parseInt(req.query.minAge, 10) || 18;
    const maxAge  = parseInt(req.query.maxAge, 10) || 60;
    const gender  = ['male', 'female'].includes(req.query.gender) ? req.query.gender : undefined;
    ok(res, generatePatientInfo({ minAge, maxAge, gender }));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// POST /api/accounts/add-manual — 手动添加 App 端账号（支持单个或批量）
// body: { mobile, password, platform? } 或 { accounts: [{mobile, password, platform?}] }
router.post('/add-manual', (req, res) => {
  try {
    const db = getDb();
    const S456HR8_SALT = C.S456HR8_SALT;

    const _parseCfg = (v, def) => { try { const o = JSON.parse(v || '{}'); return { ...def, ...o }; } catch { return def; } };
    const _parsePool = (v, seed) => {
      try { const a = JSON.parse(v || '[]'); return Array.isArray(a) && a.length > 0 ? a : seed; }
      catch { return seed; }
    };
    const _sys = db.prepare(`
      SELECT app_client_config, android_client_config, app_ua_pool, android_ua_pool
      FROM system_config WHERE id = 1
    `).get() || {};
    const appCfg     = _parseCfg(_sys.app_client_config,     C.APP_CONFIG);
    const androidCfg = _parseCfg(_sys.android_client_config, C.ANDROID_CONFIG);
    const appPool    = _parsePool(_sys.app_ua_pool,     C.APP_UA_POOL);
    const androidPool= _parsePool(_sys.android_ua_pool, C.ANDROID_UA_POOL);
    const pickUA = (pool) => pool[Math.floor(Math.random() * pool.length)];

    const entries = req.body.accounts
      ? req.body.accounts
      : [{ mobile: req.body.mobile, password: req.body.password, platform: req.body.platform }];

    if (!entries || entries.length === 0) return err(res, '请提供账号信息');
    if (entries.length > 200) return err(res, '单次最多添加 200 个账号');

    const sys = db.prepare('SELECT default_proxy_max_count FROM system_config WHERE id = 1').get();
    const proxyMaxCount = sys?.default_proxy_max_count ?? 10;

    const results = { success: 0, fail: 0, accounts: [], errors: [] };

    for (const entry of entries) {
      const { mobile, password, platform = 'ios' } = entry;
      if (!mobile || !/^1[3-9]\d{9}$/.test(mobile)) {
        results.fail++;
        results.errors.push(`${mobile || '(空)'}: 手机号格式不正确`);
        continue;
      }
      if (!password || password.length < 6) {
        results.fail++;
        results.errors.push(`${mobile}: 密码不能少于6位`);
        continue;
      }
      try {
        const account = db.transaction(() => {
          const existing = db.prepare('SELECT id FROM accounts WHERE mobile = ?').get(mobile);
          if (existing) throw new Error('手机号已存在');

          const isAndroid  = platform === 'android';
          const uuid       = crypto.randomUUID().replace(/-/g, '').toUpperCase();
          const deviceId   = isAndroid ? uuid.toLowerCase() : uuid;
          const s456hr8    = crypto.createHash('md5').update(deviceId + S456HR8_SALT).digest('hex');
          const ua         = pickUA(isAndroid ? androidPool : appPool);
          const clientVer  = (isAndroid ? androidCfg.CLIENT_VERSION : appCfg.CLIENT_VERSION) || null;
          const accPlatform = isAndroid ? 'android' : 'ios';
          const ts         = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

          const row = db.prepare(
            `INSERT INTO accounts (mobile, password, account_type, account_platform, proxy_max_count, status, enabled, created_at, updated_at)
             VALUES (?, ?, 'app', ?, ?, 'pending', 1, ?, ?)`
          ).run(mobile, password, accPlatform, proxyMaxCount, ts, ts);

          const accountId = row.lastInsertRowid;
          db.prepare(
            `INSERT INTO account_devices (account_id, device_id, s456hr8, user_agent, client_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(accountId, deviceId, s456hr8, ua, clientVer, ts);

          return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
        })();

        autoAssign(db, account, false);
        results.success++;
        results.accounts.push({ id: account.id, mobile: account.mobile, platform: account.account_platform });
      } catch (e) {
        results.fail++;
        results.errors.push(`${mobile}: ${e.message}`);
      }
    }

    ok(res, results);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// POST /api/accounts/generate — 在 gamyy-core 中批量生成账号
// body: { accountType: 'app'|'wechat', platform: 'ios'|'android', count: number }
router.post('/generate', (req, res) => {
  try {
    const { accountType, platform = 'ios', count } = req.body;

    if (!['app', 'wechat'].includes(accountType))
      return err(res, '无效的 accountType，必须为 app 或 wechat');

    const n = parseInt(count, 10);
    if (!n || n < 1 || n > 200)
      return err(res, 'count 必须为 1-200 的整数');

    const db = getDb();
    const result = AccountCreator.generate(db, accountType, { count: n, platform });
    for (const acc of result.accounts) {
      const fullAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc.id);
      if (fullAccount) autoAssign(db, fullAccount, false);
    }
    ok(res, result);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// POST /api/accounts/:id/operation
router.post('/:id/operation', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const { operationType, options = {} } = req.body;

  if (!operationType) return err(res, '缺少 operationType');

  const logs = [];
  try {
    const service = getService();
    const result = await service.execute(
      accountId,
      operationType,
      options,
      (msg) => logs.push(msg)
    );
    ok(res, { result, logs });
  } catch (e) {
    ok(res, { result: null, error: e.message, logs });
  }
});

// GET /api/accounts/:id/source-records
router.get('/:id/source-records', (req, res) => {
  try {
    const records = getService().getStoredSourceRecords(parseInt(req.params.id, 10));
    ok(res, records);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// GET /api/accounts/:id/messages
router.get('/:id/messages', (req, res) => {
  try {
    const messages = getService().getStoredMessages(parseInt(req.params.id, 10));
    ok(res, messages);
  } catch (e) {
    err(res, e.message, 500);
  }
});

module.exports = router;
