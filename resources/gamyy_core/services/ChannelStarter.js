// services/ChannelStarter.js - 简化版：不区分查号/锁号通道

const { checkReq: pickCheckReq, lockGlobal: pickLockGlobal } = require('./_proxyCfg');

// 构建代理唯一键：优先用真实出口IP
function buildProxyKey(proxyConfig) {
  return proxyConfig.realProxyIp || `${proxyConfig.host}:${proxyConfig.port}`;
}

// ========== 常量定义 ==========
const CHANNEL_STARTER_CONSTANTS = {
  // 查号请求日志输出间隔（每N个请求输出一次）
  CHECK_LOG_INTERVAL: 20,
  // 锁号请求日志输出间隔（每N个请求输出一次）
  LOCK_LOG_INTERVAL: 10,
  // 通道连接进度输出间隔
  CHANNEL_PROGRESS_INTERVAL: 10,
};

class ChannelStarter {
  constructor(ticketService, accountManager, channelManager, config) {
    this.config = config;
    this.ticketService = ticketService;
    this.accountManager = accountManager;
    this.channelManager = channelManager;
    
    this.proxyCheckSchedulers = new Map();
    this.proxyLockSchedulers = new Map();
    this.proxyFoundCount = new Map();
    this.isRunning = false;

    this.scheduledService = null;
    this.onAutoStop = null;
    this.anyLockTriggered = false;
    this.anyLockSuccess = false;
  }

  setScheduledService(scheduledService) {
    this.scheduledService = scheduledService;
  }

  setOnAutoStop(callback) {
    this.onAutoStop = callback;
  }

  formatTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  }

  // 将 "HH:MM:SS.mmm" 解析为今天该时刻的绝对毫秒时间戳
  _parseLockStartTime(timeStr) {
    if (!timeStr) return null;
    const m = timeStr.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return null;
    const ms = m[4] ? parseInt(m[4].padEnd(3, '0')) : 0;
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), ms).getTime();
  }

  async startAllProxyCheckSchedulers(accounts, immediateRunning) {
    this.isRunning = true;
    
    // 心跳在查票窗口期间持续运行，isBusy 标志保证心跳与查票/锁号互不干扰
    // 心跳返回时也可触发补充查票（通道刚刷新寿命，状态最佳）
    // 设置心跳恢复回调：心跳完成后安排该通道进行查票
    this.ticketService.connectionPool.setHeartbeatRecoveredCallback((channel) => {
      const proxyKey = buildProxyKey(channel.proxyConfig);
      this.scheduleNewChannelCheck(proxyKey, channel);
    });
    
    const uniqueProxies = new Map();
    
    accounts.forEach(account => {
      const accountId = account.id || account.account_id;
      const proxyConfigs = this.accountManager.getProxiesForAccount(accountId);
      
      proxyConfigs.forEach(proxyConfig => {
        const proxyKey = buildProxyKey(proxyConfig);
        if (!uniqueProxies.has(proxyKey)) {
          uniqueProxies.set(proxyKey, { proxyConfig, accounts: [] });
        }
        uniqueProxies.get(proxyKey).accounts.push(account);
      });
    });

    for (const [proxyKey, proxyInfo] of uniqueProxies) {
      this.startProxyCheckScheduler(proxyInfo.proxyConfig, proxyInfo.accounts[0], immediateRunning);
    }
  }

  startProxyCheckScheduler(proxyConfig, account, immediateRunning) {
    const proxyKey = buildProxyKey(proxyConfig);

    if (this.proxyCheckSchedulers.has(proxyKey)) {
      console.log(`⚠️ [DBG-greedy] ${proxyKey}: scheduler already exists, skip`);
      return;
    }

    const checkReq = pickCheckReq(this.config, proxyConfig);
    const lockReq = pickLockGlobal(this.config, proxyConfig);
    console.log(`📐 [DBG-greedy] ${proxyKey}: checkReq.startTime=${checkReq.startTime}, windowTime=${checkReq.windowTime}, minInterval=${checkReq.minInterval}, lockReserved=${lockReq.reservedChannels}, hasCfg=${!!proxyConfig.cfg}`);

    // 先创建调度器
    const scheduler = {
      proxyConfig, account,
      maxRequests: 0,
      interval: 0,
      timers: [], isRunning: true,
      proxyRequestIndex: 0,
      windowEndTime: 0
    };

    this.proxyCheckSchedulers.set(proxyKey, scheduler);

    // 🆕 贪心分配函数：在触发时刻执行，使用当时最新的通道状态和窗口时长
    const runGreedyAssignment = () => {
      if (!scheduler.isRunning) {
        console.log(`⚠️ [DBG-greedy] ${proxyKey}: scheduler.isRunning=false, abort`);
        return;
      }

      const now = Date.now();

      // 用该代理自己的 startTime/windowTime 计算窗口端点（per-proxy）
      const sched = this.scheduledService;
      // 宽限期 = windowTime：setTimeout 触发瞬间会比 startTime 晚几十毫秒，
      // 不传 graceMs 会导致 timeStringToTimestamp 把 "今天 21:31:50.000" 判为已过期、滚到明天，
      // 进而所有 check timer 排到 24h 后才触发。传 windowTime 后只要在窗口内，仍然按今天处理。
      const proxyStartTs = (checkReq.startTime && sched && typeof sched.timeStringToTimestamp === 'function')
        ? sched.timeStringToTimestamp(checkReq.startTime, now, checkReq.windowTime || 10000)
        : now;
      const checkWindowEnd = proxyStartTs + (checkReq.windowTime || 10000);
      scheduler.windowEndTime = checkWindowEnd;

      // 槽位起点：未到代理 startTime 时，从 startTime 算；已过则从 now 算
      const slotStart = Math.max(now, proxyStartTs);
      const effectiveWindowTime = checkWindowEnd - slotStart;

      if (effectiveWindowTime <= 0) {
        console.log(`⚠️ [DBG-greedy] ${proxyKey}: effectiveWindowTime<=0 (${effectiveWindowTime}ms), proxyStartTs=${new Date(proxyStartTs).toISOString()}, now=${new Date(now).toISOString()}`);
        return;
      }

      // ==================== 贪心分配算法 ====================

      const reservedChannels = lockReq.reservedChannels || 0;
      const maxCheckRequests = Math.floor(effectiveWindowTime / checkReq.minInterval);

      // 1. 获取所有已连接且可用的通道
      let connectedChannels = this.ticketService.connectionPool.getChannelsByProxy(
        buildProxyKey(proxyConfig)
      ).filter(ch => ch.isConnected && !ch.isStopped && !ch.isBusy);

      if (connectedChannels.length === 0) {
        const allCh = this.ticketService.connectionPool.getChannelsByProxy(buildProxyKey(proxyConfig));
        console.log(`⚠️ [DBG-greedy] ${proxyKey}: 0 available channels (total=${allCh.length}, connected=${allCh.filter(c=>c.isConnected).length}, busy=${allCh.filter(c=>c.isBusy).length}, stopped=${allCh.filter(c=>c.isStopped).length})`);
        return;
      }

      // 2. 如果通道过多，选创建时间最晚的N个（N = 最大查票次数 + 预留通道数）
      const neededChannels = maxCheckRequests + reservedChannels;
      if (connectedChannels.length > neededChannels) {
        // 按 connectedAt 降序排序，取创建时间最晚的
        connectedChannels.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
        connectedChannels = connectedChannels.slice(0, neededChannels);
      }

      // 3. 按连接时间升序排序（最早连接的在前，心跳刷新 connectedAt 后寿命最短的排前）
      connectedChannels.sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));

      // 4. 分离查票通道和预留通道
      //    查票：取过期时间较早的（先用掉）
      //    预留：取过期时间较晚的（留给锁号）
      const actualReserved = Math.min(reservedChannels, connectedChannels.length);
      const checkChannels = connectedChannels.slice(0, connectedChannels.length - actualReserved);
      // reservedForLock = connectedChannels.slice(connectedChannels.length - actualReserved);

      if (checkChannels.length === 0) {
        console.log(`⚠️ [DBG-greedy] ${proxyKey}: 0 checkChannels after reserving ${actualReserved} for lock (connected=${connectedChannels.length})`);
        return;
      }

      // 5. 根据查票通道数量生成时间槽
      const slotCount = checkChannels.length;
      const distribution = checkReq.distribution || 'uniform';
      const slots = [];
      let interval = Math.floor(effectiveWindowTime / slotCount);  // 计算平均间隔（用于记录）

      if (distribution === 'random') {
        // 随机分布：在窗口期内随机生成时间点，然后排序
        const randomTimes = [];
        for (let i = 0; i < slotCount; i++) {
          randomTimes.push(slotStart + Math.floor(Math.random() * effectiveWindowTime));
        }
        // 按时间排序，确保贪心分配时按时间顺序处理
        randomTimes.sort((a, b) => a - b);

        for (let i = 0; i < slotCount; i++) {
          slots.push({
            index: i,
            time: randomTimes[i],
            assigned: false,
            channel: null
          });
        }
      } else {
        // 均匀分布（默认）：等间隔生成时间点
        for (let i = 0; i < slotCount; i++) {
          slots.push({
            index: i,
            time: slotStart + i * interval,
            assigned: false,
            channel: null
          });
        }
      }

      // 6. 贪心分配：遍历通道（按 connectedAt 从早到晚），为每个通道找最早的未分配槽
      const assignments = [];

      for (const channel of checkChannels) {
        for (const slot of slots) {
          if (slot.assigned) continue;

          slot.assigned = true;
          slot.channel = channel;
          assignments.push({
            slotIndex: slot.index,
            time: slot.time,
            channel: channel,
            channelId: channel.channelId
          });
          break;
        }
      }

      if (assignments.length === 0) {
        console.log(`⚠️ [DBG-greedy] ${proxyKey}: 0 assignments (slotCount=${slotCount}, checkChannels=${checkChannels.length})`);
        return;
      }

      scheduler.maxRequests = assignments.length;
      scheduler.interval = interval;

      console.log(`✅ [DBG-greedy] ${proxyKey}: scheduling ${assignments.length} check timers, window=[${new Date(slotStart).toLocaleTimeString('zh-CN', {hour12:false})} ~ ${new Date(checkWindowEnd).toLocaleTimeString('zh-CN', {hour12:false})}]`);

      // 7. 设置定时器
      console.log(`🔧 [DBG-tick] ${proxyKey}: about to call setTimeout x${assignments.length}, delays=[${assignments.map(a => a.time - now).slice(0,5).join(',')}${assignments.length > 5 ? ',...' : ''}]ms`);
      let registeredCount = 0;
      assignments.forEach((assignment) => {
        const delay = assignment.time - now;
        try {
          const timer = setTimeout(() => {
            // 最朴素的 sync 日志，避免任何可能抛错的格式化函数
            try {
              process.stdout.write(`⏰ [DBG-tick] ${proxyKey}#${assignment.slotIndex + 1} fired ts=${Date.now()}\n`);
              this.executeProxyCheckRequest(proxyKey, assignment.slotIndex + 1, immediateRunning, false, assignment.channel);
            } catch (cbErr) {
              process.stdout.write(`💥 [DBG-tick] ${proxyKey}#${assignment.slotIndex + 1} cb threw: ${cbErr && cbErr.stack || cbErr}\n`);
            }
          }, delay);
          scheduler.timers.push(timer);
          registeredCount++;
        } catch (regErr) {
          console.log(`💥 [DBG-tick] ${proxyKey}#${assignment.slotIndex + 1} setTimeout threw at registration: ${regErr && regErr.message}`);
        }
      });
      console.log(`🔧 [DBG-tick] ${proxyKey}: setTimeout calls returned, registered=${registeredCount}/${assignments.length}, scheduler.timers.length=${scheduler.timers.length}`);
    };

    // 查票开始时间已到（由 setupCheckStartTimer 触发），直接执行贪心分配
    runGreedyAssignment();
  }

  // 🆕 执行查票请求，支持指定通道
  async executeProxyCheckRequest(proxyKey, requestIndex, immediateRunning, isReuse = false, specifiedChannel = null) {
    const scheduler = this.proxyCheckSchedulers.get(proxyKey);
    if (!scheduler) { console.log(`⚠️ [DBG-exec] ${proxyKey}#${requestIndex}: scheduler missing (deleted)`); return; }
    if (!scheduler.isRunning) { console.log(`⚠️ [DBG-exec] ${proxyKey}#${requestIndex}: scheduler.isRunning=false`); return; }
    if (!immediateRunning()) { console.log(`⚠️ [DBG-exec] ${proxyKey}#${requestIndex}: immediateRunning()=false (scheduledRunning toggled)`); return; }

    const accountId = scheduler.account.id || scheduler.account.account_id;

    // 🆕 统计已调度（无论是否成功发送）- 账号级别和代理级别
    // 复用请求不增加调度计数，只增加复用计数
    if (!isReuse) {
      this.ticketService.incrementAccountScheduled(accountId, 'check');
      this.ticketService.incrementProxyScheduled(proxyKey, 'check');
    }
    this.ticketService.notifyStatsUpdate();

    // 如果累计查到票次数已达阈值，不再发送查号请求
    const _stopCount = pickCheckReq(this.config, scheduler.proxyConfig).stopAfterFoundCount;
    if (_stopCount > 0 && (this.proxyFoundCount.get(proxyKey) || 0) >= _stopCount) {
      console.log(`⚠️ [DBG-exec] ${proxyKey}#${requestIndex}: stopAfterFoundCount reached (${_stopCount})`);
      return;
    }

    if (this.ticketService.isAccountLockSuccess(accountId)) {
      console.log(`⚠️ [DBG-exec] ${proxyKey}#${requestIndex}: account ${accountId} already lock-success`);
      this.stopProxyCheckScheduler(proxyKey);
      return;
    }

    let channel = specifiedChannel;

    // 🆕 如果指定了通道（复用/心跳恢复场景），检查它是否仍然可用
    if (channel) {
      if (!channel.isAvailableForRequest()) {
        // 指定的通道不可用，放弃本次复用请求（不抢其他通道）
        console.log(`⚠️ [DBG-exec] ${proxyKey}#${requestIndex}: bound channel ${channel.channelId} not available (connected=${channel.isConnected}, busy=${channel.isBusy}, stopped=${channel.isStopped})`);
        return;
      }
    } else {
      // 🆕 没有指定通道（原始调度场景），从可用池选择
      const availableChannels = this.ticketService.connectionPool.getAvailableChannelsForCheck(
        buildProxyKey(scheduler.proxyConfig)
      );

      if (availableChannels.length === 0) {
        // 无可用通道，请求被跳过
        console.log(`⚠️ [DBG-exec] ${proxyKey}#${requestIndex}: no available channels at fire time (no specifiedChannel, getAvailableChannelsForCheck=0)`);
        return;
      }

      // 选择最早连接的空闲通道
      channel = availableChannels[0];
    }
    console.log(`🎯 [DBG-exec] ${proxyKey}#${requestIndex}: firing checkTicket on ${channel.channelId}`);
    
    // 🆕 递增代理级别的请求序列号
    scheduler.proxyRequestIndex++;
    const proxyRequestIndex = scheduler.proxyRequestIndex;

    try {
      this.ticketService.connectionPool.incrementCheckRequestCount(
        buildProxyKey(scheduler.proxyConfig)
      );

      // 🆕 传递代理序列号 proxyRequestIndex
      const result = await this.ticketService.checkTicket(
        scheduler.account, scheduler.proxyConfig, channel.channelId, proxyRequestIndex
      );

      // 验证返回的请求类型，防止误判
      if (result.requestType && result.requestType !== 'check') {
        return;
      }

      if (result.hasTicket) {
        const foundCount = (this.proxyFoundCount.get(proxyKey) || 0) + 1;
        this.proxyFoundCount.set(proxyKey, foundCount);

        this.triggerLockOnProxy(
          scheduler.proxyConfig, scheduler.account,
          result.submitSign, result.cookie, result.submitSignSource, result.ticketDetails, result.allTickets || [], immediateRunning
        );

        const stopCount = pickCheckReq(this.config, scheduler.proxyConfig).stopAfterFoundCount;
        if (stopCount > 0 && foundCount >= stopCount) {
          this.stopProxyCheckScheduler(proxyKey);
        }
      } else if (result.targetExhausted) {
        // 🆕 目标医生+日期的所有号源余票均为0，停止查号调度器
        this.ticketService.printEventLog(
          `🛑 [${this.formatTime()}] 代理 ${proxyKey} 目标已售罄，停止查号调度器`
        );
        this.stopProxyCheckScheduler(proxyKey);
      } else {
        // 请求成功但没有票，尝试复用通道
        this.tryReuseChannel(proxyKey, channel, immediateRunning);
      }
    } catch (error) {
      // 🆕 处理错误情况
      const reuseConfig = pickCheckReq(this.config, scheduler.proxyConfig).reuseChannel;
      
      // 检查是否是超时错误
      const isTimeout = error && (
        error.errorType === 'TIMEOUT' || 
        error.errorType === 'REQUEST_TIMEOUT' ||
        (error.error && error.error.message && error.error.message.includes('超时'))
      );
      
      if (isTimeout) {
        // 超时后不复用，关闭通道（防止数据错乱）
        if (reuseConfig && !reuseConfig.reuseOnTimeout) {
          channel.close();
        }
      } else if (reuseConfig && reuseConfig.reuseOnError) {
        // 其他错误但配置允许复用
        this.tryReuseChannel(proxyKey, channel, immediateRunning);
      }
    }
  }

  // 🆕 尝试复用通道
  tryReuseChannel(proxyKey, channel, immediateRunning) {
    const scheduler = this.proxyCheckSchedulers.get(proxyKey);
    if (!scheduler || !scheduler.isRunning) return;

    const checkReq = pickCheckReq(this.config, scheduler.proxyConfig);
    const reuseConfig = checkReq.reuseChannel;

    // 检查是否启用复用
    if (!reuseConfig || !reuseConfig.enabled) return;

    // 如果累计查到票次数已达阈值，不再复用
    const _rcStopCount = checkReq.stopAfterFoundCount;
    if (_rcStopCount > 0 && (this.proxyFoundCount.get(proxyKey) || 0) >= _rcStopCount) return;

    const now = Date.now();
    const windowEndTime = scheduler.windowEndTime;
    
    // 如果窗口结束时间未设置或已超过，不再复用
    if (!windowEndTime || now >= windowEndTime) return;
    
    // 🆕 基于 minInterval 计算下次可发送时间
    const minInterval = reuseConfig.minInterval || 2000;
    const lastStart = channel.lastRequestStartTime || 0;
    const earliestTime = lastStart + minInterval;
    
    // 确定发送时间：取当前时间和最早可发送时间的较大值
    const scheduledTime = Math.max(now, earliestTime);
    
    // 如果发送时间已超过窗口，不复用
    if (scheduledTime >= windowEndTime) return;
    
    const delay = scheduledTime - now;
    
    // 🆕 增加复用统计
    this.ticketService.incrementProxyReuse(proxyKey);
    
    // 设置定时器，使用指定通道发送请求
    const timer = setTimeout(() => {
      this.executeProxyCheckRequest(proxyKey, 0, immediateRunning, true, channel);
    }, delay);
    
    scheduler.timers.push(timer);
  }

  // 🆕 为新创建的通道安排查票（P1/P2/P3通道在查票窗口期内连接成功后调用）
  scheduleNewChannelCheck(proxyKey, newChannel = null) {
    const scheduler = this.proxyCheckSchedulers.get(proxyKey);
    if (!scheduler || !scheduler.isRunning) return;

    const checkReq = pickCheckReq(this.config, scheduler.proxyConfig);
    const reuseConfig = checkReq.reuseChannel;

    const [host, port] = proxyKey.split(':');

    // 如果累计查到票次数已达阈值，不再安排
    const _scStopCount = checkReq.stopAfterFoundCount;
    if (_scStopCount > 0 && (this.proxyFoundCount.get(proxyKey) || 0) >= _scStopCount) return;
    
    const now = Date.now();
    const windowEndTime = scheduler.windowEndTime;
    
    // 如果窗口结束时间未设置或已超过，不再安排
    if (!windowEndTime || now >= windowEndTime) return;
    
    // 注意：这里不增加复用计数，因为新通道的首次查票不算"复用"

    // 安排查票（使用闭包保存 immediateRunning 的引用）
    const immediateRunning = () => this.scheduledService ? this.scheduledService.scheduledRunning : true;

    // 🆕 即连即打：窗口内新建（或心跳恢复）的通道，握手成功后立即发送首个查票请求，不再随机延迟。
    //    原先在剩余窗口内随机延迟（Math.random()*remainingTime）是为"预热池保活、把请求摊匀到整个窗口"
    //    设计的；但服务器现在会在 TLS 握手后很快回收空闲/新建连接，把刚连好的通道晾几秒
    //    只会白白浪费它短暂的存活窗口。连上即打可最大化"请求落在连接存活期内"的概率。
    this.executeProxyCheckRequest(proxyKey, 0, immediateRunning, true, newChannel);
  }

  triggerLockOnProxy(proxyConfig, account, submitSign, cookie, submitSignSource, ticketData, allTickets, immediateRunning) {
    const proxyKey = buildProxyKey(proxyConfig);
    const accountId = account.id || account.account_id;

    // 防止重复触发锁号（已发送但未返回的查号请求可能也会查到票）
    if (this.ticketService.connectionPool.isProxyLockTriggered(proxyKey)) return;

    this.anyLockTriggered = true;
    this.ticketService.printEventLog(`🔒 [${this.formatTime()}] 代理 ${proxyKey} 触发锁号`);

    this.ticketService.connectionPool.markProxyLockTriggered(proxyKey);
    this.ticketService.markAccountLockTriggeredOnProxy(accountId, proxyKey);

    // 🆕 调用锁号触发回调，传递proxyKey（停止该代理的第三阶段通道创建）
    if (this.ticketService.onLockTriggered) {
      this.ticketService.onLockTriggered(proxyKey);
    }

    this.startProxyLockScheduler(proxyConfig, account, submitSign, cookie, submitSignSource, ticketData, allTickets, immediateRunning);
  }

  startProxyLockScheduler(proxyConfig, account, submitSign, cookie, submitSignSource, ticketData, allTickets, immediateRunning) {
    const proxyKey = buildProxyKey(proxyConfig);
    const accountId = account.id || account.account_id;

    if (this.proxyLockSchedulers.has(proxyKey)) {
      this.ticketService.printEventLog(`ℹ️ [${this.formatTime()}] 代理 ${proxyKey} 锁号调度器已存在，跳过重复创建`);
      return;
    }

    // 检查是否有可用通道
    const availableChannels = this.ticketService.connectionPool.getAvailableChannelsForLock(
      proxyKey
    );
    if (availableChannels.length === 0) {
      this.ticketService.printEventLog(`❌ [${this.formatTime()}] 代理 ${proxyKey} 没有可用通道，无法启动锁号！`);
      return;
    }

    // 检查submitSign是否存在
    if (!submitSign) {
      console.warn(`⚠️ [${this.formatTime()}] 代理 ${proxyKey} submitSign为空，锁号可能失败`);
    }

    const lockReq = pickLockGlobal(this.config, proxyConfig);
    const windowTime = lockReq.windowTime;
    const minInterval = lockReq.minInterval;
    const firstLockDelayMs = lockReq.firstLockDelayMs || 0;
    const lockStartTime = lockReq.lockStartTime || '';

    const scheduler = {
      proxyConfig, account,
      submitSign, cookie, submitSignSource, ticketData,
      allTickets: allTickets || [],   // 本次查票响应中所有可用号源（按优先级排序，用于售罄后原地切换备选）
      windowTime,
      minInterval,
      endTime: 0,   // 延迟结束后才设置，确保窗口期不含延迟时间
      timer: null,
      isRunning: true,
      startTime: Date.now(),
      proxyRequestIndex: 0
    };

    this.proxyLockSchedulers.set(proxyKey, scheduler);
    this.ticketService.markAccountLockingOnProxy(accountId, proxyKey);

    if (lockStartTime) {
      const lockStartMs = this._parseLockStartTime(lockStartTime);
      if (lockStartMs !== null) {
        const now = Date.now();
        const windowEnd = lockStartMs + windowTime;

        if (now >= windowEnd) {
          this.ticketService.printEventLog(`⏰ [${this.formatTime()}] 代理 ${proxyKey} 锁号开始时间窗口已过 (${lockStartTime}+${windowTime/1000}s)，跳过锁号`);
          this.stopProxyLockScheduler(proxyKey);
          return;
        }

        // 首次发送时间 = max(lockStartTime + firstDelay, now)
        const waitForFirstLock = Math.max(0, lockStartMs + firstLockDelayMs - now);
        const delayDesc = firstLockDelayMs > 0 ? `，首次延迟${firstLockDelayMs}ms` : '';
        this.ticketService.printEventLog(`🚀 [${this.formatTime()}] 代理 ${proxyKey} 锁号调度器启动: 锁号开始时间${lockStartTime}，窗口${windowTime/1000}秒，${availableChannels.length}个可用通道${delayDesc}，首次发送在${waitForFirstLock}ms后`);

        setTimeout(() => {
          if (!scheduler.isRunning) return;
          scheduler.endTime = windowEnd;
          this.scheduleLockRequest(proxyKey, immediateRunning);
        }, waitForFirstLock);
        return;
      }
    }

    // 未配置锁号开始时间：延迟结束后才设置 endTime，保证窗口期不消耗延迟时间
    const delayDesc = firstLockDelayMs > 0 ? `，延迟${firstLockDelayMs}ms后开始` : '';
    this.ticketService.printEventLog(`🚀 [${this.formatTime()}] 代理 ${proxyKey} 锁号调度器启动: 窗口${windowTime/1000}秒, ${availableChannels.length}个可用通道${delayDesc}`);

    setTimeout(() => {
      if (!scheduler.isRunning) return;
      scheduler.endTime = Date.now() + windowTime;
      this.scheduleLockRequest(proxyKey, immediateRunning);
    }, firstLockDelayMs);
  }

  // 🆕 调度下一个锁号请求
  scheduleLockRequest(proxyKey, immediateRunning) {
    const scheduler = this.proxyLockSchedulers.get(proxyKey);
    if (!scheduler || !scheduler.isRunning) return;

    // 检查是否超过窗口时间
    if (Date.now() >= scheduler.endTime) {
      this.stopProxyLockScheduler(proxyKey);
      return;
    }

    // 执行当前请求
    this.executeProxyLockRequest(proxyKey, immediateRunning);

    // 固定间隔
    const randomInterval = scheduler.minInterval;

    // 调度下一个请求
    scheduler.timer = setTimeout(() => {
      this.scheduleLockRequest(proxyKey, immediateRunning);
    }, randomInterval);
  }

  async executeProxyLockRequest(proxyKey, immediateRunning) {
    const scheduler = this.proxyLockSchedulers.get(proxyKey);
    if (!scheduler || !scheduler.isRunning) return;
    if (!immediateRunning()) return;

    const accountId = scheduler.account.id || scheduler.account.account_id;
    
    // 统计已调度
    this.ticketService.incrementAccountScheduled(accountId, 'lock');
    this.ticketService.incrementProxyScheduled(proxyKey, 'lock');
    this.ticketService.notifyStatsUpdate();
    
    if (this.ticketService.isAccountLockSuccess(accountId)) {
      this.stopProxyLockScheduler(proxyKey);
      return;
    }

    // 锁号前检查目标号源是否已售罄
    if (scheduler.ticketData && this.ticketService.isPlanIdExhausted(scheduler.ticketData.planId)) {
      this.stopProxyLockScheduler(proxyKey);
      return;
    }

    // 根据策略从 SubmitSign 池中选取本次锁号使用的 SubmitSign
    // 'first'（默认）：使用锁号调度器启动时传入的 SubmitSign（第一次查到号时的值）
    // 'latest'：从池中选出最新且符合条件的 SubmitSign（未消耗、未过期、日期范围覆盖目标日期）
    const submitSignStrategy = pickLockGlobal(this.config, scheduler.proxyConfig).submitSignStrategy || 'first';
    const lockPlanDate = scheduler.account.lockPlanDate || '';
    const queryMode = this.ticketService.checkMode || 'doctor';

    // 每个代理只使用自己 check 到的 SubmitSign（per-proxy 隔离）
    const selectProxyIp = proxyKey;

    let resolvedSubmitSign = scheduler.submitSign;
    let resolvedCookie = scheduler.cookie;
    let resolvedPoolRecord = null;

    if (submitSignStrategy === 'latest') {
      const rec = this.ticketService.submitSignPool.select(String(accountId), lockPlanDate, queryMode, selectProxyIp);
      if (rec) {
        if (rec.submitSign !== resolvedSubmitSign) {
          this.ticketService.printEventLog(`🔄 [${this.formatTime()}] 代理 ${proxyKey} 使用池中最新 SubmitSign（${rec.queryDateStart}）`);
        }
        resolvedSubmitSign = rec.submitSign;
        resolvedCookie = rec.cookie || resolvedCookie;
        resolvedPoolRecord = rec;
      }
    } else if (submitSignStrategy === 'rotate') {
      // 轮询：每轮选最久未使用的 SubmitSign（LRU），避免高延迟下重复用已消耗值
      const rec = this.ticketService.submitSignPool.selectRotate(String(accountId), lockPlanDate, queryMode, selectProxyIp);
      if (rec) {
        resolvedSubmitSign = rec.submitSign;
        resolvedCookie = rec.cookie || resolvedCookie;
        resolvedPoolRecord = rec;
      }
    } else {
      // 'first'：优先使用锁号调度器启动时的 SubmitSign
      if (scheduler.submitSign) {
        resolvedPoolRecord = this.ticketService.submitSignPool.findByValue(scheduler.submitSign);
      }
      // 若初始 SubmitSign 已被消耗（findByValue 返回 null），从池中补选一个有效记录
      if (!resolvedPoolRecord) {
        const fallback = this.ticketService.submitSignPool.select(String(accountId), lockPlanDate, queryMode, selectProxyIp);
        if (fallback) {
          resolvedSubmitSign = fallback.submitSign;
          resolvedCookie = fallback.cookie || resolvedCookie;
          resolvedPoolRecord = fallback;
        }
      }
    }

    // 无有效 SubmitSign（已消耗或已过期）→ 跳过本轮，等待下一次 check 带回新值
    if (!resolvedPoolRecord) {
      this.ticketService.printEventLog(`⏭️ [${this.formatTime()}] 代理 ${proxyKey} 无有效 SubmitSign，跳过本轮锁号`);
      return;
    }

    // 标记本次锁号已使用该 SubmitSign
    this.ticketService.submitSignPool.markUsed(resolvedPoolRecord.id);

    // 🆕 获取可用通道（已按lastActiveAt排序，最久没活动的在前）
    const availableChannels = this.ticketService.connectionPool.getAvailableChannelsForLock(
      buildProxyKey(scheduler.proxyConfig)
    );
    
    // 递增请求序列号
    scheduler.proxyRequestIndex++;
    const proxyRequestIndex = scheduler.proxyRequestIndex;
    
    if (availableChannels.length === 0) {
      // 🆕 无可用通道，检查是否启用直接请求
      const lockReq = pickLockGlobal(this.config, scheduler.proxyConfig);
      if (lockReq.directRequestOnNoChannel) {
        // 直接发送锁号请求（不通过通道）
        try {
          this.ticketService.connectionPool.incrementLockRequestCount(
            buildProxyKey(scheduler.proxyConfig)
          );

          const result = await this.ticketService.directLockTicket(
            scheduler.account, scheduler.proxyConfig,
            resolvedSubmitSign, resolvedCookie, scheduler.submitSignSource, scheduler.ticketData,
            proxyRequestIndex
          );

          // 验证返回的请求类型
          if (result.requestType && result.requestType !== 'lock') {
            this.ticketService.printEventLog(`⚠️ [${this.formatTime()}] 忽略非锁号响应(direct): requestType=${result.requestType}`);
            return;
          }

          if (result.lockSuccess) {
            this.anyLockSuccess = true;
            this.ticketService.markAccountLockSuccess(accountId, buildProxyKey(scheduler.proxyConfig));

            this.stopProxyLockScheduler(proxyKey);

            const stopReason = result.alreadyBooked ? 'already_booked' : 'lock_success';
            setTimeout(() => {
              this.stopAllSchedulersForAccount(accountId);
              this.onAutoStop?.(stopReason);
            }, 1000);
          }
          // 🆕 标记 SubmitSign 消耗状态
          if (resolvedPoolRecord && result.submitSignConsumed) {
            this.ticketService.submitSignPool.markConsumed(
              resolvedPoolRecord.id,
              result.lockSuccess ? 'lock_success' : 'changed_error'
            );
          }
        } catch (error) {
          // 直接请求错误静默处理
        }
      }
      // 无论是否启用直接请求，都返回（不阻塞后续调度）
      return;
    }

    // 🆕 选择最久没活动的通道（第一个）
    const channel = availableChannels[0];

    try {
      this.ticketService.connectionPool.incrementLockRequestCount(
        buildProxyKey(scheduler.proxyConfig)
      );

      const result = await this.ticketService.lockTicket(
        scheduler.account, scheduler.proxyConfig,
        resolvedSubmitSign, resolvedCookie, scheduler.submitSignSource, scheduler.ticketData,
        channel.channelId, proxyRequestIndex
      );

      // 验证返回的请求类型
      if (result.requestType && result.requestType !== 'lock') {
        this.ticketService.printEventLog(`⚠️ [${this.formatTime()}] 忽略非锁号响应: requestType=${result.requestType}`);
        return;
      }

      if (result.lockSuccess) {
        this.anyLockSuccess = true;
        this.ticketService.markAccountLockSuccess(accountId, buildProxyKey(scheduler.proxyConfig));

        this.stopProxyLockScheduler(proxyKey);

        const stopReason = result.alreadyBooked ? 'already_booked' : 'lock_success';
        setTimeout(() => {
          this.stopAllSchedulersForAccount(accountId);
          this.onAutoStop?.(stopReason);
        }, 1000);
      }
      // 🆕 标记 SubmitSign 消耗状态
      if (resolvedPoolRecord && result.submitSignConsumed) {
        this.ticketService.submitSignPool.markConsumed(
          resolvedPoolRecord.id,
          result.lockSuccess ? 'lock_success' : 'changed_error'
        );
      }
    } catch (error) {
      // 错误静默处理
    }
  }

  stopProxyCheckScheduler(proxyKey) {
    const scheduler = this.proxyCheckSchedulers.get(proxyKey);
    if (scheduler) {
      scheduler.isRunning = false;
      scheduler.timers.forEach(timer => clearTimeout(timer));
      scheduler.timers = []; // 🆕 清空定时器数组，释放引用
      this.proxyCheckSchedulers.delete(proxyKey);
    }
  }

  stopProxyLockScheduler(proxyKey) {
    const scheduler = this.proxyLockSchedulers.get(proxyKey);
    if (scheduler) {
      scheduler.isRunning = false;
      // 🆕 清理单个定时器
      if (scheduler.timer) {
        clearTimeout(scheduler.timer);
        scheduler.timer = null;
      }
      // 兼容旧的 timers 数组（如果有的话）
      if (scheduler.timers) {
        scheduler.timers.forEach(timer => clearTimeout(timer));
        scheduler.timers = [];
      }
      this.proxyLockSchedulers.delete(proxyKey);
      // P0: 所有锁号调度器已结束且无成功 → 等在途锁号请求全部完成后再停止
      if (this.proxyLockSchedulers.size === 0 && this.anyLockTriggered && !this.anyLockSuccess) {
        this._waitPendingThenAutoStop('lock', 'lock_window_expired');
      }
    }
  }

  // 等待指定类型的在途请求全部完成后再触发自动停止
  _waitPendingThenAutoStop(requestType, reason) {
    const pool = this.ticketService?.connectionPool;
    if (!pool) {
      this.onAutoStop?.(reason);
      return;
    }
    const poll = () => {
      if (this.anyLockSuccess) return;
      const pending = pool.countPendingRequestsByType(requestType);
      if (pending > 0) {
        setTimeout(poll, 200);
      } else {
        if (!this.anyLockSuccess) this.onAutoStop?.(reason);
      }
    };
    poll();
  }

  stopAllSchedulersForAccount(accountId) {
    const proxyConfigs = this.accountManager.getProxiesForAccount(accountId);
    proxyConfigs.forEach(proxyConfig => {
      const proxyKey = buildProxyKey(proxyConfig);
      this.stopProxyCheckScheduler(proxyKey);
      this.stopProxyLockScheduler(proxyKey);
    });
  }

  /**
   * 号源售罄时处理所有使用该 planId 的锁号调度器
   * - 有备选号源：原地替换 ticketData，保留剩余窗口时间继续锁号
   * - 无备选号源：停止调度器，不重置锁号触发标记
   */
  stopLockSchedulersByPlanId(planId) {
    const switchedProxies = [];
    const stoppedProxies = [];

    this.proxyLockSchedulers.forEach((scheduler, proxyKey) => {
      if (!scheduler.ticketData || scheduler.ticketData.planId !== planId) return;

      const accountId = scheduler.account.id || scheduler.account.account_id;
      if (this.ticketService.isAccountLockSuccess(accountId)) return;

      // 从本次查票备选列表中找下一个未售罄的号源
      const nextTicket = (scheduler.allTickets || []).find(
        t => t.planId !== planId && !this.ticketService.isPlanIdExhausted(t.planId)
      );

      if (nextTicket) {
        // 原地切换：只更新目标号源，保留剩余窗口时间（endTime 不变）
        scheduler.ticketData = nextTicket;
        switchedProxies.push(`${proxyKey} → planId:${nextTicket.planId}`);
      } else {
        // 无备选，停止调度器；不重置 isProxyLockTriggered
        this.stopProxyLockScheduler(proxyKey);
        stoppedProxies.push(proxyKey);
      }
    });

    const lines = [`🔄 [${this.formatTime()}] 号源 ${planId} 已售罄`];
    if (switchedProxies.length > 0) lines.push(`   切换备选号源: ${switchedProxies.join(', ')}`);
    if (stoppedProxies.length > 0) lines.push(`   无备选，停止调度器: ${stoppedProxies.join(', ')}`);
    if (switchedProxies.length > 0 || stoppedProxies.length > 0) {
      this.ticketService.printEventLog(...lines);
    }

    return switchedProxies.length + stoppedProxies.length;
  }

  stopAllSchedulers() {
    this.isRunning = false;

    this.proxyCheckSchedulers.forEach((scheduler) => {
      scheduler.isRunning = false;
      scheduler.timers.forEach(timer => clearTimeout(timer));
      scheduler.timers = []; // 🆕 清空定时器数组
    });
    this.proxyCheckSchedulers.clear();

    this.proxyLockSchedulers.forEach((scheduler) => {
      scheduler.isRunning = false;
      scheduler.timers.forEach(timer => clearTimeout(timer));
      scheduler.timers = []; // 🆕 清空定时器数组
    });
    this.proxyLockSchedulers.clear();
  }

  getSchedulerStatus() {
    return {
      isRunning: this.isRunning,
      checkSchedulers: this.proxyCheckSchedulers.size,
      lockSchedulers: this.proxyLockSchedulers.size
    };
  }
}

module.exports = ChannelStarter;