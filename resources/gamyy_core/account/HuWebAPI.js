'use strict';

const BaseAPI = require('./BaseAPI');
const { DEFAULT_HEADERS } = require('./HeadersConfig');

class HuWebAPI extends BaseAPI {
  buildHeaders() {
    const platform = this.session.getPlatform();
    const H = this.session.headers || DEFAULT_HEADERS;
    let template;
    if (platform === 'wechat')       template = H.HU_WEB_WX;
    else if (platform === 'android') template = H.HU_WEB_ANDROID;
    else                             template = H.HU_WEB;
    const headers = { ...template, 's456hr8': this.session.getS456hr8() };

    const token = this.session.getAuthToken();
    if (token) headers['token'] = token;
    else if (platform === 'android') delete headers['token'];

    const sign = this.session.getSubmitSign();
    if (sign) headers['SubmitSign'] = sign;

    if (platform !== 'android' && platform !== 'wechat') {
      const full = this.session.getCookie('mobile_manage');
      headers['Cookie'] = full ? full.split(';')[0].trim() : '';
    }

    return headers;
  }

  async processResponse(response, buf) {
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (_) { return { raw: text }; }
  }
}

module.exports = HuWebAPI;
