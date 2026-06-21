'use strict';

const BaseAPI = require('./BaseAPI');
const { DEFAULT_HEADERS } = require('./HeadersConfig');

class AppManageAPI extends BaseAPI {
  buildHeaders() {
    const platform = this.session.getPlatform();
    const H = this.session.headers || DEFAULT_HEADERS;
    let template;
    if (platform === 'wechat')       template = H.HLWYY_MANAGE_WX;
    else if (platform === 'android') template = H.HLWYY_MANAGE_ANDROID;
    else                             template = H.HLWYY_MANAGE;
    const headers = { ...template, 's456hr8': this.session.getS456hr8() };

    headers['SubmitSign'] = this.session.getSubmitSign() || '';

    const token = this.session.getAuthToken();
    if (token) headers['token'] = token;
    else if (platform === 'android') delete headers['token'];

    return headers;
  }

  updateSessionFromResponse() {}

  async processResponse(response, buf) {
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (_) { return { raw: text }; }
  }
}

module.exports = AppManageAPI;
