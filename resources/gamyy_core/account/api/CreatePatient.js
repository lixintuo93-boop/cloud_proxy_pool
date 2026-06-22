'use strict';

const BaseAPI  = require('../BaseAPI');
const { DEFAULT_HEADERS } = require('../HeadersConfig');
const C        = require('../constants');

/**
 * POST /data-transfor/createPatient — 建档（plain JSON, NOT AES-encrypted）
 *
 * Params: { cardNo, patientName, sex: '男'|'女', birthday: 'YYYY-MM-DD', mobile }
 */
class CreatePatient extends BaseAPI {
  constructor(session, config = {}) {
    super(session, { timeout: 15000, ...config });
    this.url = `${C.BASE_URL}/data-transfor/createPatient`;
  }

  buildHeaders() {
    const platform = this.session.getPlatform();
    const H = this.session.headers || DEFAULT_HEADERS;
    let template;
    if (platform === 'wechat')       template = H.MOBILE_WEB_WX;
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
    if (platform !== 'wechat') {
      const full = this.session.getCookie('mobile_manage');
      headers['Cookie'] = full ? full.split(';')[0].trim() : '';
    }
    return headers;
  }

  updateSessionFromResponse(response) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const full = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (full) {
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

  async processResponse(response, buf) {
    this.updateSessionFromResponse(response);
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (_) {
      return { code: -1, msg: '响应解析失败', raw: text.substring(0, 120) };
    }
  }

  async execute({ cardNo, patientName, sex, birthday, mobile }) {
    const params = {
      cardType:   'IDENTITY_CARD',
      cardNo,
      patientName,
      sex,          // '男' | '女'
      birthday,     // YYYY-MM-DD
      mobile,
      chargeType: '自费',
      hospitalId: C.HOSPITAL_ID,
    };

    const result = await this.request(this.url, {
      method:  'POST',
      headers: this.buildHeaders(),
      body:    JSON.stringify(params),
    });

    if (result && result.code === 0)
      this.session._log(`建档成功: ${patientName}`);
    else
      this.session._log(`建档失败: ${result?.msg || '未知错误'}`);

    return result;
  }
}

module.exports = CreatePatient;
