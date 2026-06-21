'use strict';

const crypto        = require('crypto');
const HttpClient    = require('./HttpClient');
const ProxyAgentWrapper = require('./ProxyAgentWrapper');
const CryptoManager = require('./CryptoManager');
const C             = require('./constants');

function _uuid(uppercase = true) {
  const u = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  return uppercase ? u.toUpperCase() : u;
}

function _s456hr8(deviceId) {
  return crypto.createHash('md5').update(deviceId + C.S456HR8_SALT).digest('hex');
}

/**
 * App 端注册服务（3 步流程）
 * 1. createSession(platform, proxy) → { sessionId, deviceId }
 * 2. getCaptcha(sessionId) → base64 PNG
 * 3. sendSms(sessionId, mobileNo, picVerifyCode)
 * 4. register(sessionId, mobileNo, smsCode, password)
 */
class RegisterService {
  constructor() {
    this.cryptoManager = new CryptoManager();
    this.sessions = new Map();
  }

  /**
   * 创建注册会话
   * @param {'ios'|'android'} platform
   * @param {{ id?, host, port, username, password }|null} proxy
   */
  createSession(platform = 'ios', proxy = null, userAgentOverride = null) {
    const sessionId = _uuid(false);
    const isAndroid = platform === 'android';
    const deviceId  = _uuid(!isAndroid);
    const s456hr8   = _s456hr8(deviceId);
    // UA 由调用方（routes/register.js）从 UA 池抽好后通过 override 传入；
    // 这里的 fallback 仅在直接被其他代码调用时兜底，正常路径不会用到。
    const userAgent = userAgentOverride || (isAndroid ? C.DEFAULT_UA.android : C.DEFAULT_UA.app);
    const agent     = proxy ? new ProxyAgentWrapper(proxy, true) : null;
    const proxyId   = proxy?.id ?? null;

    this.sessions.set(sessionId, { platform, deviceId, s456hr8, userAgent, cookie: null, proxy, proxyId, agent });
    return { sessionId, deviceId };
  }

  /**
   * 第一步：获取图片验证码，返回 base64 PNG
   */
  async getCaptcha(sessionId) {
    const session = this._getSession(sessionId);
    const ts  = Date.now();
    const url = `${C.BASE_URL}/mobile-web/support.image.verify.hsr?deviceId=${session.deviceId}&type=REGISTER&hospitalId=0&time=${ts}`;

    const headers = {
      'Host': 'hlwyl.gamyy.cn',
      'Accept': 'image/webp,image/avif,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      'User-Agent': session.userAgent,
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'Connection': 'keep-alive',
    };

    const { buf, response } = await this._request('GET', url, headers, null, session);

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      session.cookie = header.split(';')[0].trim();
    }

    return buf.toString('base64');
  }

  /**
   * 第二步：发送短信验证码
   */
  async sendSms(sessionId, mobileNo, picVerifyCode) {
    const session = this._getSession(sessionId);
    return this._postEncrypted(
      `${C.BASE_URL}/mobile-web/account.register.user.verifycode.hsr`,
      { mobileNo, picVerifyCode, deviceId: session.deviceId, from: 0, hospitalId: C.HOSPITAL_ID },
      session
    );
  }

  /**
   * 第三步：注册账号
   */
  async register(sessionId, mobileNo, verifyCode, password) {
    const session = this._getSession(sessionId);
    const platformCode = session.platform === 'android' ? '1' : '2';
    return this._postEncrypted(
      `${C.BASE_URL}/mobile-web/account.register.user.hsr`,
      {
        param: { mobileNo, password, confirmPassword: password, verifyCode, platform: platformCode, deviceId: session.deviceId },
        hospitalId: C.HOSPITAL_ID
      },
      session
    );
  }

  getSession(sessionId) { return this.sessions.get(sessionId); }

  removeSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s?.agent) s.agent.destroy();
    this.sessions.delete(sessionId);
  }

  // ── private ──────────────────────────────────────────────────

  _getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('注册会话不存在或已过期');
    return s;
  }

  async _postEncrypted(url, params, session) {
    const plain     = JSON.stringify(params);
    const encrypted = this.cryptoManager.encryptData(plain);
    const body      = Buffer.from(encrypted, 'utf8');

    const headers = {
      'Host': 'hlwyl.gamyy.cn',
      'Accept': '*/*',
      'from': '0',
      'hospitalId': C.HOSPITAL_ID,
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      's456hr8': session.s456hr8,
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'User-Agent': session.userAgent,
      'SubmitSign': '',
      'Connection': 'keep-alive',
      ...(session.cookie ? { 'Cookie': session.cookie } : {})
    };

    const { buf, response } = await this._request('POST', url, headers, body, session);

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      session.cookie = header.split(';')[0].trim();
    }

    const text = buf.toString('utf8');
    try {
      const dec = this.cryptoManager.decryptData(text);
      if (dec) return JSON.parse(dec);
    } catch (_) {}
    try { return JSON.parse(text); } catch (_) {}
    throw new Error(`无法解析响应: ${text.substring(0, 120)}`);
  }

  async _request(method, url, headers, body, session) {
    if (!session.agent) throw new Error('注册操作需要代理，请先分配代理');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const response = await HttpClient.request(url, {
        method, headers, body,
        agent: session.agent,
        signal: ctrl.signal,
        timeout: 15000,
      });
      const buf = await response.buffer();
      return { buf, response };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = RegisterService;
