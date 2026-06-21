'use strict';

const ProxyAgentWrapper = require('./ProxyAgentWrapper');
const { buildHeaderTemplates, DEFAULT_HEADERS } = require('./HeadersConfig');
const C = require('./constants');

/**
 * 单次操作的会话管理器
 *
 * 客户端身份模型（重要）：
 *   - 真实身份字段（UA / client_version / referer）都从 account_devices 取，按账号
 *     独立。建账号时从 UA 池抽取并固化，永不重抽。
 *   - 平台固定参数（FROM / PLATFORM / ORIGIN）和最新版本基线 (CLIENT_VERSION) 来自
 *     system_config，按 account.account_platform / account_type 选对应那一组。
 *   - 登录成功后由 refreshIdentityToBaseline() 把账号的 client_version（微信端含
 *     referer）刷到最新基线；UA 不动。
 */
class SessionManager {
  constructor(account, adb, accountType = 'app') {
    this.account     = account;
    this.adb         = adb;
    this.accountType = accountType;

    this.sessionData    = null;
    this.patients       = [];
    this.device         = null;
    this.accountDetails = null;
    this.currentProxy   = null;
    this.proxyAgent     = null;
    this.isLoggedIn     = false;
    this.isInitialized  = false;

    // header 模板与客户端配置由 AccountOperationService 注入；构建实际 headers 在
    // initialize() 加载完 device 后再做（_rebuildHeaders）
    this.headers   = DEFAULT_HEADERS;
    this.clientCfg = {
      app:     { ...C.APP_CONFIG },
      android: { ...C.ANDROID_CONFIG },
      wechat:  { ...C.WECHAT_CONFIG },
    };

    this._logLines = [];
  }

  async initialize(proxy = null) {
    try {
      this.device = this.adb.findDeviceByAccountId(this.account.id);
      if (!this.device) throw new Error(`账号 ${this.account.id} 无设备记录`);

      if (proxy) await this.setProxy(proxy);

      await this.loadSession();
      await this.loadAccountDetails();
      // device 已加载，把 headers 用账号自己的 UA / referer 重建一遍
      this._rebuildHeaders();
      this.isInitialized = true;
      return true;
    } catch (e) {
      console.error(`❌ [${this.account.mobile}] 初始化失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 注入系统级客户端配置（每端的 CLIENT_VERSION/FROM/PLATFORM/ORIGIN/REFERER）。
   * 注意：USER_AGENT 不再从这里读，已迁到 account_devices.user_agent。
   * 调用时机：在 initialize() 之前调用安全；device 未加载时只是先存值，
   *           真正生成 headers 会推迟到 initialize() 里的 _rebuildHeaders。
   */
  setClientConfig(appCfg, androidCfg, wechatCfg) {
    this.clientCfg = {
      app:     { ...C.APP_CONFIG,     ...(appCfg     || {}) },
      android: { ...C.ANDROID_CONFIG, ...(androidCfg || {}) },
      wechat:  { ...C.WECHAT_CONFIG,  ...(wechatCfg  || {}) },
    };
    this._rebuildHeaders();
  }

  _rebuildHeaders() {
    const platform = this.getPlatform();
    const fixed = platform === 'wechat' ? this.clientCfg.wechat
                : platform === 'android' ? this.clientCfg.android
                : this.clientCfg.app;

    const uaFallback =
      platform === 'wechat'  ? C.DEFAULT_UA.wechat  :
      platform === 'android' ? C.DEFAULT_UA.android :
                                C.DEFAULT_UA.app;
    const userAgent = this.device?.user_agent || uaFallback;
    const referer   = platform === 'wechat'
      ? (this.device?.referer || fixed.REFERER || '')
      : null;

    this.headers = buildHeaderTemplates({
      platform,
      userAgent,
      referer,
      from:       fixed.FROM,
      hospitalId: C.HOSPITAL_ID,
    });
  }

  async setProxy(proxy) {
    if (!proxy) throw new Error('代理不能为空');
    if (this.proxyAgent) this.proxyAgent.destroy();
    this.currentProxy = proxy;
    this.proxyAgent = proxy.type === 'direct' ? null : new ProxyAgentWrapper(proxy, true);
  }

  // ── 会话加载 / 保存 ───────────────────────────────────────────
  async loadSession() {
    this.sessionData = this.adb.findSessionByAccountId(this.account.id);
    this.patients    = this.adb.findPatientsByAccountId(this.account.id);
    this.isLoggedIn  = !!this.sessionData?.auth_token;
    return this.sessionData;
  }

  async saveSession(sessionInfo) {
    const { authToken, submitSign, cookieYizhu4Gam, cookieMobileManage, patientInfo } = sessionInfo;

    this.sessionData = this.adb.createOrUpdateSession({
      accountId: this.account.id, authToken, submitSign, cookieYizhu4Gam, cookieMobileManage
    });

    if (patientInfo) {
      this._saveAccountDetails(patientInfo);
      this._syncPatients(patientInfo);
    }

    this.adb.updateAccountStatus(this.account.id, 'active');

    this.isLoggedIn = true;
    return this.sessionData;
  }

  /**
   * 登录成功后调用：若账号当前 client_version 与最新基线不一致，刷为最新；
   * 微信端 referer 同步更新。UA 不动（每账号一辈子不换）。
   * 返回 { changed, from, to }。
   */
  async refreshIdentityToBaseline() {
    const platform = this.getPlatform();
    const fixed = platform === 'wechat' ? this.clientCfg.wechat
                : platform === 'android' ? this.clientCfg.android
                : this.clientCfg.app;

    const latestVer  = fixed.CLIENT_VERSION || null;
    const latestRef  = platform === 'wechat' ? (fixed.REFERER || null) : null;
    const curVer     = this.device?.client_version || null;
    const curRef     = this.device?.referer        || null;

    const versionDrifted = latestVer && latestVer !== curVer;
    const refererDrifted = platform === 'wechat' && latestRef && latestRef !== curRef;
    if (!versionDrifted && !refererDrifted) return { changed: false };

    const updates = {};
    if (versionDrifted) updates.client_version = latestVer;
    if (refererDrifted) updates.referer        = latestRef;

    this.adb.updateDeviceIdentity(this.account.id, updates);
    this.device = this.adb.findDeviceByAccountId(this.account.id);
    this._rebuildHeaders();

    const parts = [];
    if (versionDrifted) parts.push(`版本 ${curVer || '<空>'} → ${latestVer}`);
    if (refererDrifted) parts.push(`referer 同步更新`);
    this._log(`客户端身份基线刷新：${parts.join('，')}`);
    return { changed: true, from: { client_version: curVer, referer: curRef }, to: updates };
  }

  _saveAccountDetails(data) {
    try {
      this.adb.saveAccountDetails({
        accountId:         this.account.id,
        hospitalAccountId: data.id,
        mobile:            data.mobile,
        deviceId:          data.deviceId,
        familyId:          data.familyId,
        lastLoginIp:       data.lastLoginIp,
        lastLoginTime:     data.lastLoginTime,
        loginTimes:        data.loginTimes,
        openId:            data.openId,
        platform:          this.account.account_platform || data.platForm,
        token:             data.token,
        unionId:           data.unionId
      });
      this.accountDetails = this.adb.findAccountDetailByAccountId(this.account.id);
    } catch (_) {}
  }

  _syncPatients(patientInfo) {
    const serverList = patientInfo.patientVoList?.length
      ? patientInfo.patientVoList
      : patientInfo.defaultPatient
        ? [patientInfo.defaultPatient]
        : [];
    if (serverList.length === 0) return;

    const serverMap = new Map(serverList.map(p => [String(p.id), p]));
    const localList = this.adb.findPatientsByAccountId(this.account.id);

    const localGrouped = new Map();
    for (const local of localList) {
      const key = String(local.patient_id);
      if (!localGrouped.has(key)) localGrouped.set(key, []);
      localGrouped.get(key).push(local);
    }

    for (const [pid, locals] of localGrouped) {
      if (!serverMap.has(pid)) {
        locals.forEach(l => this.adb.deletePatientById(l.id));
      } else if (locals.length > 1) {
        locals.slice(1).forEach(l => this.adb.deletePatientById(l.id));
      }
    }

    const localMap = new Map();
    for (const [pid, locals] of localGrouped) {
      if (serverMap.has(pid)) localMap.set(pid, locals[0]);
    }

    for (const s of serverList) {
      const sid    = String(s.id);
      const idCard = s.idNo || s.paperNo;
      const local  = localMap.get(sid);
      if (!local) {
        this.adb.createPatient({ accountId: this.account.id, patientId: sid, name: s.name, idCard });
      } else if (local.name !== s.name || local.id_card !== idCard) {
        this.adb.updatePatient(local.id, s.name, idCard);
      }
    }

    this.patients = this.adb.findPatientsByAccountId(this.account.id);
  }

  async updateSubmitSign(submitSign) {
    this.adb.updateSessionSubmitSign(this.account.id, submitSign);
    await this.loadSession();
    return true;
  }

  async updateCookie(interfaceType, cookie) {
    const safe = (cookie === null || cookie === undefined) ? null : String(cookie);
    this.adb.updateSessionCookie(this.account.id, interfaceType, safe);
    await this.loadSession();
    return true;
  }

  async loadAccountDetails() {
    this.accountDetails = this.adb.findAccountDetailByAccountId(this.account.id);
    return this.accountDetails;
  }

  // ── Getters ───────────────────────────────────────────────────
  get isAuthenticated() { return !!this.sessionData?.auth_token; }

  getAuthToken()   { return this.sessionData?.auth_token; }
  getSubmitSign()  { return this.sessionData?.submit_sign; }
  setSubmitSign(v) { if (this.sessionData) this.sessionData.submit_sign = v; }

  getCookie(type) {
    if (!this.sessionData) return null;
    if (type === 'yizhu4_gam')    return this.sessionData.cookie_yizhu4_gam;
    if (type === 'mobile_manage') return this.sessionData.cookie_mobile_manage;
    return null;
  }
  setCookie(type, v) {
    if (!this.sessionData) return;
    if (type === 'yizhu4_gam')    this.sessionData.cookie_yizhu4_gam    = v;
    if (type === 'mobile_manage') this.sessionData.cookie_mobile_manage = v;
  }

  getAgent()    { return this.proxyAgent; }
  getS456hr8()  { return this.device?.s456hr8 || ''; }
  getDeviceId() { return this.device?.device_id || ''; }
  getPassword() { return this.account?.password || ''; }
  getOpenId()   { return this.account?.open_id  || ''; }
  getDefaultPatient() { return this.patients[0] || null; }
  getCurrentProxy()   { return this.currentProxy; }
  getDeviceInfo()     { return this.device; }

  // 该账号当前 snapshot 的客户端版本（来自 account_devices.client_version）
  getClientVersion() { return this.device?.client_version || null; }
  // 该账号当前 snapshot 的 referer（仅微信端有意义）
  getRefererSnapshot() { return this.device?.referer || null; }

  getPlatform() {
    if (this.accountType === 'wechat') return 'wechat';
    return this.account?.account_platform || 'ios';
  }

  getHospitalAccountId() {
    return this.accountDetails?.hospital_account_id ?? null;
  }

  clearSession() {
    this.sessionData = null;
    this.patients    = [];
    this.isLoggedIn  = false;
  }

  _log(msg) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${ts}] ${msg}`;
    this._logLines.push(line);
    if (this._logCallback) this._logCallback(line);
  }

  setLogCallback(fn) { this._logCallback = fn; }

  shutdown() {
    if (this.proxyAgent) this.proxyAgent.destroy();
  }
}

module.exports = SessionManager;
