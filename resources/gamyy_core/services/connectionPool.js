// services/connectionPool.js - 简化版：不区分查号/锁号通道
const EventEmitter = require('events');
const ConnectionChannel = require('./connectionChannel');
const { lockGlobal: pickLockGlobal, channelPhase1: pickChannelPhase1 } = require('./_proxyCfg');


// 构建代理唯一键：标准代理优先用真实出口IP，SSH隧道用 host:port
function buildProxyKey(proxyConfig) {
  return proxyConfig.realProxyIp || `${proxyConfig.host}:${proxyConfig.port}`;
}

class ConnectionPool extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    // 统一的通道列表（不再区分check/lock）
    this.channels = [];
    this.proxyConfigs = [];

    // 目标主机优先级：代理级覆盖 > 任务通道级 > 系统默认
    const taskChannelHosts = config.channelBuildPhase1?.targetHosts;
    const systemHosts = config.connectionPool.targetHosts || [
      { host: config.connectionPool.targetHost, port: config.connectionPool.targetPort }
    ];
    this.defaultTargetHosts = (taskChannelHosts?.length) ? taskChannelHosts : systemHosts;
    
    // 账号与通道的映射
    this.accountChannelMap = new Map();
    // 代理与通道的映射
    this.proxyChannelMap = new Map();
    // 代理请求状态
    this.proxyRequestState = new Map();
    
    // 每个代理IP的targetHost轮询索引
    this.proxyTargetHostIndex = new Map();
    // 代理级目标主机覆盖（proxy > task/template/system）
    this.proxyTargetHostsOverride = new Map();

    // 🆕 移除 maxRetries：创建失败就是失败了，无需重试
  }

  // 获取代理IP的下一个targetHost（轮询），优先使用代理级覆盖
  getNextTargetHost(proxyKey) {
    if (!this.proxyTargetHostIndex.has(proxyKey)) {
      this.proxyTargetHostIndex.set(proxyKey, 0);
    }

    const hostsToUse = this.proxyTargetHostsOverride.get(proxyKey) || this.defaultTargetHosts;
    const index = this.proxyTargetHostIndex.get(proxyKey);
    const targetHost = hostsToUse[index % hostsToUse.length];

    // 更新索引
    this.proxyTargetHostIndex.set(proxyKey, index + 1);

    return targetHost;
  }

  async initializeWithoutConnect(proxyConfigs, logDb) {
    this.proxyConfigs = proxyConfigs;
    this.logDb = logDb;

    for (let i = 0; i < proxyConfigs.length; i++) {
      const proxyConfig = proxyConfigs[i];
      const proxyKey = buildProxyKey(proxyConfig);

      if (!this.proxyChannelMap.has(proxyKey)) {
        this.proxyChannelMap.set(proxyKey, []);
      }

      // 注册代理级目标主机覆盖
      if (proxyConfig.targetHosts && proxyConfig.targetHosts.length) {
        this.proxyTargetHostsOverride.set(proxyKey, proxyConfig.targetHosts);
      }

      if (!this.proxyRequestState.has(proxyKey)) {
        this.proxyRequestState.set(proxyKey, {
          checkRequestCount: 0,
          lockRequestCount: 0,
          lockTriggered: false,
          lockStartTime: null
        });
      }

      // 严格 per-proxy：直接从 proxyConfig.cfg 取，task 顶层不再有 channelBuildPhase1 兜底
      const ov = pickChannelPhase1(this.config, proxyConfig) || {};
      const channelsForThisProxy = ov.attempts != null ? ov.attempts : 40;

      // 创建统一通道，轮询选择targetHost
      for (let j = 0; j < channelsForThisProxy; j++) {
        const targetHostConfig = this.getNextTargetHost(proxyKey);
        const channelId = `ch-${proxyKey}-${j+1}`;
        const channel = new ConnectionChannel(
          this.config, proxyConfig, targetHostConfig.host, targetHostConfig.port,
          channelId, i, this.logDb, targetHostConfig.sni || null
        );
        channel.onConnected = () => this.emit('channelConnected', channel);
        this.channels.push(channel);
        this.proxyChannelMap.get(proxyKey).push(channel);
      }
    }

    return true;
  }

  assignChannelsToAccount(accountId, proxyConfigs) {
    const assignedChannels = [];
    
    proxyConfigs.forEach(proxyConfig => {
      const proxyKey = buildProxyKey(proxyConfig);
      const proxyChannels = this.proxyChannelMap.get(proxyKey);
      
      if (proxyChannels) {
        assignedChannels.push(...proxyChannels);
      }
    });
    
    const uniqueChannels = this.removeDuplicateChannels(assignedChannels);
    
    if (uniqueChannels.length > 0) {
      this.accountChannelMap.set(accountId, uniqueChannels);
    }
    
    return uniqueChannels;
  }

  removeDuplicateChannels(channels) {
    const unique = [];
    const seen = new Set();
    channels.forEach(ch => {
      if (!seen.has(ch.channelId)) {
        seen.add(ch.channelId);
        unique.push(ch);
      }
    });
    return unique;
  }

  // 获取代理的所有已连接通道
  getConnectedChannelsByProxy(proxyKey) {
    const proxyChannels = this.proxyChannelMap.get(proxyKey);
    if (!proxyChannels) return [];
    return proxyChannels.filter(ch => ch.isConnected && ch.canBeUsed());
  }

  // 🆕 获取代理的所有可用于新请求的通道（已连接、未停止、未忙碌）
  // 按连接时间排序，优先返回最早连接的通道
  getAvailableChannelsForNewRequest(proxyKey) {
    const proxyChannels = this.proxyChannelMap.get(proxyKey);
    if (!proxyChannels) return [];

    const availableChannels = proxyChannels.filter(ch => ch.isAvailableForRequest());
    
    // 按连接时间排序（最早连接的在前）
    availableChannels.sort((a, b) => {
      const aTime = a.connectedAt || Infinity;
      const bTime = b.connectedAt || Infinity;
      return aTime - bTime;
    });
    
    return availableChannels;
  }

  // 获取代理的所有可用通道（用于查号）
  // 🆕 会为锁号预留指定数量的空闲通道
  getAvailableChannelsForCheck(proxyKey) {
    const allAvailable = this.getAvailableChannelsForNewRequest(proxyKey);

    // 🆕 取该代理自己的 lockGlobal 配置（per-proxy）
    const proxyChannels = this.proxyChannelMap.get(proxyKey);
    const proxyConfig = proxyChannels && proxyChannels[0] && proxyChannels[0].proxyConfig;
    const reservedForLock = pickLockGlobal(this.config, proxyConfig).reservedChannels || 0;
    
    // 计算可用于查号的通道数量
    const availableForCheck = allAvailable.length - reservedForLock;
    
    if (availableForCheck <= 0) {
      // 空闲通道不足，需要全部预留给锁号
      return [];
    }
    
    // 返回前 N 个通道（已按连接时间排序，最早连接的优先）
    return allAvailable.slice(0, availableForCheck);
  }

  // 获取代理的所有可用通道（用于锁号）
  // 🆕 按"最后活动时间"排序，优先返回最久没活动的通道
  getAvailableChannelsForLock(proxyKey) {
    const proxyChannels = this.proxyChannelMap.get(proxyKey);
    if (!proxyChannels) return [];

    const availableChannels = proxyChannels.filter(ch => ch.isAvailableForRequest());
    
    // 🆕 按最后活动时间排序（最久没活动的在前）
    // 如果 lastActiveAt 为 null，使用 connectedAt
    availableChannels.sort((a, b) => {
      const aTime = a.lastActiveAt || a.connectedAt || Infinity;
      const bTime = b.lastActiveAt || b.connectedAt || Infinity;
      return aTime - bTime;
    });
    
    return availableChannels;
  }

  // 停止代理的所有通道
  stopChannelsByProxy(proxyKey) {
    const proxyChannels = this.proxyChannelMap.get(proxyKey);
    if (!proxyChannels) return;
    
    proxyChannels.forEach(ch => {
      if (ch && !ch.isStopped) ch.stop();
    });
  }

  /**
   * 取消代理上所有通道的pending查票请求
   * 用于在查票成功后立即停止对该代理IP上所有进行中请求的监听
   * @param {string} proxyHost 
   * @param {string} proxyPort 
   * @returns {Array} 被取消的请求信息列表
   */
  cancelAllPendingCheckRequestsByProxy(proxyKey) {
    const proxyChannels = this.proxyChannelMap.get(proxyKey);
    if (!proxyChannels) return [];
    
    const allCancelledRequests = [];
    proxyChannels.forEach(ch => {
      if (ch && ch.cancelAllPendingCheckRequests) {
        const cancelledRequests = ch.cancelAllPendingCheckRequests();
        allCancelledRequests.push(...cancelledRequests);
      }
    });
    
    if (allCancelledRequests.length > 0) {
    // 不再打印取消汇总日志
    }
    
    return allCancelledRequests;
  }

  getProxyRequestState(proxyKey) {
    return this.proxyRequestState.get(proxyKey) || {
      checkRequestCount: 0,
      lockRequestCount: 0,
      lockTriggered: false,
      lockStartTime: null
    };
  }

  incrementCheckRequestCount(proxyKey) {
    const state = this.proxyRequestState.get(proxyKey);
    if (state) return ++state.checkRequestCount;
    return 0;
  }

  incrementLockRequestCount(proxyKey) {
    const state = this.proxyRequestState.get(proxyKey);
    if (state) return ++state.lockRequestCount;
    return 0;
  }

  markProxyLockTriggered(proxyKey) {
    const state = this.proxyRequestState.get(proxyKey);
    if (state) {
      state.lockTriggered = true;
      state.lockStartTime = Date.now();
    }
  }

  isProxyLockTriggered(proxyKey) {
    const state = this.proxyRequestState.get(proxyKey);
    return state ? state.lockTriggered : false;
  }

  resetProxyLockTriggered(proxyKey) {
    const state = this.proxyRequestState.get(proxyKey);
    if (state) {
      state.lockTriggered = false;
      state.lockStartTime = null;
    }
  }

  getChannelsByProxy(proxyKey) {
    return this.proxyChannelMap.get(proxyKey) || [];
  }

  // 统计所有通道中指定类型的在途请求数量（'check' 或 'lock'）
  countPendingRequestsByType(requestType) {
    let count = 0;
    for (const ch of this.channels) {
      if (ch && ch.pendingRequests) {
        count += ch.pendingRequests.filter(r => r.requestType === requestType).length;
      }
    }
    return count;
  }

  /**
   * 🆕 停止所有通道的心跳
   * 在进入查票窗口期时调用，避免心跳请求与查票业务请求冲突
   */
  stopAllHeartbeats() {
    let stoppedCount = 0;
    this.channels.forEach(ch => {
      if (ch) {
        ch.stopHeartbeat();
        stoppedCount++;
      }
    });
    return stoppedCount;
  }

  /**
   * 🆕 停止指定代理上所有通道的心跳
   * 在代理被分类为早衰退时调用
   */
  stopHeartbeatsByProxy(proxyKey) {
    const channels = this.getChannelsByProxy(proxyKey);
    let stoppedCount = 0;
    channels.forEach(ch => {
      if (ch) {
        ch.stopHeartbeat();
        stoppedCount++;
      }
    });
    return stoppedCount;
  }

  /**
   * 🆕 为所有已连接通道设置心跳恢复回调
   * 当心跳在查票窗口前发出、在窗口内返回后，通知调度器安排查票
   * @param {Function} callback - 回调函数，参数为恢复的通道 (channel)
   */
  setHeartbeatRecoveredCallback(callback) {
    this.channels.forEach(ch => {
      if (ch) {
        ch.onHeartbeatRecovered = callback;
      }
    });
  }

  // 🆕 动态创建新通道（供P2/P3使用）
  createChannel(proxyKey) {

    // 找到对应的proxyConfig
    const proxyConfig = this.proxyConfigs.find(
      p => buildProxyKey(p) === proxyKey
    );
    if (!proxyConfig) {
      throw new Error(`未找到代理配置: ${proxyKey}`);
    }
    
    // 获取代理索引
    const proxyIndex = this.proxyConfigs.indexOf(proxyConfig);
    
    // 获取当前该代理的通道数量，用于生成唯一ID
    const existingChannels = this.proxyChannelMap.get(proxyKey) || [];
    const channelIndex = existingChannels.length + 1;
    
    // 轮询选择targetHost
    const targetHostConfig = this.getNextTargetHost(proxyKey);
    const channelId = `ch-${proxyKey}-${channelIndex}`;
    
    // 创建新通道
    const channel = new ConnectionChannel(
      this.config, proxyConfig, targetHostConfig.host, targetHostConfig.port,
      channelId, proxyIndex, this.logDb, targetHostConfig.sni || null
    );
    channel.onConnected = () => this.emit('channelConnected', channel);
    
    // 添加到通道列表
    this.channels.push(channel);
    
    // 确保proxyChannelMap有这个key
    if (!this.proxyChannelMap.has(proxyKey)) {
      this.proxyChannelMap.set(proxyKey, []);
    }
    this.proxyChannelMap.get(proxyKey).push(channel);
    
    // 更新accountChannelMap中包含此代理的所有账号
    this.accountChannelMap.forEach((channels, accountId) => {
      // 检查该账号是否使用了这个代理
      const usesThisProxy = channels.some(
        ch => buildProxyKey(ch.proxyConfig) === proxyKey
      );
      if (usesThisProxy && !channels.includes(channel)) {
        channels.push(channel);
      }
    });
    
    return channel;
  }

  getStatus() {
    const connectedChannels = this.channels.filter(ch => ch.isConnected).length;

    let totalCheckRequests = 0;
    let totalLockRequests = 0;
    this.proxyRequestState.forEach(state => {
      totalCheckRequests += state.checkRequestCount;
      totalLockRequests += state.lockRequestCount;
    });

    return {
      totalChannels: this.channels.length,
      connectedChannels: connectedChannels,
      checkRequests: totalCheckRequests,
      lockRequests: totalLockRequests
    };
  }

  close() {
    this.channels.forEach(ch => ch && ch.close && ch.close());
    this.accountChannelMap.clear();
    this.proxyChannelMap.clear();
    this.proxyRequestState.clear();
  }

  async initialize(proxyConfigs, logDb) {
    return this.initializeWithoutConnect(proxyConfigs, logDb);
  }
}

module.exports = ConnectionPool;
