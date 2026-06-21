'use strict';

const crypto = require('crypto');
const C      = require('./constants');

const MOBILE_PREFIXES = [
  '130','131','132','133','134','135','136','137','138','139',
  '150','151','152','153','155','156','157','158','159',
  '180','181','182','183','184','185','186','187','188','189'
];

class AccountCreator {

  static _uuid(uppercase = true) {
    const u = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    return uppercase ? u.toUpperCase() : u;
  }

  static _s456hr8(deviceId) {
    return crypto.createHash('md5').update(deviceId + C.S456HR8_SALT).digest('hex');
  }

  static _mobile() {
    const p = MOBILE_PREFIXES[Math.floor(Math.random() * MOBILE_PREFIXES.length)];
    return p + Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  }

  static _openId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    return 'oVlNd5Ug7UONLNcw8zwU9q' + Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  }

  static _now() {
    return new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  }

  /**
   * 从 system_config 读取每端的"最新基线 + 固定参数" + UA 池。
   * 池为空时回退到 constants 中的种子池（确保任何环境下建账号都能拿到 UA）。
   */
  static _getClientBaseline(db) {
    const empty = { app: C.APP_CONFIG, android: C.ANDROID_CONFIG, wechat: C.WECHAT_CONFIG };
    try {
      const row = db.prepare(`
        SELECT app_client_config, android_client_config, wechat_client_config,
               app_ua_pool, android_ua_pool, wechat_ua_pool
        FROM system_config WHERE id = 1
      `).get();
      if (!row) return { cfg: empty, pools: { app: C.APP_UA_POOL, android: C.ANDROID_UA_POOL, wechat: C.WECHAT_UA_POOL } };
      const parse = (v, def) => { try { const o = JSON.parse(v || '{}'); return { ...def, ...o }; } catch { return def; } };
      const parseArr = (v, def) => {
        try { const a = JSON.parse(v || '[]'); return Array.isArray(a) && a.length > 0 ? a : def; }
        catch { return def; }
      };
      return {
        cfg: {
          app:     parse(row.app_client_config,     C.APP_CONFIG),
          android: parse(row.android_client_config, C.ANDROID_CONFIG),
          wechat:  parse(row.wechat_client_config,  C.WECHAT_CONFIG),
        },
        pools: {
          app:     parseArr(row.app_ua_pool,     C.APP_UA_POOL),
          android: parseArr(row.android_ua_pool, C.ANDROID_UA_POOL),
          wechat:  parseArr(row.wechat_ua_pool,  C.WECHAT_UA_POOL),
        },
      };
    } catch {
      return { cfg: empty, pools: { app: C.APP_UA_POOL, android: C.ANDROID_UA_POOL, wechat: C.WECHAT_UA_POOL } };
    }
  }

  static _pickUA(pool) {
    if (!Array.isArray(pool) || pool.length === 0) throw new Error('UA 池为空，请先在系统配置中添加 UA');
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * 在 gamyy-core 的 configDb 中批量生成账号
   */
  static generate(configDb, accountType, { count = 1, platform = 'ios' } = {}) {
    const db = configDb;
    const results = { success: 0, fail: 0, accounts: [] };

    const sys = db.prepare('SELECT default_proxy_max_count FROM system_config WHERE id = 1').get();
    const proxyMaxCount = sys?.default_proxy_max_count ?? 10;
    const { cfg, pools } = this._getClientBaseline(db);

    for (let i = 0; i < count; i++) {
      try {
        const account = db.transaction(() => {
          let mobile, tries = 0;
          do {
            mobile = this._mobile();
            if (++tries > 30) throw new Error('无法生成唯一手机号');
          } while (db.prepare('SELECT id FROM accounts WHERE mobile = ?').get(mobile));

          const now = this._now();

          if (accountType === 'wechat') {
            const deviceId = this._uuid(true);
            const uuid     = this._uuid(true);
            const s456hr8  = this._s456hr8(deviceId);

            let openId, oidTries = 0;
            do {
              openId = this._openId();
              if (++oidTries > 30) throw new Error('无法生成唯一 openId');
            } while (db.prepare('SELECT id FROM accounts WHERE open_id = ?').get(openId));

            const accRow = db.prepare(
              `INSERT INTO accounts (mobile, open_id, account_type, account_platform, proxy_max_count, status, created_at, updated_at)
               VALUES (?, ?, 'wechat', 'android', ?, 'pending', ?, ?)`
            ).run(mobile, openId, proxyMaxCount, now, now);

            const accountId = accRow.lastInsertRowid;
            const ua        = this._pickUA(pools.wechat);
            const referer   = cfg.wechat.REFERER || null;
            const clientVer = cfg.wechat.CLIENT_VERSION || null;
            db.prepare(
              `INSERT INTO account_devices (account_id, device_id, uuid, s456hr8, user_agent, referer, client_version, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(accountId, deviceId, uuid, s456hr8, ua, referer, clientVer, now);

            return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);

          } else {
            const isAndroid = platform === 'android';
            const deviceId  = this._uuid(!isAndroid);
            const s456hr8   = this._s456hr8(deviceId);
            const ua        = this._pickUA(isAndroid ? pools.android : pools.app);
            const clientVer = (isAndroid ? cfg.android.CLIENT_VERSION : cfg.app.CLIENT_VERSION) || null;
            const accPlatform = isAndroid ? 'android' : 'ios';

            const accRow = db.prepare(
              `INSERT INTO accounts (mobile, password, account_type, account_platform, proxy_max_count, status, created_at, updated_at)
               VALUES (?, ?, 'app', ?, ?, 'pending', ?, ?)`
            ).run(mobile, 'abc123456', accPlatform, proxyMaxCount, now, now);

            const accountId = accRow.lastInsertRowid;
            db.prepare(
              `INSERT INTO account_devices (account_id, device_id, s456hr8, user_agent, client_version, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).run(accountId, deviceId, s456hr8, ua, clientVer, now);

            return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
          }
        })();

        results.success++;
        results.accounts.push({ id: account.id, mobile_no: account.mobile });
      } catch (e) {
        results.fail++;
        console.warn(`⚠️ 生成账号失败 [${i + 1}/${count}]: ${e.message}`);
      }
    }

    return results;
  }
}

module.exports = AccountCreator;
