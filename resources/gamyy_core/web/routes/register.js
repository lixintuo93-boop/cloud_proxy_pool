'use strict';

const { Router } = require('express');
const { getDb, ok, err } = require('./_helper');
const RegisterService = require('../../account/RegisterService');
const AccountCreator  = require('../../account/AccountCreator');
const { autoAssign }  = require('./proxies');
const C               = require('../../account/constants');

const router = Router();
const svc = new RegisterService();

// ── 获取代理（供注册流程使用）─────────────────────────────────
// 规则：从"操作代理"池（ops_enabled=1）里挑一个非 direct 代理，
// 按"已被绑定为 ops 代理的账号数"升序，相同则随机 tie-break，做负载均衡。
// 注册流程必须走代理（RegisterService._request 强校验 agent），所以排除 direct。
function _pickProxy(db) {
  // 注册流程强制走 SOCKS5（_request 严格校验 agent），所以排除 direct 与仅云端 SSH（无本地端口）
  const row = db.prepare(`
    SELECT p.*, COUNT(a.id) AS usage_count
    FROM proxies p
    LEFT JOIN accounts a ON a.ops_proxy_id = p.id
    WHERE p.ops_enabled = 1 AND p.proxy_type != 'direct' AND p.port IS NOT NULL
    GROUP BY p.id
    ORDER BY usage_count ASC, RANDOM()
    LIMIT 1
  `).get();
  if (!row) return null;
  return {
    id:       row.id,
    host:     row.host,
    port:     row.port,
    username: row.username,
    password: row.password,
  };
}

// POST /api/register/session
// body: { platform: 'ios'|'android' }
// 返回 { sessionId, deviceId }
router.post('/session', (req, res) => {
  try {
    const { platform = 'ios' } = req.body;
    if (!['ios', 'android'].includes(platform)) return err(res, '无效的 platform');
    const db = getDb();
    const proxy = _pickProxy(db);
    if (!proxy) return err(res, '暂无可用的操作代理，请先在代理池中启用至少一个非直连的操作代理（ops_enabled = 1）');
    // 从对应端 UA 池随机抽 1 条；池为空时 fallback 到 constants 里的种子池
    const sys = db.prepare('SELECT app_ua_pool, android_ua_pool FROM system_config WHERE id = 1').get() || {};
    const parsePool = (v, seed) => {
      try { const a = JSON.parse(v || '[]'); return Array.isArray(a) && a.length > 0 ? a : seed; }
      catch { return seed; }
    };
    const pool = platform === 'android'
      ? parsePool(sys.android_ua_pool, C.ANDROID_UA_POOL)
      : parsePool(sys.app_ua_pool,     C.APP_UA_POOL);
    const ua = pool[Math.floor(Math.random() * pool.length)];
    const result = svc.createSession(platform, proxy, ua);
    ok(res, result);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// GET /api/register/captcha/:sessionId
// 返回 base64 PNG 图片
router.get('/captcha/:sessionId', async (req, res) => {
  try {
    const img = await svc.getCaptcha(req.params.sessionId);
    ok(res, { image: img });
  } catch (e) {
    err(res, e.message, 500);
  }
});

// POST /api/register/send-sms
// body: { sessionId, mobileNo, picVerifyCode }
router.post('/send-sms', async (req, res) => {
  try {
    const { sessionId, mobileNo, picVerifyCode } = req.body;
    if (!sessionId || !mobileNo || !picVerifyCode) return err(res, '缺少参数');
    const result = await svc.sendSms(sessionId, mobileNo, picVerifyCode);
    ok(res, result);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// POST /api/register/submit
// body: { sessionId, mobileNo, verifyCode, password }
// 注册成功后自动写入 gamyy-core accounts + account_devices 表
router.post('/submit', async (req, res) => {
  try {
    const { sessionId, mobileNo, verifyCode, password, remark } = req.body;
    if (!sessionId || !mobileNo || !verifyCode || !password) return err(res, '缺少参数');
    if (remark != null && typeof remark === 'string' && remark.length > 200) return err(res, '备注长度不能超过200字');

    const result = await svc.register(sessionId, mobileNo, verifyCode, password);

    if (result && result.code === 0) {
      // 注册成功：把设备/账号信息写入本地 DB
      const session = svc.getSession(sessionId);
      if (session) {
        const db = getDb();
        const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
        const sys = db.prepare('SELECT default_proxy_max_count, app_client_config, android_client_config FROM system_config WHERE id = 1').get();
        const proxyMaxCount = sys?.default_proxy_max_count ?? 10;
        const parseCfg = (v, def) => { try { const o = JSON.parse(v || '{}'); return { ...def, ...o }; } catch { return def; } };
        const clientVer = session.platform === 'android'
          ? parseCfg(sys?.android_client_config, C.ANDROID_CONFIG).CLIENT_VERSION
          : parseCfg(sys?.app_client_config,     C.APP_CONFIG).CLIENT_VERSION;
        const savedAccountId = db.transaction(() => {
          // 写入账号（ON CONFLICT 老账号也要覆盖 ops_proxy_id，使其与本次注册用的代理一致）
          const accRow = db.prepare(
            `INSERT INTO accounts (mobile, password, account_type, account_platform, proxy_max_count, status, ops_proxy_id, remark, created_at, updated_at)
             VALUES (?, ?, 'app', ?, ?, 'pending', ?, ?, ?, ?)
             ON CONFLICT(mobile) DO UPDATE SET
               password         = excluded.password,
               account_platform = excluded.account_platform,
               ops_proxy_id     = excluded.ops_proxy_id,
               remark           = excluded.remark,
               updated_at       = excluded.updated_at`
          ).run(mobileNo, password, session.platform, proxyMaxCount, session.proxyId ?? null, remark ?? null, now, now);

          const accountId = accRow.lastInsertRowid || db.prepare(
            'SELECT id FROM accounts WHERE mobile = ?'
          ).get(mobileNo)?.id;

          if (accountId) {
            db.prepare(
              `INSERT INTO account_devices (account_id, device_id, s456hr8, user_agent, client_version, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_id) DO NOTHING`
            ).run(accountId, session.deviceId, session.s456hr8, session.userAgent, clientVer ?? null, now);
          }
          return accountId;
        })();
        if (savedAccountId) {
          const fullAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(savedAccountId);
          if (fullAccount) autoAssign(db, fullAccount, false);
        }
      }
      svc.removeSession(sessionId);
    }

    ok(res, result);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// DELETE /api/register/session/:sessionId  — 取消注册，清理会话
router.delete('/session/:sessionId', (req, res) => {
  svc.removeSession(req.params.sessionId);
  ok(res, { cancelled: true });
});

module.exports = router;
