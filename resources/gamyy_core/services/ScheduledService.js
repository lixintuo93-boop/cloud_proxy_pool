// services/ScheduledService.js - 单阶段通道创建版本（按代理独立运行）

const { checkReq: pickCheckReq, lockGlobal: pickLockGlobal, channelPhase1: pickChannelPhase1 } = require('./_proxyCfg');

// 构建代理唯一键：优先用真实出口IP
function buildProxyKey(proxyConfig) {
  return proxyConfig.realProxyIp || `${proxyConfig.host}:${proxyConfig.port}`;
}

class ScheduledService {
  constructor(ticketService, accountManager, channelManager, channelStarter, config) {
    this.config = config;
    this.ticketService = ticketService;
    this.accountManager = accountManager;
    this.channelManager = channelManager;
    this.channelStarter = channelStarter;
    
    this.scheduledRunning = false;
    this.connectionPoolInitialized = false;
    this.accounts = [];
    
    // 定时器
    this.phase1Timers = [];        // 第一阶段通道创建定时器
    this.checkStartTimer = null;   // 查票开始定时器
    this.statsDisplayTimer = null; // 统计显示定时器
    this.excessMonitorTimer = null; // 定时轮询关闭多余通道定时器
    this.proxyClassifierTimer = null; // 定时轮询代理分类定时器
    this.checkWindowEndTimer = null;  // 查票窗口结束自动停止定时器
    this.globalFallbackTimer = null;  // 全局兜底超时定时器

    this.onAutoStop = null;

    // 🆕 代理分类：已被判定为早衰退并停止的代理集合
    this.classifiedBadProxies = new Set();
    
    // 🆕 早停相关数据结构
    this.proxyPhase1Timers = new Map();   // proxyKey -> [timers] 按代理组织的第一阶段定时器
    this.proxyLastSuccessTime = new Map(); // proxyKey -> timestamp 每个代理的最后成功时间
    this.proxyEarlyStopped = new Map();       // proxyKey -> boolean 每个代理的早停状态
    this.proxyEarlyStopThreshold = new Map(); // proxyKey -> number  每个代理的早停阈值（ms）
    this.proxyAutoCloseConfig = new Map();    // proxyKey -> { enabled, maxSuccessChannels }
    this.proxyMaxAliveChannels = new Map();   // proxyKey -> number  每个代理的最大存活通道数上限（0=不限）
    
    // 时间戳
    this.phase1StartTimestamp = null;
    this.phase1EndTimestamp = null;
    this.checkStartTimestamp = null;      // 查票开始时间
    this.checkWindowEndTimestamp = null;  // 查票窗口终点 = checkStartTimestamp + windowTime
    
    // 🆕 按代理统计各阶段通道创建信息
    this.proxyChannelStats = new Map();  // proxyKey -> { phase1 }
    
    // 🆕 按代理的随机偏移量（已弃用，由自适应查票开始时间替代）
    // this.proxyRandomOffsets = new Map();  // proxyKey -> offset

    // 每个代理经覆盖配置后的实际 phase1 开始时间戳（代理级 > 任务级）
    this.proxyPhase1StartTimestamps = new Map(); // proxyKey -> timestamp

    // 统计显示行数跟踪
    this.lastDisplayedLineCount = 0;
    // 🆕 上次显示的代理数量
    this.lastProxyCount = 0;
  }

  async startScheduledCheck(accounts, onAutoStop) {
    if (this.scheduledRunning) return;

    this.scheduledRunning = true;
    this.accounts = accounts;
    this.onAutoStop = onAutoStop || null;

    try {
      await this.initializeConnectionPoolWithoutConnect();
      this.calculateTimestamps();

      // 初始化统计并绑定全量代理通道（所有候选代理在此阶段全部参与建连）
      this.initializeAccountStats(accounts);
      this.initializeAccountChannelAssignments(accounts);

      // 提前设置事件日志回调（在统计显示之前）
      this.ticketService.setBeforeEventLogCallback(() => this.resetStatsDisplayLineCount());

      // 🆕 设置号源售罄回调（用于停止所有使用该planId的锁号调度器）
      this.ticketService.setPlanExhaustedCallback((planId) => {
        if (this.channelStarter) {
          this.channelStarter.stopLockSchedulersByPlanId(planId);
        }
      });

      // 传递自动停止回调给 channelStarter
      if (this.onAutoStop) {
        this.channelStarter.setOnAutoStop(this.onAutoStop);
      }

      // 先设置第一阶段通道创建（这会初始化 proxyChannelStats）
      this.setupPhase1Timers();

      this.printScheduleInfo();

      // 🆕 启动定时轮询监控：P1 启动后开始，查票开始时停止
      this.startExcessChannelMonitor();

      // 🆕 启动代理分类定时监控
      this.startProxyClassifierMonitor();

      // 开始显示统计
      this.startStatsDisplay();

      // 设置查票开始定时器
      this.setupCheckStartTimer(accounts);

      // 设置自动停止定时器（P1: 查票窗口结束 + 全局兜底）
      this._setupAutoStopTimers();
    } catch (error) {
      console.error('❌ 定时查票启动失败:', error.message);
      this.scheduledRunning = false;
    }
  }

  _setupAutoStopTimers() {
    if (!this.onAutoStop) return;

    // P1 Condition 3: 查票窗口结束且未触发任何锁号 → 等在途查票请求全部完成后再停止
    const checkWindowDelay = Math.max(0, this.checkWindowEndTimestamp - Date.now());
    this.checkWindowEndTimer = setTimeout(() => {
      if (!this.scheduledRunning) return;
      if (!this.channelStarter.anyLockTriggered) {
        this._waitPendingThenAutoStop('check', 'check_window_expired');
      }
    }, checkWindowDelay);

    // P1 Condition 8: 全局兜底超时 = 查票窗口结束 + 锁号窗口 + 30s 缓冲
    // 用所有代理中最长的 lockWindow，确保兜底足够长（严格 per-proxy）
    const lockWindows = (this.config._proxies || []).map(p =>
      (p.cfg?.lockRequest?.global?.windowTime) ?? 30000
    );
    const lockWindowTime = lockWindows.length ? Math.max(...lockWindows) : 30000;
    const globalFallbackDelay = Math.max(0, this.checkWindowEndTimestamp + lockWindowTime + 30000 - Date.now());
    this.globalFallbackTimer = setTimeout(() => {
      if (!this.scheduledRunning) return;
      this.onAutoStop('global_fallback_timeout');
    }, globalFallbackDelay);
  }

  // 等待指定类型的在途请求全部完成后再触发自动停止
  _waitPendingThenAutoStop(requestType, reason) {
    const pool = this.ticketService?.connectionPool;
    if (!pool) {
      this.onAutoStop?.(reason);
      return;
    }
    const poll = () => {
      if (!this.scheduledRunning) return;
      if (this.channelStarter.anyLockTriggered) return;
      const pending = pool.countPendingRequestsByType(requestType);
      if (pending > 0) {
        setTimeout(poll, 200);
      } else {
        if (this.scheduledRunning && !this.channelStarter.anyLockTriggered) {
          this.onAutoStop(reason);
        }
      }
    };
    poll();
  }

  // ==================== 时间计算 ====================

  // 通过 proxyKey 反查 proxyConfig（从 connectionPool 的通道里取）
  _getProxyConfigByKey(proxyKey) {
    const channels = this.ticketService?.connectionPool?.getChannelsByProxy?.(proxyKey);
    return (channels && channels[0] && channels[0].proxyConfig) || null;
  }

  // 获取指定代理的最大需求通道数（per-proxy）
  getMaxChannelsNeeded(proxyKey) {
    const cfg = this.proxyAutoCloseConfig.get(proxyKey);
    if (!cfg?.enabled) return Infinity;
    if (cfg.maxSuccessChannels !== 'auto' && cfg.maxSuccessChannels != null) return Number(cfg.maxSuccessChannels);
    // 'auto': 按代理自己的查票窗口 / 间隔计算
    const proxyConfig = this._getProxyConfigByKey(proxyKey);
    const checkReq   = pickCheckReq(this.config, proxyConfig);
    const lockGlobal = pickLockGlobal(this.config, proxyConfig);
    return Math.floor((checkReq.windowTime || 10000) / (checkReq.minInterval || 250)) + (lockGlobal.reservedChannels || 0);
  }
  
  // 检查是否触发早停（per-proxy，阈值=Infinity 时等价于禁用）
  checkEarlyStop(proxyKey) {
    if (this.proxyEarlyStopped.get(proxyKey)) return true;

    const stats = this.proxyChannelStats.get(proxyKey);
    if (!stats) return false;

    const lastSuccessTime = this.proxyLastSuccessTime.get(proxyKey);
    const baseTime = lastSuccessTime || this.proxyPhase1StartTimestamps.get(proxyKey) || this.phase1StartTimestamp;
    
    // 检查静默时间：超过该代理自己的阈值就触发早停
    const silentTime = Date.now() - baseTime;
    const threshold = this.proxyEarlyStopThreshold.get(proxyKey) ?? Infinity;
    if (silentTime >= threshold) {
      // 触发早停
      this.proxyEarlyStopped.set(proxyKey, true);
      
      // 取消该代理的所有剩余第一阶段定时器
      const timers = this.proxyPhase1Timers.get(proxyKey);
      let cancelledCount = 0;
      if (timers) {
        timers.forEach(timer => {
          if (timer && !timer._called) {
            clearTimeout(timer);
            cancelledCount++;
          }
        });
      }
      
      // 输出早停日志
      const baseDesc = lastSuccessTime ? '最后成功' : '开始时间';
      this.ticketService.printEventLog(
        `🛑 [${proxyKey}] 早停触发：成功${stats.phase1.success}个通道，距${baseDesc}静默${Math.round(silentTime/1000)}秒，取消${cancelledCount}个定时器`
      );

      // 🆕 早停事件 → 触发代理分类检查
      const classifierCfg = this.config.proxyClassifier;
      if (classifierCfg && classifierCfg.enabled &&
          (classifierCfg.triggerMode === 'event' || classifierCfg.triggerMode === 'both')) {
        this.classifyAndStopBadProxies();
      }

      return true;
    }
    
    return false;
  }
  
  // 统计某代理当前存活（已连接且未停止）的通道数量
  _countAliveChannels(proxyKey) {
    const channels = this.ticketService?.connectionPool?.getChannelsByProxy(proxyKey) || [];
    return channels.filter(ch => ch.isConnected && !ch.isStopped).length;
  }

  // 关闭多余通道（保留过期时间最晚的，per-proxy）
  closeExcessChannels(proxyKey) {
    const cfg = this.proxyAutoCloseConfig.get(proxyKey);
    if (!cfg?.enabled) return;

    const proxyChannels = this.ticketService.connectionPool.getChannelsByProxy(proxyKey);
    const connectedChannels = proxyChannels.filter(ch => ch.isConnected && !ch.isStopped);
    const maxChannelsNeeded = this.getMaxChannelsNeeded(proxyKey);
    
    // 如果没有超过最大需求数，不需要关闭
    if (connectedChannels.length <= maxChannelsNeeded) return;
    
    // 按连接时间升序排序（最早连接的在前）
    connectedChannels.sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));
    
    // 计算需要关闭的数量
    const closeCount = connectedChannels.length - maxChannelsNeeded;
    
    // 关闭过期时间最早的通道
    let closedCount = 0;
    for (let i = 0; i < closeCount; i++) {
      const channel = connectedChannels[i];
      if (channel && channel.isConnected) {
        channel.close();
        closedCount++;
      }
    }
    
    if (closedCount > 0) {
      this.ticketService.printEventLog(
        `🔄 [${proxyKey}] 关闭多余通道：存活${connectedChannels.length}个 > 需求${maxChannelsNeeded}个，关闭${closedCount}个即将过期的通道`
      );
    }
  }

  // 🆕 启动定时轮询监控：从 P1 启动到查票开始，按 monitorInterval 周期检查各代理多余通道
  // 改为 per-proxy 决定是否启用 + 取最小 monitorInterval 作为轮询间隔
  startExcessChannelMonitor() {
    const proxies = this.config._proxies || [];
    const enabledIntervals = proxies
      .map(p => p.cfg?.channelBuildPhase1?.autoCloseExcess)
      .filter(ace => ace && ace.enabled && (ace.monitorInterval || 0) > 0)
      .map(ace => ace.monitorInterval);
    if (enabledIntervals.length === 0) return;

    const monitorInterval = Math.min(...enabledIntervals);

    this.excessMonitorTimer = setInterval(() => {
      if (!this.scheduledRunning) return;
      this.proxyChannelStats.forEach((stats, proxyKey) => {
        this.closeExcessChannels(proxyKey);
      });
    }, monitorInterval);
  }

  // 🆕 停止定时轮询监控
  stopExcessChannelMonitor() {
    if (this.excessMonitorTimer) {
      clearInterval(this.excessMonitorTimer);
      this.excessMonitorTimer = null;
    }
  }

  // ==================== 代理分类停止 ====================

  /**
   * 🆕 启动代理分类定时监控
   * triggerMode 为 'timer' 或 'both' 时，按 monitorInterval 周期调用 classifyAndStopBadProxies
   */
  startProxyClassifierMonitor() {
    const cfg = this.config.proxyClassifier;
    if (!cfg || !cfg.enabled) return;
    if (cfg.triggerMode === 'event') return;

    const interval = cfg.monitorInterval || 20000;
    if (interval <= 0) return;

    this.proxyClassifierTimer = setInterval(() => {
      if (!this.scheduledRunning) return;
      this.classifyAndStopBadProxies();
    }, interval);
  }

  /**
   * 🆕 停止代理分类定时监控
   */
  stopProxyClassifierMonitor() {
    if (this.proxyClassifierTimer) {
      clearInterval(this.proxyClassifierTimer);
      this.proxyClassifierTimer = null;
    }
  }

  /**
   * 🆕 代理分类主算法：基于 proxyLastSuccessTime 排序，找最大间隔，统计阈值判断显著性
   * 将早衰退代理停止全部活动
   */
  classifyAndStopBadProxies() {
    const cfg = this.config.proxyClassifier;
    if (!cfg || !cfg.enabled) return;

    // 收集所有有记录的代理（包括已停止的，保证排序基准不变）
    const proxyTimes = [];
    this.proxyLastSuccessTime.forEach((time, proxyKey) => {
      proxyTimes.push({ proxyKey, time });
    });

    if (proxyTimes.length < (cfg.minProxies || 2)) return;

    // 按最后成功时间升序排列
    proxyTimes.sort((a, b) => a.time - b.time);

    // 计算相邻差值
    const gaps = [];
    for (let i = 1; i < proxyTimes.length; i++) {
      gaps.push(proxyTimes[i].time - proxyTimes[i - 1].time);
    }

    // 计算统计阈值
    const method = cfg.thresholdMethod || 'stddev';
    let threshold;

    if (method === 'iqr') {
      const sorted = [...gaps].sort((a, b) => a - b);
      const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)];
      const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)];
      threshold = q3 + 1.5 * (q3 - q1);
    } else {
      // stddev（默认）
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
      threshold = mean + Math.sqrt(variance);
    }

    // 最小有效间隔（绝对值保护，防止时间差极小时误分类）
    const minGapMs = cfg.minGapMs || 15000;

    // 找最左边的显著间隔（即：第一个既超统计阈值、又超绝对下限的间隔）
    let splitIndex = -1;
    for (let i = 0; i < gaps.length; i++) {
      if (gaps[i] > threshold && gaps[i] >= minGapMs) {
        splitIndex = i;
        break;
      }
    }

    if (splitIndex === -1) return; // 没有显著间隔，无需分类

    // splitIndex 左侧（含）为早衰退代理
    const badProxies = proxyTimes.slice(0, splitIndex + 1);

    let newlyStopped = 0;
    badProxies.forEach(({ proxyKey, time }) => {
      if (this.classifiedBadProxies.has(proxyKey)) return; // 已处理过，跳过
      this.classifiedBadProxies.add(proxyKey);
      this.stopProxyAllActivities(proxyKey);
      this.ticketService.printEventLog(
        `🔴 [分类停止] ${proxyKey} 末次成功:${this.formatLocalTime(time)}，判定为早衰退，停止全部活动`
      );
      newlyStopped++;
    });

    if (newlyStopped > 0) {
      const goodProxies = proxyTimes.slice(splitIndex + 1);
      this.ticketService.printEventLog(
        `📊 [分类结果] 停止${newlyStopped}个早衰退代理（间隔${Math.round(gaps[splitIndex] / 1000)}s > 阈值${Math.round(threshold / 1000)}s），` +
        `保留${goodProxies.length}个代理继续运行`
      );
    }
  }

  /**
   * 🆕 停止某个代理的全部活动（P1/P2/P3 定时器 + 心跳 + 已有通道）
   */
  stopProxyAllActivities(proxyKey) {

    // 1. 设置早停标记，防止后续 P1 定时器回调继续运行
    this.proxyEarlyStopped.set(proxyKey, true);

    // 2. 取消剩余 P1 定时器
    const p1Timers = this.proxyPhase1Timers.get(proxyKey);
    if (p1Timers) {
      p1Timers.forEach(timer => clearTimeout(timer));
    }

    this.ticketService.connectionPool.stopHeartbeatsByProxy(proxyKey);

    // 6. 关闭现有通道
    const channels = this.ticketService.connectionPool.getChannelsByProxy(proxyKey);
    channels.forEach(ch => {
      if (ch && ch.isConnected) ch.close();
    });
  }

  calculateTimestamps() {
    const now = Date.now();
    const proxies = this.config._proxies || [];

    // 全局触发时间 = 各代理对应字段的最早值；全局窗口结束 = 最晚结束（严格 per-proxy，无 task 顶层兜底）
    let phase1Earliest = null;
    let checkEarliest = null;
    let checkLatestEnd = null;

    for (const p of proxies) {
      const ph1 = (p.cfg && p.cfg.channelBuildPhase1) || {};
      const ck  = (p.cfg && p.cfg.checkRequest) || {};
      if (ph1.startTime) {
        // graceMs = windowTime：任务启动恰好在 startTime 当口时，避免毫秒抖动滚到明天
        const ts = this.timeStringToTimestamp(ph1.startTime, now, ph1.windowTime || 0);
        phase1Earliest = phase1Earliest == null ? ts : Math.min(phase1Earliest, ts);
      }
      if (ck.startTime) {
        const ts = this.timeStringToTimestamp(ck.startTime, now, ck.windowTime || 10000);
        checkEarliest = checkEarliest == null ? ts : Math.min(checkEarliest, ts);
        const end = ts + (ck.windowTime || 10000);
        checkLatestEnd = checkLatestEnd == null ? end : Math.max(checkLatestEnd, end);
      }
    }

    // 没有任何代理给出 startTime 时，退化到 now（保持 setupCheckStartTimer/setupPhase1Timers 仍能工作）
    this.phase1StartTimestamp    = phase1Earliest ?? now;
    this.phase1EndTimestamp      = this.phase1StartTimestamp;  // 顶层无 windowTime 概念，结束时间由各代理 setupPhase1Timers 自管
    this.checkStartTimestamp     = checkEarliest  ?? now;
    this.checkWindowEndTimestamp = checkLatestEnd ?? (this.checkStartTimestamp + 10000);
  }

  // ==================== 第一阶段：初始通道创建 ====================
  
  setupPhase1Timers() {
    const channels = this.ticketService.connectionPool.channels;
    // task 顶层不再有 channelBuildPhase1，全部走 channel.proxyConfig.channelBuildOverride

    // 按代理IP轮询顺序重新排列通道
    const sortedChannels = this.sortChannelsByProxyRoundRobin(channels);

    // 🆕 初始化按代理统计和早停相关数据
    sortedChannels.forEach(channel => {
      const proxyKey = buildProxyKey(channel.proxyConfig);
      if (!this.proxyChannelStats.has(proxyKey)) {
        this.proxyChannelStats.set(proxyKey, {
          phase1: { total: 0, success: 0 },
        });
      }
      if (!this.proxyPhase1Timers.has(proxyKey)) {
        this.proxyPhase1Timers.set(proxyKey, []);
      }
      if (!this.proxyEarlyStopped.has(proxyKey)) {
        this.proxyEarlyStopped.set(proxyKey, false);
      }
    });

    if (sortedChannels.length > 0) {
      // 预计算每个代理的有效 phase1 配置（代理级覆盖优先于任务级）
      const now = Date.now();
      const proxyEffectivePhase1 = new Map(); // proxyKey -> { startTimestamp, windowTime }
      const proxyTotalChannels   = new Map(); // proxyKey -> 该代理通道总数（均匀分布用）
      sortedChannels.forEach(channel => {
        const proxyKey = buildProxyKey(channel.proxyConfig);
        if (!proxyEffectivePhase1.has(proxyKey)) {
          const ov  = channel.proxyConfig.channelBuildOverride || {};
          // 基础时序参数（严格 per-proxy）
          const effectiveStartTime  = ov.startTime    || '';
          const effectiveWindowTime = ov.windowTime   != null ? ov.windowTime : 0;
          const effectiveAttempts   = ov.attempts     != null ? ov.attempts   : 40;
          const effectiveDistrib    = ov.distribution || 'uniform';
          // 同 runGreedyAssignment：传 windowTime 作宽限期，避免任务启动时刻恰好踩到 startTime 上时整整滚 24h
          const startTs = effectiveStartTime
            ? this.timeStringToTimestamp(effectiveStartTime, now, effectiveWindowTime || 0)
            : now;
          proxyEffectivePhase1.set(proxyKey, { startTimestamp: startTs, windowTime: effectiveWindowTime, distribution: effectiveDistrib });
          this.proxyPhase1StartTimestamps.set(proxyKey, startTs);

          // 早停（严格 per-proxy）
          const ovES   = ov.earlyStop || {};
          const esEnabled = ovES.enabled !== undefined ? !!ovES.enabled : false;
          let threshold = Infinity;
          if (esEnabled) {
            const algo = ovES.algorithm ?? 'dynamic';
            if (algo === 'fixed') {
              threshold = ovES.fixedThreshold ?? 10000;
            } else {
              const mult = ovES.multiplier ?? 10;
              threshold  = Math.floor(effectiveWindowTime / Math.max(1, effectiveAttempts) * mult);
            }
          }
          this.proxyEarlyStopThreshold.set(proxyKey, threshold);

          // 自动关闭多余通道（严格 per-proxy）
          const ovACE = ov.autoCloseExcess || {};
          const aceEnabled = ovACE.enabled !== undefined ? !!ovACE.enabled : false;
          const aceMax     = ovACE.maxSuccessChannels;
          this.proxyAutoCloseConfig.set(proxyKey, { enabled: aceEnabled, maxSuccessChannels: aceMax });

          // 最大存活通道数（per-proxy，0 或未设置表示不限）
          const rawMaxAlive = ov.maxSuccessChannels ?? 0;
          this.proxyMaxAliveChannels.set(proxyKey, rawMaxAlive > 0 ? rawMaxAlive : 0);
        }
        proxyTotalChannels.set(proxyKey, (proxyTotalChannels.get(proxyKey) || 0) + 1);
      });

      // 均匀分布时追踪每个代理当前已分配序号
      const proxyCurrentIndex = new Map();

      // 公共定时器回调体（random 和 uniform 共用）
      const makeTimerCallback = (channel, proxyKey, stats) => () => {
        if (this.proxyEarlyStopped.get(proxyKey)) return;
        if (this.checkEarlyStop(proxyKey)) return;

        // 存活通道数已达上限 → 跳过本次创建，后续时间槽会继续尝试
        const maxAlive = this.proxyMaxAliveChannels.get(proxyKey) || 0;
        if (maxAlive > 0 && this._countAliveChannels(proxyKey) >= maxAlive) return;

        channel.attemptPhase = 1;
        stats.phase1.total++;

        channel.onConnectResult = (success) => {
          if (success) {
            stats.phase1.success++;
            this.proxyLastSuccessTime.set(proxyKey, Date.now());
            this.closeExcessChannels(proxyKey);
            if (this.channelStarter && Date.now() >= this.checkStartTimestamp) {
              this.channelStarter.scheduleNewChannelCheck(proxyKey, channel);
            }
          }
          this.checkEarlyStop(proxyKey);
        };

        this.connectChannel(channel, 1);
      };

      // 每个代理按自己的有效 distribution 独立计算触发时间
      sortedChannels.forEach((channel) => {
        const proxyKey = buildProxyKey(channel.proxyConfig);
        const { startTimestamp, windowTime, distribution: dist } = proxyEffectivePhase1.get(proxyKey);
        const stats = this.proxyChannelStats.get(proxyKey);

        let buildTime;
        if (dist === 'random') {
          buildTime = startTimestamp + Math.floor(Math.random() * windowTime);
        } else {
          // uniform（默认）：等间隔
          const totalForProxy = proxyTotalChannels.get(proxyKey);
          const idxForProxy   = proxyCurrentIndex.get(proxyKey) || 0;
          proxyCurrentIndex.set(proxyKey, idxForProxy + 1);
          buildTime = startTimestamp + Math.floor(idxForProxy * (windowTime / totalForProxy));
        }

        const delay = Math.max(0, buildTime - Date.now());
        const timer = setTimeout(makeTimerCallback(channel, proxyKey, stats), delay);
        this.phase1Timers.push(timer);
        this.proxyPhase1Timers.get(proxyKey).push(timer);
      });
    }
  }

  // ==================== 查票开始 ====================
  
  setupCheckStartTimer(accounts) {
    const delay = Math.max(0, this.checkStartTimestamp - Date.now());

    console.log(`🕒 [DBG-checkTimer] set: delay=${delay}ms, target=${new Date(this.checkStartTimestamp).toLocaleTimeString('zh-CN', { hour12: false })}.${String(this.checkStartTimestamp % 1000).padStart(3,'0')}, scheduledRunning=${this.scheduledRunning}, accounts=${accounts.length}`);

    this.checkStartTimer = setTimeout(() => {
      console.log(`🚀 [DBG-checkTimer] FIRED at ${this.formatLocalTime()}, scheduledRunning=${this.scheduledRunning}`);
      this.startTicketCheck(accounts);
    }, delay);
  }

  startTicketCheck(accounts) {
    if (!this.scheduledRunning) {
      console.log(`⚠️ [DBG-checkTimer] startTicketCheck early-return: scheduledRunning=false`);
      return;
    }
    console.log(`▶️ [DBG-checkTimer] startTicketCheck running, accounts=${accounts.length}`);

    // 🆕 查票开始，停止定时轮询监控（此后由查票阶段接管通道使用）
    this.stopExcessChannelMonitor();

    // 🆕 查票开始，停止代理分类监控
    this.stopProxyClassifierMonitor();

    // 设置统计更新回调
    this.ticketService.setStatsUpdateCallback(() => this.printRequestStats());
    
    // 传递scheduledService引用给channelStarter
    this.channelStarter.setScheduledService(this);
    
    // 启动查票调度器
    this.channelStarter.startAllProxyCheckSchedulers(
      accounts,
      () => this.scheduledRunning
    );
  }

  // ==================== 辅助方法 ====================
  
  async connectChannel(channel, phase) {
    if (!this.scheduledRunning) return;
    
    try {
      await channel.connect();
    } catch (error) {
      // 连接失败已通过回调处理
    }
  }

  sortChannelsByProxyRoundRobin(channels) {
    if (channels.length === 0) return [];
    
    // 按代理IP分组
    const proxyChannelsMap = new Map();
    channels.forEach(channel => {
      const proxyKey = buildProxyKey(channel.proxyConfig);
      if (!proxyChannelsMap.has(proxyKey)) {
        proxyChannelsMap.set(proxyKey, []);
      }
      proxyChannelsMap.get(proxyKey).push(channel);
    });
    
    // 获取所有代理IP列表
    const proxyKeys = Array.from(proxyChannelsMap.keys());
    
    // 获取每个代理最大的通道数量
    let maxChannelsPerProxy = 0;
    proxyChannelsMap.forEach(proxyChannels => {
      maxChannelsPerProxy = Math.max(maxChannelsPerProxy, proxyChannels.length);
    });
    
    // 轮询排列
    const sortedChannels = [];
    for (let i = 0; i < maxChannelsPerProxy; i++) {
      for (const proxyKey of proxyKeys) {
        const proxyChannels = proxyChannelsMap.get(proxyKey);
        if (i < proxyChannels.length) {
          sortedChannels.push(proxyChannels[i]);
        }
      }
    }
    
    return sortedChannels;
  }

  async initializeConnectionPoolWithoutConnect() {
    if (this.connectionPoolInitialized) return true;

    const proxyConfigs = this.getAllUniqueProxyConfigs();
    
    const ConnectionPool = require('./connectionPool');
    this.ticketService.connectionPool = new ConnectionPool(this.config);
    
    await this.ticketService.connectionPool.initializeWithoutConnect(proxyConfigs, this.ticketService.logDb);

    this.connectionPoolInitialized = true;
    return true;
  }

  getAllUniqueProxyConfigs() {
    // ✅ 使用 proxyManager.getAllProxyConfigs() 获取正确的配置
    // 这会将 username 映射到 userId，password 保持不变
    const allProxyConfigs = this.ticketService.proxyManager.getAllProxyConfigs();
    
    // 获取所有账号使用的代理，去重
    const uniqueProxies = new Map();
    
    this.accounts.forEach(account => {
      const accountId = account.id || account.account_id;
      const accountProxies = this.accountManager.getProxiesForAccount(accountId);
      
      accountProxies.forEach(accountProxy => {
        const proxyKey = buildProxyKey(accountProxy);
        if (!uniqueProxies.has(proxyKey)) {
          // 从 proxyManager 生成的配置中找到对应的代理
          const matchingConfig = allProxyConfigs.find(
            config => buildProxyKey(config) === proxyKey
          );
          
          if (matchingConfig) {
            uniqueProxies.set(proxyKey, matchingConfig);
          } else {
            console.warn(`⚠️ 未找到代理配置: ${proxyKey}`);
          }
        }
      });
    });
    
    const result = Array.from(uniqueProxies.values());
    return result;
  }

  initializeAccountStats(accounts) {
    accounts.forEach(account => {
      const accountId = account.id || account.account_id;
      const proxyConfigs = this.accountManager.getProxiesForAccount(accountId);

      if (proxyConfigs && proxyConfigs.length > 0) {
        // 统计初始化时通道数暂用 0，动态分配完成后实际通道数由 getChannelsByProxy 动态读取
        this.ticketService.initAccountStats(accountId, account.mobile, 0);

        proxyConfigs.forEach(proxy => {
          const proxyKey = buildProxyKey(proxy);
          const proxyChannels = this.ticketService.connectionPool.getChannelsByProxy(proxyKey);
          this.ticketService.initProxyStats(proxyKey, accountId, account.mobile, proxy.host, proxy.port, proxyChannels.length, proxy.realProxyIp);
        });
      }
    });
  }

  initializeAccountChannelAssignments(accounts) {
    accounts.forEach(account => {
      const accountId = account.id || account.account_id;
      const proxyConfigs = this.accountManager.getProxiesForAccount(accountId);

      if (proxyConfigs && proxyConfigs.length > 0) {
        this.ticketService.connectionPool.assignChannelsToAccount(accountId, proxyConfigs);
      }
    });
  }

  // ==================== 统计显示 ====================
  // 已移除：之前每秒一行的 ⏱ + 代理统计 console.log 噪声太大。
  // Web GUI 仍能通过 getProxyStats() 拿到结构化数据自行展示。

  // 保留空方法名，避免外部调用方报错（startScheduledCheck/setBeforeEventLogCallback 仍会调到）
  startStatsDisplay() { /* no-op：终端不再打印代理统计 */ }
  resetScrollRegion()         { /* no-op，已废弃 */ }
  resetStatsDisplayLineCount(){ /* no-op，已废弃 */ }
  printRequestStats()         { /* no-op，已废弃 */ }

  // 返回结构化代理统计供 Web GUI 使用
  getProxyStats() {
    const proxyStats = this.ticketService.getProxyStats();
    const pool = this.ticketService.connectionPool;
    return proxyStats.map(proxy => {
      const proxyKey = buildProxyKey(proxy);
      let total = 0, connected = 0, idle = 0;
      let channels = [];
      if (pool) {
        channels  = pool.getChannelsByProxy(proxyKey) || [];
        total     = channels.length;
        connected = channels.filter(ch => ch.isConnected).length;
        idle      = channels.filter(ch => ch.isAvailableForRequest()).length;
      }
      const cs = this.proxyChannelStats.get(proxyKey) || { phase1: { total: 0, success: 0 } };
      const hbTotal   = channels.reduce((s, ch) => s + (ch.heartbeatCount        || 0), 0);
      const hbSuccess = channels.reduce((s, ch) => s + (ch.heartbeatSuccessCount || 0), 0);
      return {
        proxyKey,
        realProxyIp: proxy.realProxyIp,
        host:        proxy.host,
        port:        proxy.port,
        channels:    { total, connected, idle },
        phase1:      { total: cs.phase1.total, success: cs.phase1.success },
        check:       { ...proxy.check },
        lock:        { ...proxy.lock },
        heartbeat:   { total: hbTotal, success: hbSuccess },
      };
    });
  }

  printScheduleInfo() {
    const proxies = this.config._proxies || [];
    const totalChannels = this.ticketService.connectionPool.channels.length;

    console.log('\n📅 === 任务运行配置 ===');
    console.log(`代理数: ${proxies.length}，通道总数: ${totalChannels}`);

    // 代理分类（系统级）
    const classifierCfg = this.config.proxyClassifier;
    if (classifierCfg && classifierCfg.enabled) {
      console.log(`代理分类: 启用，触发:${classifierCfg.triggerMode}，轮询:${classifierCfg.monitorInterval}ms，` +
        `最少代理:${classifierCfg.minProxies || 2}，阈值算法:${classifierCfg.thresholdMethod || 'stddev'}，最小间隔:${classifierCfg.minGapMs || 15000}ms`);
    } else {
      console.log(`代理分类: 禁用`);
    }

    if (proxies.length > 0) {
      console.log(`\n📋 各代理生效配置：`);
      for (const p of proxies) {
        const pCfg = p.cfg || {};
        const ph1  = pCfg.channelBuildPhase1 || {};
        const ck   = pCfg.checkRequest       || {};
        const lk   = (pCfg.lockRequest && pCfg.lockRequest.global) || {};
        const reuse = ck.reuseChannel || {};
        const proxyTag = p.realProxyIp || `${p.host}:${p.port}`;
        const ckWinSec = (ck.windowTime || 0) / 1000;
        const ckMaxN   = ck.minInterval ? Math.floor((ck.windowTime || 0) / ck.minInterval) : 0;

        const lines = [];
        lines.push(`  ▸ ${proxyTag} (id=${p.id})`);
        lines.push(`    通道: ${ph1.startTime || '—'} 开始，窗口${(ph1.windowTime || 0)/1000}s，尝试${ph1.attempts ?? '—'}次，分布:${ph1.distribution || 'uniform'}`);
                if (ph1.maxSuccessChannels) lines.push(`         最大存活通道:${ph1.maxSuccessChannels}`);
        if (ph1.earlyStop?.enabled) {
          const es = ph1.earlyStop;
          const desc = es.algorithm === 'fixed' ? `固定${es.fixedThreshold || 10000}ms` : `动态×${es.multiplier || 10}`;
          lines.push(`         早停: 启用 (${desc})`);
        }
        if (ph1.autoCloseExcess?.enabled) {
          const ace = ph1.autoCloseExcess;
          lines.push(`         自动关闭多余: max=${ace.maxSuccessChannels ?? 'auto'}，monitorInterval=${ace.monitorInterval ?? 0}ms`);
        }
        lines.push(`    查号: ${ck.startTime || '—'} 开始，窗口${ckWinSec}s，最多${ckMaxN}次，分布:${ck.distribution || 'uniform'}，停止阈值:${ck.stopAfterFoundCount ?? 3}`);
        lines.push(`         模式:${pCfg.checkMode || 'doctor'}${pCfg.checkMode === 'dept' ? `（科室:${pCfg.deptQueryParams?.deptCode || '—'}）` : `（医生来源:${pCfg.doctorSource || 'config'}/${pCfg.doctorSelectMode || 'random'}）`}`);
        if (reuse.enabled) {
          lines.push(`         通道复用: 启用，最小间隔${reuse.minInterval || 0}ms，超时:${reuse.reuseOnTimeout ? '复用' : '不复用'}，错误:${reuse.reuseOnError ? '复用' : '不复用'}`);
        }
        lines.push(`    锁号: 预留${lk.reservedChannels ?? 0}通道，窗口${(lk.windowTime || 0)/1000}s，间隔${lk.minInterval ?? 0}ms，Sign:${lk.submitSignStrategy || '—'}` +
                   (lk.lockStartTime ? `，开始时间:${lk.lockStartTime}` : '，立即开始') +
                   (lk.firstLockDelayMs ? `，首次延迟${lk.firstLockDelayMs}ms` : '') +
                   (lk.directRequestOnNoChannel ? '，无通道时直连' : ''));

        console.log(lines.join('\n'));
      }
    }

    console.log('========================\n');
  }

  // ==================== 停止 ====================
  
  stopScheduledCheck() {
    this.scheduledRunning = false;
    
    // 清理第一阶段定时器
    this.phase1Timers.forEach(timer => clearTimeout(timer));
    this.phase1Timers = [];
    
    // 🆕 清理按代理组织的第一阶段定时器
    this.proxyPhase1Timers.forEach(timers => {
      timers.forEach(timer => clearTimeout(timer));
    });
    this.proxyPhase1Timers.clear();
    
    // 🆕 清理早停相关数据
    this.proxyLastSuccessTime.clear();
    this.proxyEarlyStopped.clear();
    this.proxyPhase1StartTimestamps.clear();
    
    // 清理查票开始定时器
    if (this.checkStartTimer) {
      clearTimeout(this.checkStartTimer);
      this.checkStartTimer = null;
    }

    // 清理自动停止定时器
    if (this.checkWindowEndTimer) {
      clearTimeout(this.checkWindowEndTimer);
      this.checkWindowEndTimer = null;
    }
    if (this.globalFallbackTimer) {
      clearTimeout(this.globalFallbackTimer);
      this.globalFallbackTimer = null;
    }

    // 🆕 停止定时轮询监控（防止未到查票开始就调用了 stop）
    this.stopExcessChannelMonitor();

    // 🆕 停止代理分类监控
    this.stopProxyClassifierMonitor();
    
    // 清理统计显示定时器
    if (this.statsDisplayTimer) {
      clearInterval(this.statsDisplayTimer);
      this.statsDisplayTimer = null;
    }
    
    // 🆕 重置滚动区域
    this.resetScrollRegion();
    
    if (this.channelStarter) {
      this.channelStarter.stopAllSchedulers();
    }

    console.log('\n🛑 定时查票已停止');
  }

  // ==================== 时间工具 ====================
  
  // graceMs：判定"已过期需滚到明天"的宽限期。setTimeout 总有微小漂移（通常 1~50ms），
  // 当 calculateTimestamps 时的"checkStartTimestamp = today 21:31:50.000"在 setTimeout 触发瞬间
  // 变成 now=21:31:50.030 时，原版 if (target <= ref) 会判 TRUE 并整整滚 24 小时。
  // 调用方传一个合理的宽限期（比如 windowTime）即可避免此抖动。
  timeStringToTimestamp(timeStr, referenceTime = Date.now(), graceMs = 0) {
    const [timePart, millisPart] = timeStr.split('.');
    const [hours, minutes, seconds] = timePart.split(':').map(Number);
    const millis = millisPart ? parseInt(millisPart) : 0;

    const referenceDate = new Date(referenceTime);
    const targetDate = new Date(referenceDate);

    targetDate.setHours(hours, minutes, seconds, millis);

    // 仅当 targetDate 已经过 graceMs 之外才滚到明天
    if (targetDate.getTime() + graceMs < referenceDate.getTime()) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    return targetDate.getTime();
  }

  formatLocalTime(timestamp = Date.now()) {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}.${String(date.getMilliseconds()).padStart(3,'0')}`;
  }
}

module.exports = ScheduledService;
