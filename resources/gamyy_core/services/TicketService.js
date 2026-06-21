// services/ticketService.js - 支持按医生/按部门查号
const CryptoUtils = require('../crypto/cryptoUtils');
const RequestLog = require('../models/RequestLog');
const LockRequestLog = require('../models/lockRequestLog');
const LogDatabase = require('../database/logDb');
const ConnectionPool = require('./connectionPool');
const sidecar = require('./sidecarClient');

const SubmitSignPool = require('./SubmitSignPool');

// 构建代理唯一键：优先用真实出口IP
function buildProxyKey(proxyConfig) {
  return proxyConfig.realProxyIp || `${proxyConfig.host}:${proxyConfig.port}`;
}

// ========== 常量定义 ==========
const TICKET_SERVICE_CONSTANTS = {
  // 日志输出间隔（每N个请求输出一次详细日志）
  LOG_INTERVAL_CHECK: 20,
  LOG_INTERVAL_LOCK: 10,
  // 统计更新的最小间隔（毫秒）
  STATS_UPDATE_MIN_INTERVAL: 1000,
  // 默认超时时间
  DEFAULT_TIMEOUT: 60000,
  // Socket最大监听器数量
  MAX_LISTENERS: 100,
};

class TicketService {
  constructor(config, logDb = undefined) {
    this.config = config;
    this.cryptoUtils = new CryptoUtils();
    this.logDb = (logDb !== undefined) ? logDb : new LogDatabase();
    this.connectionPool = new ConnectionPool(config);
    
    this.lockSuccess = false;
    this.successfulLockAccount = null;
    
    this.proxyManager = null;
    this.accountManager = null;
    
    // 🆕 改为存储 { submitSign, cookie } 对象，用于锁号时使用
    this.proxySessionMap = new Map();
    // SubmitSign 池（含完整元数据）
    this.submitSignPool = new SubmitSignPool();
    this.accountTicketStatus = new Map();
    
    // 🆕 改进的请求统计（增加cancelled计数）
    this.checkStats = { total: 0, success: 0, failed: 0, cancelled: 0 };
    this.lockStats = { total: 0, success: 0, failed: 0, cancelled: 0 };
    
    // 🆕 按账号统计
    this.accountStats = new Map(); // accountId -> { mobile, channels, check: {total, success, failed}, lock: {total, success, failed} }
    
    // 🆕 按代理统计（新增）
    this.proxyStats = new Map(); // proxyKey -> { accountId, mobile, host, port, channels, check, lock }
    
    // 统计更新回调
    this.onStatsUpdate = null;
    this._lastStatsUpdate = 0;
    
    // 🆕 事件日志回调（在打印事件日志前调用，用于重置统计显示）
    this.onBeforeEventLog = null;

    // 查号模式严格 per-proxy（proxyConfig.cfg.checkMode），TicketService 不再持有任务级 checkMode 字段。
    // 但仍需要决定 init 时给账号预生成 doctor 还是 dept 的加密数据——通过扫描 _proxies 推导。

    // 旧的"任务级共享医生池"已废弃（task 表只有 task.doctor_code 单一目标）：
    // 如果代理覆盖了 cfg.queryParams.doctorCodes，runtime 时按代理读，无需 task 级缓存。
    this.encryptedRequestDataMap = new Map();   // 兼容字段：留空，旧路径不再走
    this.channelDoctorIndex = new Map();        // 同上，留空

    // 按部门查号的加密数据兜底（initializeDeptEncryptedData 仍写入用于 getEncryptionStatus 检查）
    this.encryptedDeptRequestData = null;

    // 🆕 按账号独立查号：每个账号自己的加密请求数据（方案三）
    this.accountDoctorEncryptedDataMap = new Map();
    this.accountDeptEncryptedDataMap   = new Map();

    this.encryptedRequestData = null;
    
    // 🆕 已售罄的号源ID集合
    this.exhaustedPlanIds = new Set();
    // 曾经查到过 remainNum>0 的号源ID集合（用于防止放号前 remainNum=0 的误判）
    this.seenAvailablePlanIds = new Set();
    
    // 账号类型
    this.accountType = this.config.account?.type || 'wechat';
    
    // 初始化状态
    this._initialized = false;
  }

  /**
   * 异步初始化方法，必须在使用前调用
   */
  async init() {
    if (this._initialized) return;
    if (this.logDb) {
      await this.logDb.init({
        taskId:                this.config._taskId                ?? null,
        taskName:              this.config._taskName              ?? null,
        accountId:             this.config._accountId             ?? null,
        accountSnapshot:       this.config._accountSnapshot       ?? null,
        systemConfigVersionId: this.config._systemConfigVersionId ?? null,
        taskConfigVersionId:   this.config._taskConfigVersionId   ?? null,
        proxySnapshot:         this.config._proxySnapshot         ?? null,
      });
    }
    await this.initializeEncryptedData();
    this._initialized = true;
  }

  setStatsUpdateCallback(callback) {
    this.onStatsUpdate = callback;
  }

  // 🆕 设置事件日志回调（在打印事件日志前调用）
  setBeforeEventLogCallback(callback) {
    this.onBeforeEventLog = callback;
  }

  // 🆕 设置锁号触发回调（用于停止第三阶段通道创建）
  setLockTriggeredCallback(callback) {
    this.onLockTriggered = callback;
  }

  // 🆕 设置号源售罄回调（用于停止所有使用该planId的锁号调度器）
  setPlanExhaustedCallback(callback) {
    this.onPlanExhausted = callback;
  }

  // 🆕 打印事件日志的统一方法（会先调用回调重置统计显示）
  printEventLog(...messages) {
    // 先调用回调，重置统计显示的行数计数
    if (this.onBeforeEventLog) {
      this.onBeforeEventLog();
    }
    // 然后打印日志
    messages.forEach(msg => console.log(msg));
  }

  /**
   * 🆕 改进的统计更新通知（带节流）
   */
  notifyStatsUpdate() {
    if (this.onStatsUpdate) {
      const now = Date.now();
      // 节流：最小间隔100ms
      if (now - this._lastStatsUpdate >= TICKET_SERVICE_CONSTANTS.STATS_UPDATE_MIN_INTERVAL) {
        this._lastStatsUpdate = now;
        this.onStatsUpdate();
      }
    }
  }

  /**
   * 🆕 增加取消请求的统计
   */
  incrementCancelledStats(type) {
    if (type === 'check') {
      this.checkStats.cancelled++;
    } else if (type === 'lock') {
      this.lockStats.cancelled++;
    }
    this.notifyStatsUpdate();
  }

  /**
   * 🆕 获取详细统计信息
   */
  getDetailedStats() {
    return {
      check: {
        ...this.checkStats,
        successRate: this.checkStats.total > 0 
          ? (this.checkStats.success / this.checkStats.total * 100).toFixed(1) + '%' 
          : '0%'
      },
      lock: {
        ...this.lockStats,
        successRate: this.lockStats.total > 0 
          ? (this.lockStats.success / this.lockStats.total * 100).toFixed(1) + '%' 
          : '0%'
      }
    };
  }

  /**
   * 🆕 初始化账号统计
   */
  initAccountStats(accountId, mobile, channelCount) {
    if (!this.accountStats.has(accountId)) {
      this.accountStats.set(accountId, {
        id: accountId,
        mobile: mobile,
        channels: { total: channelCount, connected: 0 },
        // scheduled=已调度, sent=已发送, total=已完成响应(success+failed)
        check: { scheduled: 0, sent: 0, total: 0, success: 0, failed: 0 },
        lock: { scheduled: 0, sent: 0, total: 0, success: 0, failed: 0 }
      });
    }
  }

  /**
   * 🆕 更新账号通道连接数
   */
  updateAccountChannelConnected(accountId, connectedCount) {
    const stats = this.accountStats.get(accountId);
    if (stats) {
      stats.channels.connected = connectedCount;
    }
  }

  /**
   * 🆕 增加账号已调度请求数（调度器分配时调用）
   */
  incrementAccountScheduled(accountId, type) {
    const stats = this.accountStats.get(accountId);
    if (stats) {
      if (type === 'check') {
        stats.check.scheduled++;
      } else if (type === 'lock') {
        stats.lock.scheduled++;
      }
    }
  }

  /**
   * 🆕 增加账号已发送请求数（实际发送时调用）
   */
  incrementAccountSent(accountId, type) {
    const stats = this.accountStats.get(accountId);
    if (stats) {
      if (type === 'check') {
        stats.check.sent++;
      } else if (type === 'lock') {
        stats.lock.sent++;
      }
    }
  }

  /**
   * 🆕 更新账号请求统计（请求完成时调用）
   */
  updateAccountStats(accountId, type, isSuccess) {
    const stats = this.accountStats.get(accountId);
    if (stats) {
      if (type === 'check') {
        stats.check.total++;
        if (isSuccess) stats.check.success++;
        else stats.check.failed++;
      } else if (type === 'lock') {
        stats.lock.total++;
        if (isSuccess) stats.lock.success++;
        else stats.lock.failed++;
      }
    }
  }

  /**
   * 🆕 获取所有账号的统计信息
   */
  getAccountStats() {
    return Array.from(this.accountStats.values());
  }

  /**
   * 🆕 初始化代理统计
   */
  initProxyStats(proxyKey, accountId, mobile, host, port, channelCount, realProxyIp = null) {
    if (!this.proxyStats.has(proxyKey)) {
      this.proxyStats.set(proxyKey, {
        proxyKey: proxyKey,
        accountId: accountId,
        mobile: mobile,
        host: host,
        port: port,
        realProxyIp: realProxyIp,  // 🆕 真实代理IP
        channels: { total: channelCount, connected: 0 },
        check: { scheduled: 0, sent: 0, total: 0, success: 0, failed: 0, reuse: 0,
                 s200: 0, s502: 0, otherHttp: 0, noResponse: 0 },
        lock:  { scheduled: 0, sent: 0, total: 0, success: 0, failed: 0,
                 s200: 0, s502: 0, otherHttp: 0, noResponse: 0 }
      });
    }
  }

  /**
   * 🆕 增加代理已调度请求数
   */
  incrementProxyScheduled(proxyKey, type) {
    const stats = this.proxyStats.get(proxyKey);
    if (stats) {
      if (type === 'check') stats.check.scheduled++;
      else if (type === 'lock') stats.lock.scheduled++;
    }
  }

  /**
   * 🆕 增加代理复用次数
   */
  incrementProxyReuse(proxyKey) {
    const stats = this.proxyStats.get(proxyKey);
    if (stats) {
      stats.check.reuse++;
    }
  }

  /**
   * 🆕 增加代理已发送请求数
   */
  incrementProxySent(proxyKey, type) {
    const stats = this.proxyStats.get(proxyKey);
    if (stats) {
      if (type === 'check') stats.check.sent++;
      else if (type === 'lock') stats.lock.sent++;
    }
  }

  /**
   * 🆕 更新代理请求统计（请求完成时调用）
   * @param {string} proxyKey - 代理Key
   * @param {string} type - 'check' 或 'lock'
   * @param {boolean} isSuccess - 是否业务成功
   * @param {number} statusCode - HTTP状态码（0=无响应）
   */
  updateProxyStats(proxyKey, type, isSuccess, statusCode = 0) {
    const stats = this.proxyStats.get(proxyKey);
    if (stats) {
      if (type === 'check') {
        stats.check.total++;
        if (isSuccess) stats.check.success++;
        else stats.check.failed++;
        // 按HTTP状态码分类
        if (statusCode === 200) stats.check.s200++;
        else if (statusCode === 502) stats.check.s502++;
        else if (statusCode > 0) stats.check.otherHttp++;
        else stats.check.noResponse++;
      } else if (type === 'lock') {
        stats.lock.total++;
        if (isSuccess) stats.lock.success++;
        else stats.lock.failed++;
        // 按HTTP状态码分类
        if (statusCode === 200) stats.lock.s200++;
        else if (statusCode === 502) stats.lock.s502++;
        else if (statusCode > 0) stats.lock.otherHttp++;
        else stats.lock.noResponse++;
      }
    }
  }

  /**
   * 🆕 获取所有代理的统计信息
   */
  getProxyStats() {
    return Array.from(this.proxyStats.values());
  }

  /**
   * 🆕 增加查号统计（同时更新全局、账号和代理统计）
   */
  incrementCheckStats(accountId, isSuccess, proxyKey = null, statusCode = 0) {
    if (isSuccess) {
      this.checkStats.success++;
    } else {
      this.checkStats.failed++;
    }
    this.updateAccountStats(accountId, 'check', isSuccess);
    if (proxyKey) {
      this.updateProxyStats(proxyKey, 'check', isSuccess, statusCode);
    }
    this.notifyStatsUpdate();
  }

  /**
   * 🆕 增加锁号统计（同时更新全局、账号和代理统计）
   */
  incrementLockStats(accountId, isSuccess, proxyKey = null, statusCode = 0) {
    if (isSuccess) {
      this.lockStats.success++;
    } else {
      this.lockStats.failed++;
    }
    this.updateAccountStats(accountId, 'lock', isSuccess);
    if (proxyKey) {
      this.updateProxyStats(proxyKey, 'lock', isSuccess, statusCode);
    }
    this.notifyStatsUpdate();
  }

  /**
   * 初始化加密数据
   * 根据 checkMode 决定初始化哪种查询的加密数据
   */
  async initializeEncryptedData() {
    try {
      // 扫描所有代理的 cfg.checkMode，决定要 init 哪些加密数据池
      const proxies = this.config._proxies || [];
      const hasDoctor = proxies.length === 0 /* 没代理时按 doctor 兜底 */
        || proxies.some(p => (p.cfg?.checkMode || 'doctor') === 'doctor');
      const hasDept   = proxies.some(p => p.cfg?.checkMode === 'dept');

      if (hasDept) {
        await this.initializeDeptEncryptedData();
      }
      if (hasDoctor) {
        await this.initializeDoctorEncryptedData();
      }
    } catch (error) {
      console.error('❌ 加密数据初始化失败:', error.message);
    }
  }

  /**
   * 初始化按部门查号的加密数据（方案三：按账号各自生成）
   * - 若账号配置了 doctorCode，自动从本地 doctors 表推导 deptCode
   * - 日期优先级：查号配置中的 planDateStart/planDateEnd > 账号的 lockPlanDate
   */
  async initializeDeptEncryptedData() {
    // 严格 per-proxy：从所有 dept 模式代理里找一份 deptQueryParams 作为预生成的参考。
    // runtime 时 checkTicketByDept 仍按 proxyConfig.cfg.deptQueryParams 取实际值。
    const proxies = this.config._proxies || [];
    const deptProxy = proxies.find(p => p.cfg?.checkMode === 'dept');
    const deptParams = (deptProxy?.cfg?.deptQueryParams) || {};
    const accounts = this.accountManager ? this.accountManager.getAllAccounts() : [];

    // 收集需要推导 deptCode 的医生代码
    const configDeptCode = deptParams.deptCode;
    let doctorDeptMap = new Map(); // doctorCode -> deptCode

    if (!configDeptCode) {
      // deptCode 未配置，需要从 DB 推导
      const doctorCodes = [...new Set(accounts.map(a => a.doctorCode).filter(Boolean))];
      if (doctorCodes.length > 0) {
        doctorDeptMap = await this._getDeptCodesByDoctorCodes(doctorCodes);
        if (doctorDeptMap.size > 0) {
          console.log(`✅ 已推导部门代码: ${[...doctorDeptMap.entries()].map(([d, dept]) => `${d}→${dept}`).join(', ')}`);
        }
      }
    }

    // 为每个账号生成独立加密数据
    let successCount = 0;
    for (const account of accounts) {
      const accountId = account.id || account.account_id;
      const mobile = account.mobile;

      // 确定 deptCode
      const effectiveDeptCode = configDeptCode || doctorDeptMap.get(account.doctorCode);
      if (!effectiveDeptCode) {
        console.warn(`⚠️ 账号 ${mobile} 无法确定部门代码（doctorCode: ${account.doctorCode}），该账号将跳过按部门查号`);
        continue;
      }

      // 确定日期
      const configDateStart = deptParams.planDateStart;
      const configDateEnd   = deptParams.planDateEnd;
      const effectiveDateStart = (configDateStart && configDateStart.trim()) ? configDateStart : (account.lockPlanDate || '');
      const effectiveDateEnd   = (configDateEnd   && configDateEnd.trim())   ? configDateEnd   : (account.lockPlanDate || '');

      const requestData = {
        deptCode: effectiveDeptCode,
        planDateStart: effectiveDateStart,
        planDateEnd: effectiveDateEnd,
        hospitalId: deptParams.hospitalId || '10097'
      };

      const encryptedData = this.cryptoUtils.encryptData(JSON.stringify(requestData));
      this.accountDeptEncryptedDataMap.set(accountId, {
        encryptedData,
        deptCode: effectiveDeptCode,
        planDateStart: effectiveDateStart,
        planDateEnd: effectiveDateEnd
      });
      successCount++;
    }

    // 同时保留兜底共享数据（兼容旧代码路径）
    if (successCount > 0) {
      const firstData = this.accountDeptEncryptedDataMap.values().next().value;
      this.encryptedDeptRequestData = firstData.encryptedData;
      this.encryptedRequestData = this.encryptedDeptRequestData;
    }

    console.log(`✅ 按部门查号初始化完成（${successCount}/${accounts.length} 个账号）`);
  }

  /**
   * 初始化按医生查号的加密数据
   * - 若配置了共享 doctorCodes 列表，为每个医生生成共享加密数据（原有逻辑）
   * - 若未配置共享列表（全部账号独立查号），为每个账号预生成独立加密数据
   *   并用第一个账号的数据作为兜底，确保 getEncryptionStatus() 返回 true
   */
  async initializeDoctorEncryptedData() {
    // 新架构：task 表只有 task.doctor_code（已经塞到 _accounts[i].doctorCode）。
    // 不再有"任务级共享 doctorCodes 池"概念——为每个账号按 account.doctorCode 各自预生成加密数据。
    const accounts = this.accountManager ? this.accountManager.getAllAccounts() : [];
    let firstEncryptedData = null;
    for (const account of accounts) {
      const data = this.getAccountDoctorEncryptedData(account);
      if (data && !firstEncryptedData) firstEncryptedData = data.encryptedData;
    }
    // 用第一个账号数据作兜底，确保 getEncryptionStatus() 通过
    if (firstEncryptedData) {
      this.encryptedRequestData = firstEncryptedData;
    } else {
      console.error('❌ 所有账号均未配置 doctorCode，无法生成查号加密数据');
    }
  }

  /**
   * 获取下一个要查询的医生
   * 根据 this.config.doctorSelectMode 配置决定选择模式:
   * - 'random': 每个请求随机选择
   * - 'perProxy': 同一个代理IP查询同一个医生
   * - 'perAccount': 同一个账号查询同一个医生
   *
   * @param {Object} proxyConfig - 代理配置（per-proxy）
   * @param {string} accountId - 账号ID
   */
  getDoctorForRequest(proxyConfig, accountId) {
    const cfg = proxyConfig?.cfg || {};
    if (cfg.checkMode === 'dept') return null;

    // 仅在代理覆盖了 doctorCodes 时才走"代理共享池"路径；否则走 null（让调用方用 account.doctorCode）
    const doctorCodes = (cfg.queryParams?.doctorCodes || []).filter(Boolean);
    if (doctorCodes.length === 0) return null;

    const proxyKey  = proxyConfig ? buildProxyKey(proxyConfig) : null;
    const selectMode = cfg.doctorSelectMode || 'random';

    switch (selectMode) {
      case 'perProxy':
        return this._getDoctorForProxyKey(proxyKey, doctorCodes);
      case 'perAccount':
        return this._getDoctorForAccount(accountId, doctorCodes);
      case 'random':
      default:
        return doctorCodes[Math.floor(Math.random() * doctorCodes.length)];
    }
  }
  
  /**
   * 为代理IP分配固定医生（轮询）—— 接受 doctorCodes 列表参数（per-proxy 池）
   */
  _getDoctorForProxyKey(proxyKey, doctorCodes) {
    if (!proxyKey || !doctorCodes?.length) return null;
    if (!this._proxyDoctorMap) {
      this._proxyDoctorMap = new Map();
      this._proxyDoctorIndex = 0;
    }
    if (!this._proxyDoctorMap.has(proxyKey)) {
      const doctorCode = doctorCodes[this._proxyDoctorIndex % doctorCodes.length];
      this._proxyDoctorMap.set(proxyKey, doctorCode);
      this._proxyDoctorIndex++;
    }
    return this._proxyDoctorMap.get(proxyKey);
  }

  /**
   * 为账号分配固定医生（轮询）—— 接受 doctorCodes 列表参数（per-proxy 池）
   */
  _getDoctorForAccount(accountId, doctorCodes) {
    if (!accountId || !doctorCodes?.length) return null;
    if (!this._accountDoctorMap) {
      this._accountDoctorMap = new Map();
      this._accountDoctorIndex = 0;
    }
    if (!this._accountDoctorMap.has(accountId)) {
      const doctorCode = doctorCodes[this._accountDoctorIndex % doctorCodes.length];
      this._accountDoctorMap.set(accountId, doctorCode);
      this._accountDoctorIndex++;
    }
    return this._accountDoctorMap.get(accountId);
  }

  // 兼容旧方法名（task 共享池已废，仅当代理覆盖了 doctorCodes 才有意义）
  getNextDoctorForChannel(channelId) { return null; }

  // 共享池已废：旧路径调用此方法时返回兜底加密数据（确保 getEncryptionStatus 通过）
  getEncryptedDataForDoctor(doctorCode) {
    return this.encryptedRequestData;
  }

  initializeAccountStatus(accountId) {
    if (!this.accountTicketStatus.has(accountId)) {
      this.accountTicketStatus.set(accountId, {
        proxyTicketFound: new Set(),
        proxyLockTriggered: new Set(),
        proxyLocking: new Set(),
        lockSuccess: false,
        successfulLockProxy: null,
        ticketFound: false
      });
    }
  }

  isAccountLockSuccess(accountId) {
    const status = this.accountTicketStatus.get(accountId);
    return status ? status.lockSuccess : false;
  }

  markAccountLockSuccess(accountId, proxyKey) {
    const status = this.accountTicketStatus.get(accountId);
    if (status) {
      status.lockSuccess = true;
      status.successfulLockProxy = proxyKey;
      status.ticketFound = true;
    }
  }

  hasAccountLockTriggeredOnProxy(accountId, proxyKey) {
    const status = this.accountTicketStatus.get(accountId);
    return status ? status.proxyLockTriggered.has(proxyKey) : false;
  }

  markAccountLockTriggeredOnProxy(accountId, proxyKey) {
    this.initializeAccountStatus(accountId);
    this.accountTicketStatus.get(accountId).proxyLockTriggered.add(proxyKey);
  }

  markAccountTicketFoundOnProxy(accountId, proxyKey) {
    this.initializeAccountStatus(accountId);
    const status = this.accountTicketStatus.get(accountId);
    status.proxyTicketFound.add(proxyKey);
    status.ticketFound = true;
  }

  markAccountLockingOnProxy(accountId, proxyKey) {
    this.initializeAccountStatus(accountId);
    this.accountTicketStatus.get(accountId).proxyLocking.add(proxyKey);
  }

  /**
   * 🆕 标记号源已售罄
   * @param {string} planId - 号源ID
   */
  markPlanIdExhausted(planId) {
    if (planId) {
      this.exhaustedPlanIds.add(planId);
      this.printEventLog(`🚫 [${this.formatTime()}] 号源 ${planId} 已标记为售罄`);
    }
  }

  /**
   * 🆕 检查号源是否已售罄
   * @param {string} planId - 号源ID
   * @returns {boolean}
   */
  isPlanIdExhausted(planId) {
    return this.exhaustedPlanIds.has(planId);
  }

  /**
   * 🆕 获取所有已售罄的号源ID
   * @returns {Array<string>}
   */
  getExhaustedPlanIds() {
    return Array.from(this.exhaustedPlanIds);
  }

  /**
   * 检查响应是否表示"号源已无余票"
   * 兼容两种格式：
   *   旧格式：{ code:0, msg:"...没有可以预约的号了..." }
   *   新格式：{ code:0, msg:"预约失败！", value:"没有可以预约的号了..." }
   */
  _isSlotExhaustedResponse(responseData) {
    if (!responseData) return false;
    if (responseData.msg && responseData.msg.includes('没有可以预约的号了')) return true;
    if (typeof responseData.value === 'string' && responseData.value.includes('没有可以预约的号了')) return true;
    return false;
  }

  /**
   * 根据查号响应更新号源售罄状态
   * - remainNum > 0：将 planId 加入 seenAvailablePlanIds（曾见过余票）
   * - remainNum = 0 且该 planId 曾见过余票：标记为售罄
   * 只针对账号目标（doctorCode + lockPlanDate）对应的号源
   * @param {object} responseData  查号响应
   * @param {object} account       账号对象（含 doctorCode、lockPlanDate）
   * @param {'doctor'|'dept'} mode 查号模式
   */
  updateSlotExhaustionFromCheck(responseData, account, mode) {
    if (!responseData || !responseData.value || !Array.isArray(responseData.value)) return;

    const filterDoctorCode = account?.doctorCode || null;
    const filterPlanDate = account?.lockPlanDate || null;

    const processPlan = (plan, doctorCode, doctorName, deptName) => {
      // 只处理目标医生+目标日期的号源
      if (filterDoctorCode && doctorCode !== filterDoctorCode) return;
      if (filterPlanDate && plan.date !== filterPlanDate) return;

      const planId = plan.id;
      if (!planId) return;

      if (plan.remainNum > 0) {
        if (!this.seenAvailablePlanIds.has(planId)) {
          this.seenAvailablePlanIds.add(planId);
          if (this.logDb) {
            this.logDb.saveSourceStatusEvent({
              planId, doctorCode, doctorName, deptName,
              date: plan.date, timeFrom: plan.timeFrom, timeTo: plan.timeTo,
              fee: plan.fee != null ? String(plan.fee) : null,
              remainNum: plan.remainNum, eventType: 'found',
            }).catch(() => {});
          }
        } else {
          this.seenAvailablePlanIds.add(planId);
        }
      } else if (plan.remainNum === 0 && this.seenAvailablePlanIds.has(planId)) {
        if (!this.exhaustedPlanIds.has(planId)) {
          if (this.logDb) {
            this.logDb.saveSourceStatusEvent({
              planId, doctorCode, doctorName, deptName,
              date: plan.date, timeFrom: plan.timeFrom, timeTo: plan.timeTo,
              fee: plan.fee != null ? String(plan.fee) : null,
              remainNum: 0, eventType: 'exhausted_check',
            }).catch(() => {});
          }
          this.markPlanIdExhausted(planId);
          if (this.onPlanExhausted) this.onPlanExhausted(planId);
        }
      }
    };

    if (mode === 'dept') {
      for (const registerType of responseData.value) {
        if (!registerType.doctorList || !Array.isArray(registerType.doctorList)) continue;
        for (const doctor of registerType.doctorList) {
          if (!doctor.planList || !Array.isArray(doctor.planList)) continue;
          for (const plan of doctor.planList) {
            processPlan(plan, doctor.doctorCode, doctor.doctorName, registerType.deptName || registerType.name);
          }
        }
      }
    } else {
      // doctor mode
      for (const dept of responseData.value) {
        if (!dept.planList || !Array.isArray(dept.planList)) continue;
        for (const plan of dept.planList) {
          processPlan(plan, plan.doctorCode, plan.doctorName, dept.deptName || dept.name);
        }
      }
    }
  }

  setProxyManager(proxyManager) { this.proxyManager = proxyManager; }
  
  setAccountManager(accountManager) {
    this.accountManager = accountManager;
    if (accountManager && accountManager.getAllAccounts) {
      accountManager.getAllAccounts().forEach(account => {
        this.initializeAccountStatus(account.id || account.account_id);
      });
    }
  }

  buildErrorMessage(result, context = '') {
    const parts = [];
    
    if (context) parts.push(context);
    
    if (result.errorType) {
      switch (result.errorType) {
        case 'TIMEOUT': parts.push('请求超时'); break;
        case 'CONNECTION_CLOSED': parts.push('连接被关闭'); break;
        case 'SOCKET_ERROR': parts.push('Socket错误'); break;
        case 'WRITE_ERROR': parts.push('写入失败'); break;
        case 'CHANNEL_STOPPED': parts.push('通道已停止'); break;
        case 'CHANNEL_DISCONNECTED': parts.push('通道未连接'); break;
      }
    }
    
    if (result.errorDetail) parts.push(result.errorDetail);
    else if (result.error?.message) parts.push(result.error.message);
    
    if (result.statusCode && result.statusCode !== 200) parts.push(`HTTP ${result.statusCode}`);
    if (result.duration) parts.push(`耗时${result.duration}ms`);
    
    return parts.join(' | ') || '未知错误';
  }

  buildHeaders(account, contentLength, submitSign = '', cookie = '') {
    const accountType = this.config.account?.type || 'wechat';

    if (accountType === 'app') {
      const userAgent = account.user_agent;
      const cookieValue = cookie || account.cookie_mobile_manage || '';
      const submitSignValue = submitSign || '';
      const isAndroid = (account.platform || this.config.account?.platform || 'ios') === 'android';

      if (isAndroid) {
        // Android App端请求头（字段顺序和大小写均与iOS不同）
        const headers = {
          's456hr8': account.s456hr8,
          'SubmitSign': submitSignValue,
          'hospitalId': '10097',
          'from': '0',
          'user-agent': userAgent,
          'Content-Type': 'application/json',
          'Content-Length': contentLength.toString(),
          'Host': 'hlwyl.gamyy.cn',
          'Connection': 'Keep-Alive',
          'Accept-Encoding': 'gzip'
        };
        // token 有值才加（Android 无token时省略该键）
        if (account.token) {
          // 插入到 from 后、user-agent 前
          const ordered = {};
          for (const [k, v] of Object.entries(headers)) {
            ordered[k] = v;
            if (k === 'from') ordered['token'] = account.token;
          }
          if (cookieValue) ordered['Cookie'] = cookieValue;
          return ordered;
        }
        if (cookieValue) headers['Cookie'] = cookieValue;
        return headers;
      }

      // iOS App端请求头
      return {
        'Host': 'hlwyl.gamyy.cn',
        'Accept': '*/*',
        'from': '0',
        'hospitalId': '10097',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'token': account.token,
        's456hr8': account.s456hr8,
        'Content-Length': contentLength.toString(),
        'User-Agent': userAgent,
        'SubmitSign': submitSignValue,
        'Connection': 'keep-alive',
        'content-type': 'application/json',
        'Cookie': cookieValue
      };
    } else {
      // 微信小程序端请求头（原有逻辑）
      const userAgent = account.user_agent;
      const referer = account.referer;
      
      return {
        'Host': 'hlwyl.gamyy.cn',
        'Connection': 'keep-alive',
        'Content-Length': contentLength.toString(),
        'hospitalId': '10097',
        's456hr8': account.s456hr8,
        'content-type': 'application/json',
        'SubmitSign': submitSign,
        'token': account.token,
        'from': '8',
        'Accept-Encoding': 'gzip,compress,br,deflate',
        'User-Agent': userAgent,
        'Referer': referer
      };
    }
  }

  /**
   * 构建请求数据（根据账号类型选择不同格式）
   */
  buildRequestDataWithHeaders(headers, url, encryptedData) {
    const accountType = this.config.account?.type || 'wechat';
    const urlObj = new URL(url);

    let headerLines;

    if (accountType === 'app') {
      const isAndroid = this.config.account?.platform === 'android';

      if (isAndroid) {
        // Android App端请求头顺序
        const lines = [
          `s456hr8: ${headers['s456hr8']}`,
          `SubmitSign: ${headers.SubmitSign}`,
          `hospitalId: ${headers.hospitalId}`,
          `from: ${headers.from}`
        ];
        if (headers.token) lines.push(`token: ${headers.token}`);
        lines.push(
          `user-agent: ${headers['user-agent']}`,
          `Content-Type: ${headers['Content-Type']}`,
          `Content-Length: ${headers['Content-Length']}`,
          `Host: ${headers.Host}`,
          `Connection: ${headers.Connection}`,
          `Accept-Encoding: ${headers['Accept-Encoding']}`
        );
        if (headers.Cookie) lines.push(`Cookie: ${headers.Cookie}`);
        headerLines = lines.join('\r\n');
      } else {
        // iOS App端请求头顺序
        headerLines = [
          `Host: ${headers.Host}`,
          `Accept: ${headers.Accept}`,
          `from: ${headers.from}`,
          `hospitalId: ${headers.hospitalId}`,
          `Accept-Language: ${headers['Accept-Language']}`,
          `Accept-Encoding: ${headers['Accept-Encoding']}`,
          `token: ${headers.token}`,
          `s456hr8: ${headers.s456hr8}`,
          `Content-Length: ${headers['Content-Length']}`,
          `User-Agent: ${headers['User-Agent']}`,
          `SubmitSign: ${headers.SubmitSign}`,
          `Connection: ${headers.Connection}`,
          `content-type: ${headers['content-type']}`,
          `Cookie: ${headers.Cookie}`
        ].join('\r\n');
      }
    } else {
      // 微信小程序端请求头顺序（原有逻辑）
      headerLines = [
        `Host: ${headers.Host}`,
        `Connection: ${headers.Connection}`,
        `Content-Length: ${headers['Content-Length']}`,
        `hospitalId: ${headers.hospitalId}`,
        `s456hr8: ${headers.s456hr8}`,
        `content-type: ${headers['content-type']}`,
        `SubmitSign: ${headers.SubmitSign || ''}`,
        `token: ${headers.token}`,
        `from: ${headers.from}`,
        `Accept-Encoding: ${headers['Accept-Encoding']}`,
        `User-Agent: ${headers['User-Agent']}`,
        `Referer: ${headers.Referer}`
      ].join('\r\n');
    }
    
    return `POST ${urlObj.pathname} HTTP/1.1\r\n${headerLines}\r\n\r\n${encryptedData}`;
  }

  /**
   * 查号请求（统一入口）—— 严格按 proxyConfig.cfg.checkMode 路由
   */
  async checkTicket(account, proxyConfig, channelId, requestIndex) {
    const proxyMode = proxyConfig?.cfg?.checkMode || 'doctor';
    if (proxyMode === 'dept') {
      return this.checkTicketByDept(account, proxyConfig, channelId, requestIndex);
    } else {
      return this.checkTicketByDoctor(account, proxyConfig, channelId, requestIndex);
    }
  }

  /**
   * 按医生查号
   */
  async checkTicketByDoctor(account, proxyConfig, channelId, requestIndex) {
    const accountId = account.id || account.account_id;
    const proxyKey = buildProxyKey(proxyConfig);
    
    this.checkStats.total++;
    this.incrementAccountSent(accountId, 'check');  // 🆕 账号级别sent
    this.incrementProxySent(proxyKey, 'check');     // 🆕 代理级别sent
    
    const requestId = `check-${channelId}-${requestIndex}-${Date.now()}`;
    
    if (this.isAccountLockSuccess(accountId)) {
      return { success: false, hasTicket: false, error: '账号已锁号成功', requestType: 'check', requestId };
    }

    // 🆕 方案三：优先使用账号独立查号数据（账号配置了 doctorCode 时）
    const accountDoctorData = this.getAccountDoctorEncryptedData(account);
    // 若账号有专属目标医生则使用账号数据；否则若代理覆盖了 doctorCodes 池则按 selectMode 选；都没有则放弃
    const proxyQueryParams = proxyConfig?.cfg?.queryParams || {};
    const currentDoctorCode = accountDoctorData
      ? accountDoctorData.doctorCode
      : this.getDoctorForRequest(proxyConfig, accountId);
    const effectivePlanDate = accountDoctorData
      ? accountDoctorData.planDateStart
      : (proxyQueryParams.planDateStart || account.lockPlanDate || '');
    const effectiveHospitalId = proxyQueryParams.hospitalId || '10097';

    const requestLog = new RequestLog(
      accountId, proxyConfig, account.mobile,
      { doctorCode: currentDoctorCode, planDateStart: effectivePlanDate, hospitalId: effectiveHospitalId },
      channelId, requestIndex
    );

    let logSaved = false;
    let foundSubmitSign = null;
    let requestHeaders = null;

    const saveLogOnce = async (statusCode, responseData, error = null, submitSign = null, responseHeaders = null, reqHeaders = null) => {
      if (!logSaved) {
        requestLog.complete(statusCode, responseData, error, submitSign, responseHeaders, reqHeaders);
        try {
          if (this.logDb) await this.logDb.saveRequestLog(requestLog);
          logSaved = true;
        } catch (e) {
          console.error(`⚠️ [${this.formatTime()}] 保存查号日志失败(按医生): ${e.message}`);
        }
      }
    };

    try {
      // 🆕 方案三：账号有专属目标医生时用账号专属加密数据，否则用共享数据
      const encryptedData = accountDoctorData
        ? accountDoctorData.encryptedData
        : this.getEncryptedDataForDoctor(currentDoctorCode);
      const headers = this.buildHeaders(account, Buffer.byteLength(encryptedData), '');
      requestHeaders = headers;

      const requestData = this.buildRequestDataWithEncrypted(headers, 'https://hlwyl.gamyy.cn/mobile-web/source.doctor.plans.hsr', encryptedData);
      const channels = this.connectionPool.getChannelsByProxy(buildProxyKey(proxyConfig));
      const channel = channels.find(ch => ch.channelId === channelId);
      
      if (!channel) {
        const errorMsg = `通道不存在: ${channelId}`;
        this.incrementCheckStats(accountId, false, proxyKey);
        await saveLogOnce(0, null, errorMsg, null, null, requestHeaders);
        return { success: false, hasTicket: false, error: errorMsg, statusCode: 0, requestType: 'check', requestId };
      }
      
      if (!channel.isConnected) {
        const errorMsg = `通道未连接: ${channelId}`;
        this.incrementCheckStats(accountId, false, proxyKey);
        await saveLogOnce(0, null, errorMsg, null, null, requestHeaders);
        return { success: false, hasTicket: false, error: errorMsg, statusCode: 0, requestType: 'check', requestId };
      }

      const result = await channel.sendRequest(requestData, account, 'check', requestId);
      
      if (result.requestType !== 'check') {
        return { success: false, hasTicket: false, error: '请求类型不匹配', requestType: result.requestType, requestId: result.requestId };
      }
      
      if (result.success || result.statusCode > 0) {
        const proxyKey = buildProxyKey(proxyConfig);
        
        // 提取响应头中的SubmitSign和Set-Cookie
        let foundCookie = '';
        if (result.data) {
          const headerMatch = result.data.match(/SubmitSign:\s*([^\r\n]+)/i);
          if (headerMatch) {
            foundSubmitSign = headerMatch[1].trim();
          }
          // 🆕 提取Set-Cookie（App端锁号需要）
          foundCookie = this.extractCookieFromResponse(result.data);
          
          // 存储到proxySessionMap，锁号时使用
          this.proxySessionMap.set(proxyKey, { 
            submitSign: foundSubmitSign, 
            cookie: foundCookie 
          });
        }

        const responseHeaders = this.extractHeadersFromResponse(result.data);

        // 先解析响应体（需在入池前完成，以便计算 responseMaxSlotDate）
        let responseData = null;
        let processError = null;
        try {
          if (result.data) responseData = await this.processResponse(result.data);
        } catch (e) {
          processError = `响应解析失败: ${e.message}`;
        }

        // 将 SubmitSign 加入池（含完整元数据）
        let submitSignPoolId = null;
        if (foundSubmitSign) {
          const queryDateStart = accountDoctorData ? accountDoctorData.planDateStart : (proxyQueryParams.planDateStart || account.lockPlanDate || '');
          const lockPlanDate = account.lockPlanDate || '';
          // 查询日期即目标日期时直接使用，否则从响应体取最大号源日期
          // ⚠️ 局限性见 _extractMaxSlotDate 注释
          const responseMaxSlotDate = (queryDateStart === lockPlanDate)
            ? queryDateStart
            : this._extractMaxSlotDate(responseData);
          submitSignPoolId = this.submitSignPool.add({
            submitSign: foundSubmitSign,
            cookie: foundCookie,
            accountId: String(accountId),
            proxyIp: proxyConfig.realProxyIp || buildProxyKey(proxyConfig),
            channelId,
            targetServerIp: channel ? (channel.targetHost || '') : '',
            serverTime: this._extractServerTime(responseHeaders),
            queryMode: 'doctor',
            queryDateStart,
            queryDateEnd: null,
            responseMaxSlotDate,
          });
        }

        const statusCode = result.statusCode || (result.success ? 200 : 0);

        let errorMsg = null;
        if (!result.success) {
          errorMsg = `HTTP ${statusCode}`;
          if (processError) errorMsg += ` | ${processError}`;
        } else if (processError) {
          errorMsg = processError;
        } else if (responseData && responseData.code !== 0) {
          errorMsg = `业务错误: code=${responseData.code}, msg=${responseData.msg || '无'}`;
        }

        await saveLogOnce(statusCode, responseData, errorMsg, foundSubmitSign, responseHeaders, requestHeaders);

        if (result.success && responseData && responseData.code === 0 && responseData.value) {
          this.incrementCheckStats(accountId, true, proxyKey, statusCode);
          const hasTicket = this.hasAvailableTicketsByDoctor(responseData, account);
          this.updateSlotExhaustionFromCheck(responseData, account, 'doctor');
          const allTickets = hasTicket ? this.getAllAvailableTicketsByDoctor(responseData, account) : [];
          const ticketDetails = allTickets[0] || null;

          if (hasTicket) {
            const logMessages = [`\n🎯🎯🎯 [${this.formatTime()}] 发现余票！账号ID: ${accountId}, 手机: ${account.mobile}, 代理: ${proxyKey}`];
            if (ticketDetails) {
              logMessages.push(`   科室: ${ticketDetails.deptName}, 医生: ${ticketDetails.doctorName}`);
              logMessages.push(`   时间: ${ticketDetails.date} ${ticketDetails.timeFrom}-${ticketDetails.timeTo}`);
              logMessages.push(`   余票: ${ticketDetails.remainNum}张, 费用: ${ticketDetails.fee}元\n`);
            }
            if (allTickets.length > 1) {
              logMessages.push(`   备选号源: 共${allTickets.length}个，已按优先级排序`);
            }
            this.printEventLog(...logMessages);
            this.markAccountTicketFoundOnProxy(accountId, buildProxyKey(proxyConfig));
            if (submitSignPoolId && ticketDetails?.date) {
              this.submitSignPool.updateSlotDate(submitSignPoolId, ticketDetails.date);
            }
          }

          return {
            success: true, hasTicket, ticketDetails, allTickets, data: responseData,
            submitSign: foundSubmitSign, cookie: foundCookie, submitSignSource: channelId, statusCode,
            requestType: 'check', requestId
          };
        }

        this.incrementCheckStats(accountId, false, proxyKey, statusCode);
        return {
          success: result.success, hasTicket: false, statusCode,
          submitSign: foundSubmitSign, cookie: foundCookie, submitSignSource: channelId, error: errorMsg,
          requestType: 'check', requestId
        };
      }

      this.incrementCheckStats(accountId, false, proxyKey, result.statusCode || 0);
      const errorMsg = this.buildErrorMessage(result, '查号请求失败');
      await saveLogOnce(result.statusCode || 0, null, errorMsg, foundSubmitSign, null, requestHeaders);
      return {
        success: false, hasTicket: false, statusCode: result.statusCode || 0, error: errorMsg,
        submitSignSource: channelId, cookie: '',
        requestType: 'check', requestId
      };

    } catch (error) {
      // 🔑 检查请求是否被取消，如果被取消则返回cancelled标记
      if (error && error.cancelled) {
        return {
          success: false, hasTicket: false, error: '请求被取消',
          statusCode: 0, cancelled: true, cookie: '',
          requestType: error.requestType || 'check', requestId: error.requestId || requestId
        };
      }

      this.incrementCheckStats(accountId, false, proxyKey, error.statusCode || 0);
      const errorMsg = this.buildErrorMessage(error, '查号异常');
      await saveLogOnce(error.statusCode || 0, null, errorMsg, foundSubmitSign, null, requestHeaders);
      return { 
        success: false, hasTicket: false, error: errorMsg, statusCode: error.statusCode || 0, cookie: '',
        requestType: error.requestType || 'check', requestId: error.requestId || requestId
      };
    }
  }

  /**
   * 按部门查号
   */
  async checkTicketByDept(account, proxyConfig, channelId, requestIndex) {
    const accountId = account.id || account.account_id;
    const proxyKey = buildProxyKey(proxyConfig);
    
    this.checkStats.total++;
    this.incrementAccountSent(accountId, 'check');  // 🆕 账号级别sent
    this.incrementProxySent(proxyKey, 'check');     // 🆕 代理级别sent
    
    const requestId = `check-${channelId}-${requestIndex}-${Date.now()}`;
    
    if (this.isAccountLockSuccess(accountId)) {
      return { success: false, hasTicket: false, error: '账号已锁号成功', requestType: 'check', requestId };
    }

    // 严格 per-proxy：deptQueryParams 取代理自己的
    const deptParams = proxyConfig?.cfg?.deptQueryParams || {};

    // 🆕 方案三：按账号获取预生成的独立加密数据
    const accountDeptData = this.getAccountDeptEncryptedData(account);
    if (!accountDeptData) {
      // 该账号在初始化时未能确定 deptCode，跳过
      const errorMsg = `账号 ${account.mobile} 未初始化部门查号数据（deptCode 未知），请检查配置`;
      this.incrementCheckStats(accountId, false, proxyKey);
      return { success: false, hasTicket: false, error: errorMsg, statusCode: 0, requestType: 'check', requestId };
    }

    const requestLog = new RequestLog(
      accountId, proxyConfig, account.mobile,
      { deptCode: accountDeptData.deptCode, planDateStart: accountDeptData.planDateStart, planDateEnd: accountDeptData.planDateEnd, hospitalId: deptParams.hospitalId },
      channelId, requestIndex
    );

    let logSaved = false;
    let foundSubmitSign = null;
    let requestHeaders = null;

    const saveLogOnce = async (statusCode, responseData, error = null, submitSign = null, responseHeaders = null, reqHeaders = null) => {
      if (!logSaved) {
        requestLog.complete(statusCode, responseData, error, submitSign, responseHeaders, reqHeaders);
        try {
          if (this.logDb) await this.logDb.saveRequestLog(requestLog);
          logSaved = true;
        } catch (e) {
          console.error(`⚠️ [${this.formatTime()}] 保存查号日志失败(按部门): ${e.message}`);
        }
      }
    };

    try {
      // 🆕 方案三：使用账号独立加密数据（已在上方生成）
      const encryptedData = accountDeptData.encryptedData;
      const headers = this.buildHeaders(account, Buffer.byteLength(encryptedData), '');
      requestHeaders = headers;

      // 使用部门查号接口
      const requestData = this.buildRequestDataWithEncrypted(headers, 'https://hlwyl.gamyy.cn/mobile-web/source.dept.plans.hsr', encryptedData);
      const channels = this.connectionPool.getChannelsByProxy(buildProxyKey(proxyConfig));
      const channel = channels.find(ch => ch.channelId === channelId);
      
      if (!channel) {
        const errorMsg = `通道不存在: ${channelId}`;
        this.incrementCheckStats(accountId, false, proxyKey);
        await saveLogOnce(0, null, errorMsg, null, null, requestHeaders);
        return { success: false, hasTicket: false, error: errorMsg, statusCode: 0, requestType: 'check', requestId };
      }
      
      if (!channel.isConnected) {
        const errorMsg = `通道未连接: ${channelId}`;
        this.incrementCheckStats(accountId, false, proxyKey);
        await saveLogOnce(0, null, errorMsg, null, null, requestHeaders);
        return { success: false, hasTicket: false, error: errorMsg, statusCode: 0, requestType: 'check', requestId };
      }

      const result = await channel.sendRequest(requestData, account, 'check', requestId);
      
      if (result.requestType !== 'check') {
        return { success: false, hasTicket: false, error: '请求类型不匹配', requestType: result.requestType, requestId: result.requestId };
      }
      
      if (result.success || result.statusCode > 0) {
        const proxyKey = buildProxyKey(proxyConfig);
        
        // 提取响应头中的SubmitSign和Set-Cookie
        let foundCookie = '';
        if (result.data) {
          const headerMatch = result.data.match(/SubmitSign:\s*([^\r\n]+)/i);
          if (headerMatch) {
            foundSubmitSign = headerMatch[1].trim();
          }
          // 🆕 提取Set-Cookie（App端锁号需要）
          foundCookie = this.extractCookieFromResponse(result.data);
          
          // 存储到proxySessionMap，锁号时使用
          this.proxySessionMap.set(proxyKey, { 
            submitSign: foundSubmitSign, 
            cookie: foundCookie 
          });
        }

        const responseHeaders = this.extractHeadersFromResponse(result.data);

        // 先解析响应体（需在入池前完成，以便计算 responseMaxSlotDate）
        let responseData = null;
        let processError = null;
        try {
          if (result.data) responseData = await this.processResponse(result.data);
        } catch (e) {
          processError = `响应解析失败: ${e.message}`;
        }

        // 🆕 将 SubmitSign 加入池（含完整元数据）
        let submitSignPoolId = null;
        if (foundSubmitSign) {
          const queryDateStart = accountDeptData.planDateStart;
          const queryDateEnd = accountDeptData.planDateEnd;
          const lockPlanDate = account.lockPlanDate || '';
          // 查询范围恰好等于目标日期时直接使用，否则从响应体取最大号源日期
          const responseMaxSlotDate = (queryDateStart === lockPlanDate && queryDateEnd === lockPlanDate)
            ? queryDateStart
            : this._extractMaxSlotDate(responseData);
          submitSignPoolId = this.submitSignPool.add({
            submitSign: foundSubmitSign,
            cookie: foundCookie,
            accountId: String(accountId),
            proxyIp: proxyConfig.realProxyIp || buildProxyKey(proxyConfig),
            channelId,
            targetServerIp: channel ? (channel.targetHost || '') : '',
            serverTime: this._extractServerTime(responseHeaders),
            queryMode: 'dept',
            queryDateStart,
            queryDateEnd,
            responseMaxSlotDate,
          });
        }

        const statusCode = result.statusCode || (result.success ? 200 : 0);

        let errorMsg = null;
        if (!result.success) {
          errorMsg = `HTTP ${statusCode}`;
          if (processError) errorMsg += ` | ${processError}`;
        } else if (processError) {
          errorMsg = processError;
        } else if (responseData && responseData.code !== 0) {
          errorMsg = `业务错误: code=${responseData.code}, msg=${responseData.msg || '无'}`;
        }

        await saveLogOnce(statusCode, responseData, errorMsg, foundSubmitSign, responseHeaders, requestHeaders);

        if (result.success && responseData && responseData.code === 0 && responseData.value) {
          this.incrementCheckStats(accountId, true, proxyKey, statusCode);

          // 使用按部门查号的票务检查方法
          const hasTicket = this.hasAvailableTicketsByDept(responseData, account);
          this.updateSlotExhaustionFromCheck(responseData, account, 'dept');
          const allTickets = hasTicket ? this.getAllAvailableTicketsByDept(responseData, account) : [];
          const ticketDetails = allTickets[0] || null;

          if (submitSignPoolId && ticketDetails?.date) {
            this.submitSignPool.updateSlotDate(submitSignPoolId, ticketDetails.date);
          }

          if (hasTicket) {
            const logMessages = [`\n🎯🎯🎯 [${this.formatTime()}] 发现余票！账号ID: ${accountId}, 手机: ${account.mobile}, 代理: ${proxyKey}`];
            if (ticketDetails) {
              logMessages.push(`   类型: ${ticketDetails.registerTypeName}`);
              logMessages.push(`   科室: ${ticketDetails.deptName}, 医生: ${ticketDetails.doctorName}`);
              logMessages.push(`   时间: ${ticketDetails.date} ${ticketDetails.timeFrom}-${ticketDetails.timeTo}`);
              logMessages.push(`   余票: ${ticketDetails.remainNum}张, 费用: ${ticketDetails.fee}元\n`);
            }
            if (allTickets.length > 1) {
              logMessages.push(`   备选号源: 共${allTickets.length}个，已按优先级排序`);
            }
            this.printEventLog(...logMessages);
            this.markAccountTicketFoundOnProxy(accountId, buildProxyKey(proxyConfig));
          }

          return {
            success: true, hasTicket, ticketDetails, allTickets, data: responseData,
            submitSign: foundSubmitSign, cookie: foundCookie, submitSignSource: channelId, statusCode,
            requestType: 'check', requestId
          };
        }
        
        this.incrementCheckStats(accountId, false, proxyKey, statusCode);
        return {
          success: result.success, hasTicket: false, statusCode,
          submitSign: foundSubmitSign, cookie: foundCookie, submitSignSource: channelId, error: errorMsg,
          requestType: 'check', requestId
        };
      }

      this.incrementCheckStats(accountId, false, proxyKey, result.statusCode || 0);
      const errorMsg = this.buildErrorMessage(result, '查号请求失败');
      await saveLogOnce(result.statusCode || 0, null, errorMsg, foundSubmitSign, null, requestHeaders);
      return {
        success: false, hasTicket: false, statusCode: result.statusCode || 0, error: errorMsg,
        submitSignSource: channelId, cookie: '',
        requestType: 'check', requestId
      };

    } catch (error) {
      // 🔑 检查请求是否被取消，如果被取消则返回cancelled标记
      if (error && error.cancelled) {
        return {
          success: false, hasTicket: false, error: '请求被取消',
          statusCode: 0, cancelled: true, cookie: '',
          requestType: error.requestType || 'check', requestId: error.requestId || requestId
        };
      }

      this.incrementCheckStats(accountId, false, proxyKey, error.statusCode || 0);
      const errorMsg = this.buildErrorMessage(error, '查号异常');
      await saveLogOnce(error.statusCode || 0, null, errorMsg, foundSubmitSign, null, requestHeaders);
      return { 
        success: false, hasTicket: false, error: errorMsg, statusCode: error.statusCode || 0,
        submitSignSource: channelId, cookie: '',
        requestType: error.requestType || 'check', requestId: error.requestId || requestId
      };
    }
  }

  /**
   * 锁号请求
   * @param {Object} account - 账号信息
   * @param {Object} proxyConfig - 代理配置
   * @param {string} submitSign - SubmitSign（来自查票响应）
   * @param {string} cookie - Cookie（来自查票响应的Set-Cookie，已裁剪）
   * @param {string} submitSignSource - SubmitSign来源
   * @param {Object} ticketData - 票务数据
   * @param {string} channelId - 通道ID
   * @param {number} requestIndex - 请求序号
   */
  async lockTicket(account, proxyConfig, submitSign, cookie, submitSignSource, ticketData, channelId, requestIndex) {
    const accountId = account.id || account.account_id;
    const proxyKey = buildProxyKey(proxyConfig);
    
    this.lockStats.total++;
    this.incrementAccountSent(accountId, 'lock');  // 🆕 账号级别sent
    this.incrementProxySent(proxyKey, 'lock');     // 🆕 代理级别sent
    
    const requestId = `lock-${channelId}-${requestIndex}-${Date.now()}`;
    
    if (this.isAccountLockSuccess(accountId)) {
      return { success: false, lockSuccess: false, error: '账号已锁号成功', requestType: 'lock', requestId };
    }

    // 🆕 检查号源是否已售罄
    if (this.isPlanIdExhausted(ticketData.planId)) {
      return { 
        success: false, lockSuccess: false, 
        error: `号源 ${ticketData.planId} 已售罄`, 
        requestType: 'lock', requestId, planExhausted: true 
      };
    }

    const lockRequestData = {
      param: {
        patientId: account.patient_id,
        medicalCardId: "",
        planId: ticketData.planId,
        planTimeFrom: "",
        planTimeEnd: "",
        fee: ticketData.fee,
        from: 0
      },
      hospitalId: "10097"
    };

    const lockRequestLog = new LockRequestLog(
      accountId, proxyConfig, account.mobile, lockRequestData,
      channelId, requestIndex, ticketData.planId, account.patient_id
    );

    let logSaved = false;
    let requestHeaders = null;

    const saveLogOnce = async (statusCode, responseData, error = null, responseHeaders = null, requestHeaders = null) => {
      if (!logSaved) {
        lockRequestLog.complete(statusCode, responseData, error, requestHeaders, lockRequestData, submitSign, submitSignSource, responseHeaders);
        try {
          if (this.logDb) await this.logDb.saveLockRequestLog(lockRequestLog);
          logSaved = true;
        } catch (e) {
          console.error(`⚠️ [${this.formatTime()}] 保存锁号日志失败: ${e.message}`);
        }
      }
    };

    try {
      const encryptedLockData = this.cryptoUtils.encryptData(JSON.stringify(lockRequestData));
      
      if (!encryptedLockData) {
        const errorMsg = '锁号数据加密失败';
        this.incrementLockStats(accountId, false, proxyKey);
        await saveLogOnce(0, null, errorMsg, null, null);
        return { success: false, lockSuccess: false, error: errorMsg, requestType: 'lock', requestId };
      }

      // 🆕 传递cookie给buildLockRequestWithHeaders
      const { requestData, headers } = this.buildLockRequestWithHeaders(account, encryptedLockData, submitSign, cookie);
      requestHeaders = headers;

      const channels = this.connectionPool.getAvailableChannelsForLock(buildProxyKey(proxyConfig));
      const channel = channels.find(ch => ch.channelId === channelId);
      
      if (!channel) {
        const errorMsg = `锁号通道不存在: ${channelId}`;
        this.incrementLockStats(accountId, false, proxyKey);
        await saveLogOnce(0, null, errorMsg, null, requestHeaders);
        return { success: false, lockSuccess: false, error: errorMsg, requestType: 'lock', requestId };
      }
      
      if (!channel.isConnected) {
        const errorMsg = `锁号通道未连接: ${channelId}`;
        this.incrementLockStats(accountId, false, proxyKey);
        await saveLogOnce(0, null, errorMsg, null, requestHeaders);
        return { success: false, lockSuccess: false, error: errorMsg, requestType: 'lock', requestId };
      }

      const result = await channel.sendRequest(requestData, account, 'lock', requestId);

      if (result.requestType !== 'lock') {
        // 🆕 使用 printEventLog 避免干扰统计显示
        this.printEventLog(`⚠️ [${this.formatTime()}] 锁号响应类型不匹配: 期望 lock, 实际 ${result.requestType}`);
        return { 
          success: false, lockSuccess: false, 
          error: `请求类型不匹配: 期望 lock, 实际 ${result.requestType}`,
          requestType: result.requestType, requestId: result.requestId
        };
      }

      if (result.success || result.statusCode > 0) {
        const responseHeaders = this.extractHeadersFromResponse(result.data);
        let responseData = null;
        let processError = null;

        try {
          if (result.data) responseData = await this.processResponse(result.data);
        } catch (e) {
          processError = `响应解析失败: ${e.message}`;
        }

        const statusCode = result.statusCode || (result.success ? 200 : 0);
        
        let errorMsg = null;
        if (!result.success) {
          errorMsg = `HTTP ${statusCode}`;
          if (processError) errorMsg += ` | ${processError}`;
        } else if (processError) {
          errorMsg = processError;
        } else if (responseData && responseData.code !== 0) {
          errorMsg = `锁号失败: code=${responseData.code}, msg=${responseData.msg || '无'}`;
        }
        
        await saveLogOnce(statusCode, responseData, errorMsg, responseHeaders, requestHeaders);

        // 🔑 关键修复：严格判断锁号成功
        // 1. code必须为0
        // 2. msg必须包含"预约成功"（排除查票响应的"查询成功"）
        const isRealLockSuccess = responseData && 
                                   responseData.code === 0 && 
                                   responseData.msg && 
                                   responseData.msg.includes('预约成功');
        
        if (isRealLockSuccess) {
          this.incrementLockStats(accountId, true, proxyKey, statusCode);

          // 🆕 修复：标记账号锁号成功状态
          this.markAccountLockSuccess(accountId, buildProxyKey(proxyConfig));

          // 🆕 使用 printEventLog 打印事件日志，避免干扰统计显示
          this.printEventLog(
            `\n🎉🎉🎉🎉🎉 [${this.formatTime()}] 锁号成功！🎉🎉🎉🎉🎉`,
            `   账号: ${account.mobile}`,
            `   代理: ${proxyKey}`,
            `   科室: ${ticketData.deptName}, 医生: ${ticketData.doctorName}`,
            `   时间: ${ticketData.date} ${ticketData.timeFrom}-${ticketData.timeTo}`,
            `   费用: ${ticketData.fee}元\n`
          );
          return { success: true, lockSuccess: true, data: responseData, statusCode, requestType: 'lock', requestId, submitSignConsumed: true };
        }

        // 检测是否是查票响应被误判（code=0 但 msg 是"查询成功"）
        if (responseData && responseData.code === 0 && responseData.msg && responseData.msg.includes('查询成功')) {
          // 🆕 使用 printEventLog 避免干扰统计显示
          this.printEventLog(
            `⚠️ [${this.formatTime()}] 检测到查票响应被误送到锁号流程，忽略此响应`,
            `   响应msg: ${responseData.msg}`
          );
          // 不计入失败统计，因为这不是真正的锁号请求
          return { 
            success: false, lockSuccess: false, 
            error: '响应类型不匹配：收到查票响应而非锁号响应', 
            statusCode, requestType: 'lock', requestId,
            misidentified: true  // 标记为误判
          };
        }
        
        // 🆕 检测"已预约该日期该科室"（说明账号已经预约成功了，只是之前没收到响应）
        if (responseData && responseData.msg && (responseData.msg.includes('已预约') || responseData.msg.includes('已经预约'))) {
          this.printEventLog(
            `\n🎉 [${this.formatTime()}] 检测到账号已预约成功（之前未收到响应）`,
            `   账号: ${account.mobile}`,
            `   代理: ${proxyKey}`,
            `   响应: ${responseData.msg}\n`
          );
          // 标记账号锁号成功，停止该账号所有请求
          this.markAccountLockSuccess(accountId, buildProxyKey(proxyConfig));
          this.incrementLockStats(accountId, true, proxyKey, statusCode);
          return {
            success: true, lockSuccess: true, data: responseData, statusCode,
            requestType: 'lock', requestId, alreadyBooked: true
          };
        }
        if (this._isSlotExhaustedResponse(responseData)) {
          const planId = ticketData.planId;
          this.printEventLog(
            `\n⚠️ [${this.formatTime()}] 号源已售罄`,
            `   账号: ${account.mobile}`,
            `   代理: ${proxyKey}`,
            `   号源ID: ${planId}`,
            `   响应: ${responseData.msg || responseData.value}\n`
          );
          // 记录号源售罄事件（锁号发现）
          if (this.logDb) {
            this.logDb.saveSourceStatusEvent({
              planId, doctorCode: ticketData.doctorCode, doctorName: ticketData.doctorName,
              deptName: ticketData.deptName, date: ticketData.date,
              timeFrom: ticketData.timeFrom, timeTo: ticketData.timeTo,
              fee: ticketData.fee != null ? String(ticketData.fee) : null,
              remainNum: 0, eventType: 'exhausted_lock',
            }).catch(() => {});
          }
          // 标记该号源已售罄
          this.markPlanIdExhausted(planId);

          // 调用回调，停止所有使用该planId的锁号调度器
          if (this.onPlanExhausted) {
            this.onPlanExhausted(planId);
          }

          this.incrementLockStats(accountId, false, proxyKey, statusCode);
          return {
            success: false, lockSuccess: false, error: errorMsg, statusCode,
            requestType: 'lock', requestId, planExhausted: true, planId: planId
          };
        }

        // 🆕 检测 SubmitSign 被消耗（号源信息已变更）
        if (responseData && responseData.msg && responseData.msg.includes('号源信息已变更')) {
          this.incrementLockStats(accountId, false, proxyKey, statusCode);
          return { success: false, lockSuccess: false, error: errorMsg, statusCode, requestType: 'lock', requestId, submitSignConsumed: true };
        }

        this.incrementLockStats(accountId, false, proxyKey, statusCode);
        return { success: result.success, lockSuccess: false, error: errorMsg, statusCode, requestType: 'lock', requestId };
      }

      this.incrementLockStats(accountId, false, proxyKey, result.statusCode || 0);
      const errorMsg = this.buildErrorMessage(result, '锁号请求失败');
      await saveLogOnce(result.statusCode || 0, null, errorMsg, null, requestHeaders);
      return { success: false, lockSuccess: false, statusCode: result.statusCode || 0, error: errorMsg, requestType: 'lock', requestId };

    } catch (error) {
      this.incrementLockStats(accountId, false, proxyKey, error.statusCode || 0);
      const errorMsg = this.buildErrorMessage(error, '锁号异常');
      await saveLogOnce(error.statusCode || 0, null, errorMsg, null, requestHeaders);
      return {
        success: false, lockSuccess: false, error: errorMsg, statusCode: error.statusCode || 0,
        requestType: error.requestType || 'lock', requestId: error.requestId || requestId
      };
    }
  }

  /**
   * 🆕 直接发送锁号请求（不通过预建立的通道）
   * 当没有可用通道时使用，临时创建连接发送请求
   */
  async directLockTicket(account, proxyConfig, submitSign, cookie, submitSignSource, ticketData, requestIndex) {
    const tls = require('tls');
    const { SocksClient } = require('socks');
    
    const accountId = account.id || account.account_id;
    const proxyKey = buildProxyKey(proxyConfig);
    const channelId = 'direct';  // 标记为直接请求
    
    this.lockStats.total++;
    this.incrementAccountSent(accountId, 'lock');
    this.incrementProxySent(proxyKey, 'lock');
    
    const requestId = `lock-${channelId}-${requestIndex}-${Date.now()}`;
    
    if (this.isAccountLockSuccess(accountId)) {
      return { success: false, lockSuccess: false, error: '账号已锁号成功', requestType: 'lock', requestId };
    }

    // 🆕 检查号源是否已售罄
    if (this.isPlanIdExhausted(ticketData.planId)) {
      return { 
        success: false, lockSuccess: false, 
        error: `号源 ${ticketData.planId} 已售罄`, 
        requestType: 'lock', requestId, planExhausted: true, direct: true 
      };
    }

    const lockRequestData = {
      param: {
        patientId: account.patient_id,
        medicalCardId: "",
        planId: ticketData.planId,
        planTimeFrom: "",
        planTimeEnd: "",
        fee: ticketData.fee,
        from: 0
      },
      hospitalId: "10097"
    };

    const lockRequestLog = new LockRequestLog(
      accountId, proxyConfig, account.mobile, lockRequestData,
      channelId, requestIndex, ticketData.planId, account.patient_id
    );

    let logSaved = false;
    let requestHeaders = null;
    let socket = null;
    let tlsSocket = null;

    const saveLogOnce = async (statusCode, responseData, error = null, responseHeaders = null, reqHeaders = null) => {
      if (!logSaved) {
        lockRequestLog.complete(statusCode, responseData, error, reqHeaders, lockRequestData, submitSign, submitSignSource, responseHeaders);
        try {
          if (this.logDb) await this.logDb.saveLockRequestLog(lockRequestLog);
          logSaved = true;
        } catch (e) {
          console.error(`⚠️ [${this.formatTime()}] 保存直接锁号日志失败: ${e.message}`);
        }
      }
    };

    const cleanup = () => {
      if (tlsSocket) {
        try { tlsSocket.destroy(); } catch (e) {}
        tlsSocket = null;
      }
      if (socket) {
        try { socket.destroy(); } catch (e) {}
        socket = null;
      }
    };

    try {
      const encryptedLockData = this.cryptoUtils.encryptData(JSON.stringify(lockRequestData));
      
      if (!encryptedLockData) {
        const errorMsg = '锁号数据加密失败';
        this.incrementLockStats(accountId, false, proxyKey);
        await saveLogOnce(0, null, errorMsg, null, null);
        return { success: false, lockSuccess: false, error: errorMsg, requestType: 'lock', requestId };
      }

      // 🆕 传递cookie给buildLockRequestWithHeaders
      const { requestData, headers } = this.buildLockRequestWithHeaders(account, encryptedLockData, submitSign, cookie);
      requestHeaders = headers;

      // 获取目标主机
      const targetHosts = this.config.connectionPool.targetHosts;
      const targetHost = targetHosts[Math.floor(Math.random() * targetHosts.length)];
      const sni = 'hlwyl.gamyy.cn';

      // 建连：与 connectionChannel.attemptConnect() 对齐的三分支
      // 1) sidecar 模式：经 fp-sidecar 隧道（带 TLS 指纹），隧道内走明文
      // 2) 直连出口（proxyType==='direct'）：绕过 SOCKS，net 直连
      // 3) 标准 SOCKS 代理
      const connectTimeout = this.config.timeout.connectTimeout;
      const waitSecure = (s) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TLS握手超时')), connectTimeout);
        s.on('secureConnect', () => { clearTimeout(timer); resolve(); });
        s.on('error', (error) => { clearTimeout(timer); reject(error); });
      });

      if (sidecar.SIDECAR_ADDR) {
        // sidecar：隧道明文 socket 即作 tlsSocket（write 明文 HTTP，由 sidecar 用指纹加密）
        const fpHeader = sidecar.buildFingerprintHeader(
          proxyConfig.cfg && proxyConfig.cfg.fingerprint,
          sni
        );
        const upstream = proxyConfig.proxyType === 'direct' ? '' : sidecar.buildSocksUrl(proxyConfig);
        const tunnel = await sidecar.establishTunnel(
          `${targetHost.host}:${targetHost.port}`,
          fpHeader, upstream, connectTimeout
        );
        socket = tunnel;
        tlsSocket = tunnel;
      } else if (proxyConfig.proxyType === 'direct') {
        // 直连出口：net 直连目标，再本地 TLS 握手
        const net = require('net');
        socket = await new Promise((resolve, reject) => {
          const sock = net.createConnection({ host: targetHost.host, port: targetHost.port });
          const timer = setTimeout(() => { sock.destroy(); reject(new Error('直连TCP超时')); }, connectTimeout);
          sock.on('connect', () => { clearTimeout(timer); resolve(sock); });
          sock.on('error', (e) => { clearTimeout(timer); reject(e); });
        });
        tlsSocket = tls.connect({ socket, host: sni, servername: sni, rejectUnauthorized: false });
        await waitSecure(tlsSocket);
      } else {
        // 标准 SOCKS 代理
        const socksResult = await SocksClient.createConnection({
          proxy: proxyConfig,
          destination: { host: targetHost.host, port: targetHost.port },
          command: 'connect',
          timeout: connectTimeout
        });
        socket = socksResult.socket;
        tlsSocket = tls.connect({ socket, host: sni, servername: sni, rejectUnauthorized: false });
        await waitSecure(tlsSocket);
      }

      // 发送请求并等待响应
      const responseText = await new Promise((resolve, reject) => {
        let responseBuffer = Buffer.from('');
        let headersComplete = false;
        let contentLength = null;
        let isChunked = false;

        const timeout = setTimeout(() => {
          reject(new Error('请求超时'));
        }, this.config.timeout.requestTimeout);

        tlsSocket.on('data', (data) => {
          responseBuffer = Buffer.concat([responseBuffer, data]);

          // 解析响应头
          if (!headersComplete) {
            const headerEndIndex = responseBuffer.indexOf('\r\n\r\n');
            if (headerEndIndex === -1) return;
            
            headersComplete = true;
            const headersText = responseBuffer.subarray(0, headerEndIndex).toString();
            
            const contentLengthMatch = headersText.match(/Content-Length:\s*(\d+)/i);
            if (contentLengthMatch) {
              contentLength = parseInt(contentLengthMatch[1]);
            }
            isChunked = headersText.toLowerCase().includes('transfer-encoding: chunked');
          }

          // 检查响应是否完整
          const headerEndIndex = responseBuffer.indexOf('\r\n\r\n');
          const bodyData = responseBuffer.subarray(headerEndIndex + 4);
          
          let isComplete = false;
          if (contentLength !== null) {
            isComplete = bodyData.length >= contentLength;
          } else if (isChunked) {
            isComplete = bodyData.includes(Buffer.from('0\r\n\r\n'));
          }

          if (isComplete) {
            clearTimeout(timeout);
            resolve(responseBuffer.toString());
          }
        });

        tlsSocket.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        tlsSocket.on('close', () => {
          clearTimeout(timeout);
          if (responseBuffer.length > 0) {
            resolve(responseBuffer.toString());
          } else {
            reject(new Error('连接关闭但无响应'));
          }
        });

        // 发送请求
        tlsSocket.write(requestData);
      });

      // 清理连接
      cleanup();

      // 处理响应
      const responseHeaders = this.extractHeadersFromResponse(responseText);
      let responseData = null;
      let processError = null;

      try {
        if (responseText) responseData = await this.processResponse(responseText);
      } catch (e) {
        processError = `响应解析失败: ${e.message}`;
      }

      const statusMatch = responseText.match(/HTTP\/\d\.\d\s+(\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
      const isSuccess = statusCode >= 200 && statusCode < 300;
      
      let errorMsg = null;
      if (!isSuccess) {
        errorMsg = `HTTP ${statusCode}`;
        if (processError) errorMsg += ` | ${processError}`;
      } else if (processError) {
        errorMsg = processError;
      } else if (responseData && responseData.code !== 0) {
        errorMsg = `锁号失败: code=${responseData.code}, msg=${responseData.msg || '无'}`;
      }
      
      await saveLogOnce(statusCode, responseData, errorMsg, responseHeaders, requestHeaders);

      // 判断锁号成功
      const isRealLockSuccess = responseData && 
                                 responseData.code === 0 && 
                                 responseData.msg && 
                                 responseData.msg.includes('预约成功');
      
      if (isRealLockSuccess) {
        this.incrementLockStats(accountId, true, proxyKey, statusCode);
        this.markAccountLockSuccess(accountId, buildProxyKey(proxyConfig));

        this.printEventLog(
          `\n🎉🎉🎉🎉🎉 [${this.formatTime()}] 直接锁号成功！🎉🎉🎉🎉🎉`,
          `   账号: ${account.mobile}`,
          `   代理: ${proxyKey}`,
          `   科室: ${ticketData.deptName}, 医生: ${ticketData.doctorName}`,
          `   时间: ${ticketData.date} ${ticketData.timeFrom}-${ticketData.timeTo}`,
          `   费用: ${ticketData.fee}元`,
          `   方式: 直接请求（无通道）\n`
        );
        return { success: true, lockSuccess: true, data: responseData, statusCode, requestType: 'lock', requestId, direct: true, submitSignConsumed: true };
      }

      // 检测误判
      if (responseData && responseData.code === 0 && responseData.msg && responseData.msg.includes('查询成功')) {
        return {
          success: false, lockSuccess: false,
          error: '响应类型不匹配：收到查票响应而非锁号响应',
          statusCode, requestType: 'lock', requestId,
          misidentified: true, direct: true
        };
      }

      // 🆕 检测"已预约该日期该科室"（说明账号已经预约成功了，只是之前没收到响应）
      if (responseData && responseData.msg && (responseData.msg.includes('已预约') || responseData.msg.includes('已经预约'))) {
        this.printEventLog(
          `\n🎉 [${this.formatTime()}] 检测到账号已预约成功（直接请求，之前未收到响应）`,
          `   账号: ${account.mobile}`,
          `   代理: ${proxyKey}`,
          `   响应: ${responseData.msg}\n`
        );
        // 标记账号锁号成功，停止该账号所有请求
        this.markAccountLockSuccess(accountId, buildProxyKey(proxyConfig));
        this.incrementLockStats(accountId, true, proxyKey, statusCode);
        return {
          success: true, lockSuccess: true, data: responseData, statusCode,
          requestType: 'lock', requestId, alreadyBooked: true, direct: true
        };
      }

      // 检测"没有可以预约的号了"（说明该号源已售罄，兼容新旧两种响应格式）
      if (this._isSlotExhaustedResponse(responseData)) {
        const planId = ticketData.planId;
        this.printEventLog(
          `\n⚠️ [${this.formatTime()}] 号源已售罄（直接请求）`,
          `   账号: ${account.mobile}`,
          `   代理: ${proxyKey}`,
          `   号源ID: ${planId}`,
          `   响应: ${responseData.msg || responseData.value}\n`
        );
        // 记录号源售罄事件（直接锁号发现）
        if (this.logDb) {
          this.logDb.saveSourceStatusEvent({
            planId, doctorCode: ticketData.doctorCode, doctorName: ticketData.doctorName,
            deptName: ticketData.deptName, date: ticketData.date,
            timeFrom: ticketData.timeFrom, timeTo: ticketData.timeTo,
            fee: ticketData.fee != null ? String(ticketData.fee) : null,
            remainNum: 0, eventType: 'exhausted_lock',
          }).catch(() => {});
        }
        // 标记该号源已售罄
        this.markPlanIdExhausted(planId);

        // 调用回调，停止所有使用该planId的锁号调度器
        if (this.onPlanExhausted) {
          this.onPlanExhausted(planId);
        }

        this.incrementLockStats(accountId, false, proxyKey, statusCode);
        return {
          success: false, lockSuccess: false, error: errorMsg, statusCode,
          requestType: 'lock', requestId, planExhausted: true, planId: planId, direct: true
        };
      }

      // 🆕 检测 SubmitSign 被消耗（号源信息已变更）
      if (responseData && responseData.msg && responseData.msg.includes('号源信息已变更')) {
        this.incrementLockStats(accountId, false, proxyKey, statusCode);
        return { success: false, lockSuccess: false, error: errorMsg, statusCode, requestType: 'lock', requestId, direct: true, submitSignConsumed: true };
      }

      this.incrementLockStats(accountId, false, proxyKey, statusCode);
      return { success: isSuccess, lockSuccess: false, error: errorMsg, statusCode, requestType: 'lock', requestId, direct: true };

    } catch (error) {
      cleanup();
      this.incrementLockStats(accountId, false, proxyKey, 0);
      const errorMsg = `直接锁号异常: ${error.message}`;
      await saveLogOnce(0, null, errorMsg, null, requestHeaders);
      return {
        success: false, lockSuccess: false, error: errorMsg, statusCode: 0,
        requestType: 'lock', requestId, direct: true
      };
    }
  }

  formatTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  }

  // ========== 按医生查号的票务检查方法 ==========

  hasAvailableTicketsByDoctor(responseData, account) {
    if (!responseData.value || !Array.isArray(responseData.value)) return false;
    const filterDoctorCode = account?.doctorCode || null;
    const filterPlanDate = account?.lockPlanDate || null;
    for (const dept of responseData.value) {
      if (dept.planList && Array.isArray(dept.planList)) {
        for (const plan of dept.planList) {
          if (plan.remainNum > 0
            && (!filterDoctorCode || plan.doctorCode === filterDoctorCode)
            && (!filterPlanDate || plan.date === filterPlanDate)) return true;
        }
      }
    }
    return false;
  }

  getRandomAvailableTicketByDoctor(responseData, account) {
    if (!responseData.value || !Array.isArray(responseData.value)) return null;

    const filterDoctorCode = account?.doctorCode || null;
    const filterPlanDate = account?.lockPlanDate || null;
    const availableTickets = [];
    for (const dept of responseData.value) {
      if (dept.planList && Array.isArray(dept.planList)) {
        for (const plan of dept.planList) {
          if (plan.remainNum > 0
            && (!filterDoctorCode || plan.doctorCode === filterDoctorCode)
            && (!filterPlanDate || plan.date === filterPlanDate)) {
            availableTickets.push({
              planId: plan.id,
              fee: plan.fee,
              clinicLabel: plan.clinicLabel,
              doctorName: plan.doctorName,
              date: plan.date,
              timeFrom: plan.timeFrom,
              timeTo: plan.timeTo,
              deptName: dept.deptName,
              remainNum: plan.remainNum
            });
          }
        }
      }
    }
    
    if (availableTickets.length === 0) return null;

    // 按 fee 从小到大排序（fee 是字符串，需转为数值）
    availableTickets.sort((a, b) => parseInt(a.fee) - parseInt(b.fee));

    // 找出最低费用，从中随机选一个
    const minFee = parseInt(availableTickets[0].fee);
    const minFeeTickets = availableTickets.filter(t => parseInt(t.fee) === minFee);
    const selectedTicket = minFeeTickets[Math.floor(Math.random() * minFeeTickets.length)];

    console.log(`💰 [${this.formatTime()}] 按费用选号: 共${availableTickets.length}个可用号源, 最低费用¥${minFee}`);
    console.log(`   选中: ${selectedTicket.clinicLabel || selectedTicket.deptName} ¥${selectedTicket.fee} (${selectedTicket.date} ${selectedTicket.timeFrom}-${selectedTicket.timeTo})`);
    if (availableTickets.length > 1) {
      const others = availableTickets.filter(t => parseInt(t.fee) !== minFee).slice(0, 3)
        .map(t => `${t.clinicLabel || t.deptName}¥${t.fee}`).join(', ');
      if (others) console.log(`   其他可选: ${others}${availableTickets.filter(t => parseInt(t.fee) !== minFee).length > 3 ? '...' : ''}`);
    }

    return selectedTicket;
  }

  /**
   * 返回按医生查号响应中所有可用号源（按费用升序排列，用于售罄后切换备选）
   */
  getAllAvailableTicketsByDoctor(responseData, account) {
    if (!responseData.value || !Array.isArray(responseData.value)) return [];
    const filterDoctorCode = account?.doctorCode || null;
    const filterPlanDate = account?.lockPlanDate || null;
    const tickets = [];
    for (const dept of responseData.value) {
      if (dept.planList && Array.isArray(dept.planList)) {
        for (const plan of dept.planList) {
          if (plan.remainNum > 0
            && (!filterDoctorCode || plan.doctorCode === filterDoctorCode)
            && (!filterPlanDate || plan.date === filterPlanDate)) {
            tickets.push({
              planId: plan.id,
              fee: plan.fee,
              clinicLabel: plan.clinicLabel,
              doctorName: plan.doctorName,
              date: plan.date,
              timeFrom: plan.timeFrom,
              timeTo: plan.timeTo,
              deptName: dept.deptName,
              remainNum: plan.remainNum
            });
          }
        }
      }
    }
    tickets.sort((a, b) => parseInt(a.fee) - parseInt(b.fee));
    return tickets;
  }

  /**
   * 返回按部门查号响应中所有可用号源（按医生优先级升序排列，用于售罄后切换备选）
   */
  getAllAvailableTicketsByDept(responseData, account) {
    if (!responseData.value || !Array.isArray(responseData.value)) return [];
    const filterDoctorCode = account?.doctorCode || null;
    const filterPlanDate = account?.lockPlanDate || null;
    const tickets = [];
    const doctorPriorityMap = this.getDoctorPriorityMap();
    for (const registerType of responseData.value) {
      if (registerType.doctorList && Array.isArray(registerType.doctorList)) {
        for (const doctor of registerType.doctorList) {
          if (filterDoctorCode && doctor.doctorCode !== filterDoctorCode) continue;
          if (doctor.planList && Array.isArray(doctor.planList)) {
            for (const plan of doctor.planList) {
              if (plan.remainNum > 0 && (!filterPlanDate || plan.date === filterPlanDate)) {
                const priority = doctorPriorityMap.get(doctor.doctorCode) ?? 999;
                tickets.push({
                  planId: plan.id,
                  fee: plan.fee,
                  doctorName: doctor.doctorName,
                  doctorCode: doctor.doctorCode,
                  date: plan.date,
                  timeFrom: plan.timeFrom,
                  timeTo: plan.timeTo,
                  deptName: doctor.deptName,
                  deptCode: doctor.deptCode,
                  remainNum: plan.remainNum,
                  registerTypeCode: registerType.registerTypeCode,
                  registerTypeName: registerType.registerTypeName,
                  priority: priority
                });
              }
            }
          }
        }
      }
    }
    tickets.sort((a, b) => a.priority - b.priority);
    return tickets;
  }

  // ========== 按部门查号的票务检查方法 ==========

  /**
   * 检查按部门查询的响应中是否有可用票
   * 按账号配置的 doctorCode 和 lockPlanDate 精确过滤
   */
  hasAvailableTicketsByDept(responseData, account) {
    if (!responseData.value || !Array.isArray(responseData.value)) return false;

    const filterDoctorCode = account?.doctorCode || null;
    const filterPlanDate = account?.lockPlanDate || null;

    for (const registerType of responseData.value) {
      if (registerType.doctorList && Array.isArray(registerType.doctorList)) {
        for (const doctor of registerType.doctorList) {
          if (filterDoctorCode && doctor.doctorCode !== filterDoctorCode) continue;
          if (doctor.planList && Array.isArray(doctor.planList)) {
            for (const plan of doctor.planList) {
              if (plan.remainNum > 0 && (!filterPlanDate || plan.date === filterPlanDate)) return true;
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * 从按部门查询的响应中根据优先级选择号源
   * 按账号配置的 doctorCode 和 lockPlanDate 精确过滤，取优先级最高的号源
   */
  getRandomAvailableTicketByDept(responseData, account) {
    if (!responseData.value || !Array.isArray(responseData.value)) return null;

    const filterDoctorCode = account?.doctorCode || null;
    const filterPlanDate = account?.lockPlanDate || null;
    const availableTickets = [];

    const doctorPriorityMap = this.getDoctorPriorityMap();

    for (const registerType of responseData.value) {
      if (registerType.doctorList && Array.isArray(registerType.doctorList)) {
        for (const doctor of registerType.doctorList) {
          if (filterDoctorCode && doctor.doctorCode !== filterDoctorCode) continue;
          if (doctor.planList && Array.isArray(doctor.planList)) {
            for (const plan of doctor.planList) {
              if (plan.remainNum > 0 && (!filterPlanDate || plan.date === filterPlanDate)) {
                const priority = doctorPriorityMap.get(doctor.doctorCode) ?? 999;
                availableTickets.push({
                  planId: plan.id,
                  fee: plan.fee,
                  doctorName: doctor.doctorName,
                  doctorCode: doctor.doctorCode,
                  date: plan.date,
                  timeFrom: plan.timeFrom,
                  timeTo: plan.timeTo,
                  deptName: doctor.deptName,
                  deptCode: doctor.deptCode,
                  remainNum: plan.remainNum,
                  registerTypeCode: registerType.registerTypeCode,
                  registerTypeName: registerType.registerTypeName,
                  priority: priority
                });
              }
            }
          }
        }
      }
    }

    if (availableTickets.length === 0) return null;

    // 按优先级排序，取优先级最高的号源
    availableTickets.sort((a, b) => a.priority - b.priority);
    const selectedTicket = availableTickets[0];

    console.log(`📊 [${this.formatTime()}] 按优先级选号: 共${availableTickets.length}个可用号源`);
    console.log(`   选中: ${selectedTicket.doctorName} (优先级${selectedTicket.priority})`);

    return selectedTicket;
  }

  /**
   * 🆕 按账号获取（或懒创建）按医生查号的加密数据
   * 仅当账号配置了 doctorCode 时才生成，否则返回 null（降级为共享逻辑）
   * 日期优先级：查号配置 planDateStart > 账号 lockPlanDate
   *
   * @param {Object} account - 账号对象
   * @returns {{ encryptedData, doctorCode, planDateStart } | null}
   */
  getAccountDoctorEncryptedData(account) {
    if (!account.doctorCode) return null;

    const accountId = account.id || account.account_id;
    if (this.accountDoctorEncryptedDataMap.has(accountId)) {
      return this.accountDoctorEncryptedDataMap.get(accountId);
    }

    // task 顶层不再有 queryParams 概念；日期直接用账号目标日期；hospitalId 写死 10097（系统单医院）
    const effectivePlanDate = account.lockPlanDate || '';

    const requestData = {
      doctorCode: account.doctorCode,
      planDateStart: effectivePlanDate,
      hospitalId: '10097'
    };

    const encryptedData = this.cryptoUtils.encryptData(JSON.stringify(requestData));
    const result = { encryptedData, doctorCode: account.doctorCode, planDateStart: effectivePlanDate };
    this.accountDoctorEncryptedDataMap.set(accountId, result);

    console.log(`📋 [账号独立查号] 账号 ${account.mobile} → 医生 ${account.doctorCode}，日期 ${effectivePlanDate || '（未指定）'}`);
    return result;
  }

  /**
   * 按账号获取按部门查号的加密数据（已在 initializeDeptEncryptedData 中预生成）
   * 若 init 时未能生成（如 deptCode 未知），返回 null
   *
   * @param {Object} account - 账号对象
   * @returns {{ encryptedData, deptCode, planDateStart, planDateEnd } | null}
   */
  getAccountDeptEncryptedData(account) {
    const accountId = account.id || account.account_id;
    return this.accountDeptEncryptedDataMap.get(accountId) || null;
  }

  /**
   * 获取医生优先级映射表
   * @returns {Map<string, number>} doctorCode -> priority
   */
  getDoctorPriorityMap() {
    if (!this._doctorPriorityMap) {
      this._doctorPriorityMap = new Map();
    }
    return this._doctorPriorityMap;
  }

  _getDeptCodesByDoctorCodes(doctorCodes) {
    if (!doctorCodes || doctorCodes.length === 0) return Promise.resolve(new Map());

    // 云端模式：直接使用 config 传入的映射表，无需本地 hospital.db
    if (this.config._deptCodesMap) {
      const map = new Map(Object.entries(this.config._deptCodesMap));
      return Promise.resolve(map);
    }

    // 本机模式：从本地 hospital.db 查询（原有逻辑）
    return new Promise((resolve) => {
      const sqlite3 = require('sqlite3').verbose();
      const dbPath = require('path').join(__dirname, '../data/hospital.db');
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          console.warn(`⚠️ 无法连接 hospital.db: ${err.message}`);
          resolve(new Map());
          return;
        }
        const placeholders = doctorCodes.map(() => '?').join(',');
        db.all(
          `SELECT doctor_code, dept_code FROM doctors WHERE doctor_code IN (${placeholders})`,
          doctorCodes,
          (err2, rows) => {
            db.close();
            if (err2 || !rows) { resolve(new Map()); return; }
            resolve(new Map(rows.map(r => [r.doctor_code, r.dept_code])));
          }
        );
      });
    });
  }

  buildRequestData(headers, url) {
    return this.buildRequestDataWithHeaders(headers, url, this.encryptedRequestData);
  }

  buildRequestDataWithEncrypted(headers, url, encryptedData) {
    return this.buildRequestDataWithHeaders(headers, url, encryptedData);
  }

  /**
   * 构建锁号请求（支持传入cookie）
   * @param {Object} account - 账号信息
   * @param {string} encryptedData - 加密后的请求数据
   * @param {string} submitSign - SubmitSign（来自查票响应）
   * @param {string} cookie - Cookie（来自查票响应的Set-Cookie，已裁剪）
   */
  buildLockRequestWithHeaders(account, encryptedData, submitSign, cookie = '') {
    const headers = this.buildHeaders(account, Buffer.byteLength(encryptedData), submitSign, cookie);
    const requestData = this.buildRequestDataWithHeaders(headers, 'https://hlwyl.gamyy.cn/mobile-web/source.apply.lockIn.hsr', encryptedData);
    return { requestData, headers };
  }

  buildLockRequest(account, encryptedData, submitSign, cookie = '') {
    const { requestData } = this.buildLockRequestWithHeaders(account, encryptedData, submitSign, cookie);
    return requestData;
  }

  async processResponse(responseText) {
    try {
      const responseData = this.cryptoUtils.processResponse(responseText);
      if (responseData && responseData.code !== undefined) return responseData;
      return { code: -1, error: '响应数据格式异常' };
    } catch (error) {
      return { code: -1, error: error.message };
    }
  }

  /**
   * 从已解析的响应头对象中提取服务器时间（Date 头）
   */
  _extractServerTime(responseHeaders) {
    if (!responseHeaders) return null;
    return responseHeaders['Date'] || responseHeaders['date'] || null;
  }

  /**
   * 从查号响应体中提取最大号源日期（用于计算 responseMaxSlotDate）
   * 适用于 doctor / dept 两种模式（planList 结构相同）
   *
   * ⚠️ 局限性（doctor 模式）：响应仅包含当前医生的号源，所取最大日期反映的是该医生的上限，
   *    而非服务器全局已释放的最大日期。当目标账号配置了不同医生时，可能出现误过滤：
   *    某医生只有 04-19 的号，但服务器全局已放到 04-24，该 SubmitSign 原本可以锁 04-24，
   *    却因 responseMaxSlotDate=04-19 被错误排除。
   *    此问题在"查询日期 = lockPlanDate"的常规使用场景下不存在（响应有号即 responseMaxSlotDate = lockPlanDate）。
   */
  _extractMaxSlotDate(responseData) {
    if (!responseData?.value || !Array.isArray(responseData.value)) return null;
    let maxDate = null;
    for (const item of responseData.value) {
      for (const plan of (item.planList || [])) {
        if (plan.date && (!maxDate || plan.date > maxDate)) maxDate = plan.date;
      }
    }
    return maxDate;
  }

  extractHeadersFromResponse(responseText) {
    try {
      const headers = {};
      const lines = responseText.split('\r\n');
      let i = 1;
      while (i < lines.length && lines[i].trim() !== '') {
        const colonIndex = lines[i].indexOf(':');
        if (colonIndex > 0) {
          headers[lines[i].substring(0, colonIndex).trim()] = lines[i].substring(colonIndex + 1).trim();
        }
        i++;
      }
      return headers;
    } catch (e) { return null; }
  }

  getConnectionPoolStatus() { return this.connectionPool.getStatus(); }
  
  getLockStatus() {
    let totalSuccess = 0;
    this.accountTicketStatus.forEach(status => { if (status.lockSuccess) totalSuccess++; });
    return { accountsLockSuccess: totalSuccess, successfulLockAccount: this.successfulLockAccount?.mobile };
  }

  /**
   * 🆕 改进的统计获取方法
   */
  getRequestStats() {
    return { 
      check: this.checkStats, 
      lock: this.lockStats,
      // 计算有效请求数（排除取消的）
      effectiveCheckTotal: this.checkStats.total - this.checkStats.cancelled,
      effectiveLockTotal: this.lockStats.total - this.lockStats.cancelled
    };
  }

  getEncryptionStatus() { return { isEncrypted: this.encryptedRequestData !== null }; }

  /**
   * 🆕 改进的清理方法
   */
  cleanup() {
    try {
      if (this.connectionPool) {
        this.connectionPool.close();
        this.connectionPool = null;
      }
    } catch (e) {
      console.error('⚠️ 关闭连接池时出错:', e.message);
    }
    
    try {
      if (this.logDb) {
        this.logDb.close();
        this.logDb = null;
      }
    } catch (e) {
      console.error('⚠️ 关闭日志数据库时出错:', e.message);
    }
    
    // 清理内存中的数据
    this.proxySessionMap.clear();
    this.submitSignPool.clear();
    this.accountTicketStatus.clear();
    this.encryptedRequestDataMap.clear();
    this.channelDoctorIndex.clear();
    this.exhaustedPlanIds.clear();      // 清理已售罄号源集合
    this.seenAvailablePlanIds.clear();  // 清理曾见余票号源集合
    this.accountDoctorEncryptedDataMap.clear();  // 🆕 清理账号独立医生查号数据
    this.accountDeptEncryptedDataMap.clear();    // 🆕 清理账号独立部门查号数据
    
    if (this._proxyDoctorMap) this._proxyDoctorMap.clear();
    if (this._accountDoctorMap) this._accountDoctorMap.clear();
  }

  /**
   * 从响应头中提取Set-Cookie并裁剪
   * "JSESSIONID=xxx; Path=/mobile-web; Secure; HttpOnly" -> "JSESSIONID=xxx"
   */
  extractCookieFromResponse(responseData) {
    if (!responseData) return '';
    
    // 从原始响应中匹配Set-Cookie头
    const cookieMatch = responseData.match(/Set-Cookie:\s*([^\r\n]+)/i);
    if (!cookieMatch) return '';
    
    const fullCookie = cookieMatch[1].trim();
    // 裁剪：取第一个分号前的部分
    return fullCookie.split(';')[0].trim();
  }
}

module.exports = TicketService;