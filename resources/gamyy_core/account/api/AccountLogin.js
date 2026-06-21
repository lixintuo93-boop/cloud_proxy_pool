'use strict';

const MobileWebAPI = require('../MobileWebAPI');
const C = require('../constants');

class AccountLogin extends MobileWebAPI {
  constructor(session) {
    super(session, { timeout: 15000 });
  }

  buildHeaders() {
    const headers = super.buildHeaders();
    // 登录请求不携带 token
    delete headers['token'];
    headers['SubmitSign'] = this.session.getSubmitSign() || '';
    return headers;
  }

  async execute(credentials = {}) {
    // 已登录且不强制重新登录则跳过
    if (!credentials.forceRelogin && this.session.sessionData?.auth_token) {
      this.session._log(`账号 ${this.session.account.mobile} 已登录，跳过`);
      return {
        code: 0, msg: '已登录',
        value: { id: this.session.getHospitalAccountId() || 0, mobile: this.session.account.mobile }
      };
    }

    const isWx = this.session.accountType === 'wechat';
    this.url = `${this.baseURL}${isWx ? '/mobile-web/account.weixin.login.hsr' : '/mobile-web/account.login.hsr'}`;

    // 登录前先把账号身份刷到最新基线：
    //   - 三端通用：client_version 若与 system_config 最新基线不一致就改写
    //   - 微信端额外：referer 同步刷新
    //   - UA 不动（按账号一辈子固定）
    // 这样下面的登录请求会用新版本（和新 referer）发出，而不是先旧后新两步走。
    // 失败时把错误打出来——不再静默吞掉。
    try {
      const r = await this.session.refreshIdentityToBaseline();
      if (r.changed) {
        const parts = [];
        if (r.to.client_version) parts.push(`client_version: ${r.from.client_version || '<空>'} → ${r.to.client_version}`);
        if (r.to.referer)        parts.push(`referer 已同步更新`);
        this.session._log(`登录前应用最新基线（${parts.join('；')}）`);
      }
    } catch (e) {
      this.session._log(`⚠️ 基线刷新失败，本次登录按账号 snapshot 继续: ${e.message}`);
    }

    const { MAX_ATTEMPTS, BASE_DELAY, MAX_DELAY } = C.LOGIN_RETRY;
    let lastErr;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        this.session._log(`登录尝试 ${attempt}/${MAX_ATTEMPTS}`);

        // clientVer 取该账号当前 snapshot（上面已经刷过基线，所以就是最新值）；
        // device 极端情况下没有 client_version 时回退 system_config 基线 → constants 默认。
        const snappedVer = this.session.getClientVersion();
        let params;
        if (isWx) {
          const wxCfg = { ...C.WECHAT_CONFIG, ...(this.session.clientCfg?.wechat || {}) };
          params = {
            openId:     credentials.openId || this.session.getOpenId(),
            mobileNo:   this.session.account.mobile,
            origin:     wxCfg.ORIGIN,
            clientVer:  snappedVer || wxCfg.CLIENT_VERSION,
            hospitalId: C.HOSPITAL_ID
          };
        } else {
          const isAndroid = this.session.getPlatform() === 'android';
          const base = isAndroid ? C.ANDROID_CONFIG : C.APP_CONFIG;
          const over = isAndroid ? (this.session.clientCfg?.android || {}) : (this.session.clientCfg?.app || {});
          const cfg  = { ...base, ...over };
          const clientVer = snappedVer || cfg.CLIENT_VERSION;
          if (isAndroid) {
            params = {
              clientVer,
              mobileNo:   this.session.account.mobile,
              password:   credentials.password || this.session.getPassword(),
              platform:   cfg.PLATFORM,
              deviceId:   this.session.getDeviceId(),
              hospitalId: C.HOSPITAL_ID
            };
          } else {
            params = {
              mobileNo:   this.session.account.mobile,
              password:   credentials.password || this.session.getPassword(),
              platform:   cfg.PLATFORM,
              deviceId:   this.session.getDeviceId(),
              hospitalId: C.HOSPITAL_ID,
              clientVer
            };
          }
        }

        const result = await this.executeEncrypted(params);

        if (result && result.code === 0) {
          await this.session.saveSession({
            authToken:          result.value.token,
            submitSign:         this.session.getSubmitSign() || '',
            cookieYizhu4Gam:    this.session.getCookie('yizhu4_gam') || '',
            cookieMobileManage: this.session.getCookie('mobile_manage') || '',
            patientInfo:        result.value
          });
          this.session._log(`登录成功`);
          return result;
        }

        const msg = result ? `${result.msg} (code: ${result.code})` : '未知错误';
        this.session._log(`登录失败: ${msg}`);

        if (attempt < MAX_ATTEMPTS) {
          const delay = Math.min(BASE_DELAY * Math.pow(2, attempt - 1), MAX_DELAY);
          await new Promise(r => setTimeout(r, delay));
        }
        lastErr = new Error(msg);
      } catch (e) {
        this.session._log(`登录异常: ${e.message}`);
        if (attempt < MAX_ATTEMPTS) {
          const delay = Math.min(BASE_DELAY * Math.pow(2, attempt - 1), MAX_DELAY);
          await new Promise(r => setTimeout(r, delay));
        }
        lastErr = e;
      }
    }

    throw lastErr || new Error('登录失败');
  }
}

module.exports = AccountLogin;
