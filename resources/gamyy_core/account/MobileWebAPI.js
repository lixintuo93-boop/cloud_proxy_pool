'use strict';

const BaseAPI       = require('./BaseAPI');
const { DEFAULT_HEADERS } = require('./HeadersConfig');
const CryptoManager = require('./CryptoManager');
const C             = require('./constants');

class MobileWebAPI extends BaseAPI {
  constructor(session, config = {}) {
    super(session, config);
    this.cryptoManager = new CryptoManager();
  }

  buildHeaders() {
    const platform = this.session.getPlatform(); // 'ios' | 'android' | 'wechat'

    const H = this.session.headers || DEFAULT_HEADERS;
    let template;
    if (platform === 'wechat')      template = H.MOBILE_WEB_WX;
    else if (platform === 'android') template = H.MOBILE_WEB_ANDROID;
    else                             template = H.MOBILE_WEB;

    const headers = { ...template, 's456hr8': this.session.getS456hr8() };

    const token = this.session.getAuthToken();
    if (token) {
      headers['token'] = token;
    } else if (platform === 'android') {
      delete headers['token'];
    }

    headers['SubmitSign'] = this.session.getSubmitSign() || '';

    // App 端携带 Cookie
    if (platform !== 'wechat') {
      const fullCookie = this.session.getCookie('mobile_manage');
      headers['Cookie'] = this._extractCookieValue(fullCookie);
    }

    return headers;
  }

  _extractCookieValue(full) {
    if (!full || typeof full !== 'string') return '';
    return full.split(';')[0].trim();
  }

  updateSessionFromResponse(response) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const full = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (full && typeof full === 'string') {
        this.session.setCookie('mobile_manage', full);
        this.session.updateCookie('mobile_manage', full).catch(() => {});
      }
    }

    const sign = response.headers.get('submitsign');
    if (sign) {
      const s = String(sign);
      this.session.setSubmitSign(s);
      this.session.updateSubmitSign(s).catch(() => {});
    }
  }

  async executeEncrypted(params, options = {}) {
    const plain     = JSON.stringify(params);
    const encrypted = this.cryptoManager.encryptData(plain);
    return await this.request(this.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: encrypted,
      _plainRequestBody: plain,
      ...options
    });
  }

  async processResponse(response, buf, logData) {
    this.updateSessionFromResponse(response);
    const text = buf.toString('utf8');
    try {
      const dec = this.cryptoManager.decryptData(text);
      if (!dec) throw new Error('解密返回空值');
      try {
        const obj = JSON.parse(dec);
        if (C.RELOGIN_REQUIRED_CODES.includes(obj.code)) {
          const e = new Error('SESSION_INVALID');
          e.code = obj.code;
          e.accountId = this.session.account?.id;
          e.mobileNo  = this.session.account?.mobile;
          throw e;
        }
        return obj;
      } catch (je) {
        if (je.message === 'SESSION_INVALID') throw je;
        const cleaned = dec.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
        return JSON.parse(cleaned);
      }
    } catch (decErr) {
      if (decErr.message === 'SESSION_INVALID') throw decErr;
      try { return JSON.parse(text); } catch (_) {
        return { error: '解密和解析均失败', decryptError: decErr.message };
      }
    }
  }
}

module.exports = MobileWebAPI;
