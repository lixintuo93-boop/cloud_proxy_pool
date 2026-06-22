// config/configValidator.js - 配置验证模块
// 只做提示，不阻止程序运行

const CONFIG_CONSTANTS = {
  // 通道空闲超时时间（服务器约60秒后关闭空闲连接）
  CHANNEL_IDLE_TIMEOUT_SECONDS: 60,
  // 默认的查号日期应为明天
  DOCTOR_QUERY_DAYS_AHEAD: 1,
  // 默认的部门查号日期应为7天后
  DEPT_QUERY_DAYS_AHEAD: 7,
  // SubmitSign有效期（约10分钟）
  SUBMIT_SIGN_VALIDITY_MINUTES: 10,
  // 合理的超时范围
  MIN_TIMEOUT_MS: 5000,
  MAX_TIMEOUT_MS: 300000,
  // 合理的通道数范围
  MIN_CHANNELS_PER_PROXY: 1,
  MAX_CHANNELS_PER_PROXY: 100,
  // 合理的请求次数范围
  MIN_REQUESTS_PER_PROXY: 1,
  MAX_REQUESTS_PER_PROXY: 200,
};

class ConfigValidator {
  constructor(config) {
    this.config = config;
    this.warnings = [];
    this.errors = [];
  }

  /**
   * 验证所有配置项
   * @returns {Object} { valid: boolean, warnings: string[], errors: string[] }
   */
  validate() {
    this.warnings = [];
    this.errors = [];

    this.validateDates();
    this.validateTimes();
    this.validateNumbers();
    this.validateTargetHosts();
    this.validateModes();

    return {
      valid: this.errors.length === 0,
      warnings: this.warnings,
      errors: this.errors
    };
  }

  /**
   * 验证日期配置
   */
  validateDates() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 1. 验证按医生查号日期（应为明天）
    if (this.config.queryParams && this.config.queryParams.planDateStart) {
      const doctorDate = this.parseDate(this.config.queryParams.planDateStart);
      if (doctorDate) {
        const expectedDate = new Date(today);
        expectedDate.setDate(expectedDate.getDate() + CONFIG_CONSTANTS.DOCTOR_QUERY_DAYS_AHEAD);
        
        const diffDays = Math.round((doctorDate - today) / (24 * 60 * 60 * 1000));
        
        if (doctorDate < today) {
          this.warnings.push(
            `⚠️ queryParams.planDateStart (${this.config.queryParams.planDateStart}) 是过去的日期`
          );
        } else if (diffDays !== CONFIG_CONSTANTS.DOCTOR_QUERY_DAYS_AHEAD) {
          this.warnings.push(
            `⚠️ queryParams.planDateStart (${this.config.queryParams.planDateStart}) 不是明天的日期，` +
            `期望: ${this.formatDate(expectedDate)}`
          );
        }
      } else {
        this.errors.push(
          `❌ queryParams.planDateStart (${this.config.queryParams.planDateStart}) 日期格式无效`
        );
      }
    }

    // 2. 验证按部门查号日期（应为7天后）
    if (this.config.deptQueryParams) {
      const { planDateStart, planDateEnd } = this.config.deptQueryParams;
      
      // 检查开始和结束日期是否相同
      if (planDateStart && planDateEnd && planDateStart !== planDateEnd) {
        this.warnings.push(
          `⚠️ deptQueryParams.planDateStart (${planDateStart}) 与 planDateEnd (${planDateEnd}) 不一致，` +
          `通常应该相同`
        );
      }

      // 检查是否为7天后
      if (planDateStart) {
        const deptDate = this.parseDate(planDateStart);
        if (deptDate) {
          const expectedDate = new Date(today);
          expectedDate.setDate(expectedDate.getDate() + CONFIG_CONSTANTS.DEPT_QUERY_DAYS_AHEAD);
          
          const diffDays = Math.round((deptDate - today) / (24 * 60 * 60 * 1000));
          
          if (deptDate < today) {
            this.warnings.push(
              `⚠️ deptQueryParams.planDateStart (${planDateStart}) 是过去的日期`
            );
          } else if (diffDays !== CONFIG_CONSTANTS.DEPT_QUERY_DAYS_AHEAD) {
            this.warnings.push(
              `⚠️ deptQueryParams.planDateStart (${planDateStart}) 不是7天后的日期，` +
              `期望: ${this.formatDate(expectedDate)}（当前差 ${diffDays} 天）`
            );
          }
        } else {
          this.errors.push(
            `❌ deptQueryParams.planDateStart (${planDateStart}) 日期格式无效`
          );
        }
      }
    }
  }

  /**
   * 验证时间配置
   */
  validateTimes() {
    const phase1 = this.config.channelBuildPhase1;
    const checkReq = this.config.checkRequest;
    const lockReq = this.config.lockRequest;

    if (!phase1 || !checkReq) {
      this.errors.push(`❌ 缺少 channelBuildPhase1 或 checkRequest 配置`);
      return;
    }

    // 解析时间
    const buildStartTime = this.parseTimeString(phase1.startTime);
    const checkStartTimeStr = checkReq.startTime;

    if (!checkStartTimeStr) {
      this.errors.push(`❌ 缺少 checkRequest.startTime 配置`);
      return;
    }
    if (!checkReq.windowTime) {
      this.errors.push(`❌ 缺少 checkRequest.windowTime 配置`);
      return;
    }
    if (!buildStartTime) {
      this.errors.push(`❌ channelBuildPhase1.startTime (${phase1.startTime}) 时间格式无效`);
      return;
    }

    const checkStartTime = this.parseTimeString(checkStartTimeStr);
    if (!checkStartTime) {
      this.errors.push(`❌ checkRequest.startTime (${checkStartTimeStr}) 时间格式无效`);
      return;
    }

    // 1. 通道建立时间应早于查票开始时间
    if (buildStartTime >= checkStartTime) {
      this.errors.push(
        `❌ channelBuildPhase1.startTime (${phase1.startTime}) 应早于 checkRequest.startTime (${checkStartTimeStr})`
      );
    }

    // 2. 通道建立完成时间必须 ≤ 查票开始时间
    const buildWindowMs = phase1.windowTime || 30000;
    const buildEndTime = buildStartTime + buildWindowMs;

    if (buildEndTime > checkStartTime) {
      this.errors.push(
        `❌ 第一阶段通道建立结束时间 (${this.formatTimeMs(buildEndTime)}) 晚于查票开始时间 (${checkStartTimeStr})，` +
        `请调整 channelBuildPhase1.startTime 或 windowTime`
      );
    }

    // 3. 检查通道空闲时间（服务器约60秒后关闭空闲连接）
    const idleTimeMs = checkStartTime - buildStartTime;
    const maxIdleMs = CONFIG_CONSTANTS.CHANNEL_IDLE_TIMEOUT_SECONDS * 1000;

    if (idleTimeMs > maxIdleMs) {
      this.warnings.push(
        `⚠️ 通道建立后到查票开始的间隔 (${Math.round(idleTimeMs/1000)}秒) 超过服务器空闲超时 (${CONFIG_CONSTANTS.CHANNEL_IDLE_TIMEOUT_SECONDS}秒)，` +
        `部分通道可能被服务器关闭（实际有心跳保活，此警告可忽略）`
      );
    }

    // 4. 验证查票最小请求间隔
    if (checkReq.minInterval !== undefined && checkReq.minInterval < 1) {
      this.errors.push(`❌ checkRequest.minInterval (${checkReq.minInterval}ms) 必须大于0`);
    }

  }

  /**
   * 验证数值配置
   */
  validateNumbers() {
    const timeouts = this.config.timeout || {};
    const pool = this.config.connectionPool || {};
    const phase1 = this.config.channelBuildPhase1 || {};
    const checkReq = this.config.checkRequest || {};
    const lockReq = this.config.lockRequest || {};

    // 1. 验证超时配置
    for (const [key, val] of Object.entries(timeouts)) {
      if (val !== undefined) {
        if (val < CONFIG_CONSTANTS.MIN_TIMEOUT_MS) {
          this.warnings.push(
            `⚠️ timeout.${key} (${val}ms) 过小，建议至少 ${CONFIG_CONSTANTS.MIN_TIMEOUT_MS}ms`
          );
        }
        if (val > CONFIG_CONSTANTS.MAX_TIMEOUT_MS) {
          this.warnings.push(
            `⚠️ timeout.${key} (${val}ms) 过大，建议不超过 ${CONFIG_CONSTANTS.MAX_TIMEOUT_MS}ms`
          );
        }
      }
    }

    // 2. 验证第一阶段通道创建尝试次数
    if (phase1.attempts !== undefined) {
      if (phase1.attempts < 1) {
        this.errors.push(
          `❌ channelBuildPhase1.attempts (${phase1.attempts}) 必须大于0`
        );
      }
      if (phase1.attempts > CONFIG_CONSTANTS.MAX_CHANNELS_PER_PROXY) {
        this.warnings.push(
          `⚠️ channelBuildPhase1.attempts (${phase1.attempts}) 过大，可能导致资源耗尽`
        );
      }
    }

    // 3. 验证锁号请求配置（global 模式）
    const lockGlobalNum = (lockReq && lockReq.global) || {};
    if (lockGlobalNum.windowTime !== undefined && lockGlobalNum.windowTime <= 0) {
      this.errors.push(`❌ lockRequest.global.windowTime 必须大于0`);
    }

    if (lockGlobalNum.reservedChannels !== undefined && lockGlobalNum.reservedChannels < 0) {
      this.errors.push(`❌ lockRequest.global.reservedChannels 不能为负数`);
    }

  }

  /**
   * 验证目标主机配置
   */
  validateTargetHosts() {
    const pool = this.config.connectionPool;
    if (!pool || !pool.targetHosts) return;

    if (!Array.isArray(pool.targetHosts) || pool.targetHosts.length === 0) {
      this.errors.push(`❌ connectionPool.targetHosts 必须是非空数组`);
      return;
    }

    // 已知的合法IP（hlwyl.gamyy.cn 的DNS解析结果）
    const knownIPs = ['123.114.40.188', '123.114.40.189', '59.110.54.146'];

    for (const host of pool.targetHosts) {
      if (!host.host || !host.port) {
        this.errors.push(`❌ targetHosts 中的每个元素必须包含 host 和 port`);
        continue;
      }

      // 验证端口
      if (host.port !== 443) {
        this.warnings.push(
          `⚠️ targetHost ${host.host}:${host.port} 使用非标准HTTPS端口`
        );
      }

      // 验证IP是否已知
      if (!knownIPs.includes(host.host)) {
        this.warnings.push(
          `⚠️ targetHost ${host.host} 不在已知IP列表中 (${knownIPs.join(', ')})`
        );
      }
    }
  }

  /**
   * 验证模式配置
   */
  validateModes() {
    // 验证checkMode
    const validCheckModes = ['doctor', 'dept'];
    if (this.config.checkMode && !validCheckModes.includes(this.config.checkMode)) {
      this.errors.push(
        `❌ checkMode (${this.config.checkMode}) 无效，必须是: ${validCheckModes.join(', ')}`
      );
    }

    // 验证doctorSource
    const validDoctorSources = ['config', 'database'];
    if (this.config.doctorSource && !validDoctorSources.includes(this.config.doctorSource)) {
      this.errors.push(
        `❌ doctorSource (${this.config.doctorSource}) 无效，必须是: ${validDoctorSources.join(', ')}`
      );
    }

    // 验证doctorSelectMode
    const validDoctorSelectModes = ['random', 'perProxy', 'perAccount'];
    if (this.config.doctorSelectMode && !validDoctorSelectModes.includes(this.config.doctorSelectMode)) {
      this.errors.push(
        `❌ doctorSelectMode (${this.config.doctorSelectMode}) 无效，必须是: ${validDoctorSelectModes.join(', ')}`
      );
    }

  }

  // ========== 辅助方法 ==========

  /**
   * 解析日期字符串 (YYYY-MM-DD)
   */
  parseDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    if (isNaN(date.getTime())) return null;
    return date;
  }

  /**
   * 格式化日期为 YYYY-MM-DD
   */
  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * 解析时间字符串 (HH:MM:SS.mmm) 返回毫秒数
   */
  parseTimeString(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const match = timeStr.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/);
    if (!match) return null;
    const hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const seconds = parseInt(match[3]);
    const millis = match[4] ? parseInt(match[4]) : 0;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
  }

  /**
   * 格式化毫秒数为时间字符串
   */
  formatTimeMs(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const millis = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  /**
   * 打印验证结果
   */
  printResult() {
    const result = this.validate();

    console.log('\n📋 ========== 配置验证结果 ==========\n');

    if (result.errors.length > 0) {
      console.log('❌ 错误 (需要修复):');
      result.errors.forEach(err => console.log(`   ${err}`));
      console.log('');
    }

    if (result.warnings.length > 0) {
      console.log('⚠️ 警告 (建议检查):');
      result.warnings.forEach(warn => console.log(`   ${warn}`));
      console.log('');
    }

    if (result.valid && result.warnings.length === 0) {
      console.log('✅ 配置验证通过，无问题\n');
    } else if (result.valid) {
      console.log('✅ 配置可用，但存在上述警告\n');
    } else {
      console.log('❌ 配置存在错误，但程序将继续运行\n');
    }

    console.log('=====================================\n');

    return result;
  }
}

// 导出常量供其他模块使用
module.exports = ConfigValidator;
module.exports.CONFIG_CONSTANTS = CONFIG_CONSTANTS;
