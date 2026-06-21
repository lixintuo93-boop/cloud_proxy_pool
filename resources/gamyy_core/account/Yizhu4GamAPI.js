'use strict';

const BaseAPI = require('./BaseAPI');
const { DEFAULT_HEADERS } = require('./HeadersConfig');

class Yizhu4GamAPI extends BaseAPI {
  buildHeaders() {
    const platform = this.session.getPlatform();
    const H = this.session.headers || DEFAULT_HEADERS;
    let template;
    if (platform === 'wechat')       template = H.YIZHU4_GAM_WX;
    else if (platform === 'android') template = H.YIZHU4_GAM_ANDROID;
    else                             template = H.YIZHU4_GAM;

    const headers = { ...template, 's456hr8': this.session.getS456hr8() };

    const token = this.session.getAuthToken();
    if (token) headers['token'] = token;
    else if (platform === 'android') delete headers['token'];

    headers['SubmitSign'] = this.session.getSubmitSign() || '';

    if (platform !== 'wechat') {
      const full = this.session.getCookie('yizhu4_gam');
      headers['Cookie'] = full ? full.split(';')[0].trim() : '';
    }

    return headers;
  }

  updateSessionFromResponse(response) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const full = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (full && typeof full === 'string') {
        this.session.setCookie('yizhu4_gam', full);
        this.session.updateCookie('yizhu4_gam', full).catch(() => {});
      }
    }
  }

  async processResponse(response, buf) {
    this.updateSessionFromResponse(response);
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (_) { return { raw: text }; }
  }
}

module.exports = Yizhu4GamAPI;
