// services/ChannelManager.js - 简化版：不区分查号/锁号通道


class ChannelManager {
  constructor(ticketService, accountManager) {
    this.ticketService = ticketService;
    this.accountManager = accountManager;
    this.channelTrackers = new Map();
  }

  // 初始化通道跟踪器
  initializeChannelTrackers(accounts) {
    accounts.forEach(account => {
      const accountId = account.id || account.account_id;
      const proxyConfigs = this.accountManager.getProxiesForAccount(accountId);
      if (proxyConfigs && proxyConfigs.length > 0) {
        const assignedChannels = this.ticketService.connectionPool.assignChannelsToAccount(accountId, proxyConfigs);
        this.initializeAccountChannels(accountId, assignedChannels);
      }
    });
  }

  // 为单个账号初始化通道跟踪器
  initializeAccountChannels(accountId, channels) {
    const tracker = {
      channels: channels.map(channel => ({
        channelId: channel.channelId,
        completedRequests: 0,
        isActive: true
      })),
      totalCompleted: 0
    };
    this.channelTrackers.set(accountId, tracker);
  }

  // 为单个通道初始化跟踪器
  initializeChannelTrackerForChannel(accountId, channel) {
    let tracker = this.channelTrackers.get(accountId);
    if (!tracker) {
      tracker = {
        channels: [],
        totalCompleted: 0
      };
      this.channelTrackers.set(accountId, tracker);
    }
    
    const existingChannel = tracker.channels.find(ch => ch.channelId === channel.channelId);
    if (!existingChannel) {
      tracker.channels.push({
        channelId: channel.channelId,
        completedRequests: 0,
        isActive: true
      });
    }
  }

  // 更新通道跟踪器
  updateChannelTracker(accountId, channelId, completedRequests) {
    const tracker = this.channelTrackers.get(accountId);
    if (tracker) {
      const channel = tracker.channels.find(ch => ch.channelId === channelId);
      if (channel) {
        channel.completedRequests = completedRequests;
      }
      
      tracker.totalCompleted = tracker.channels.reduce((sum, ch) => sum + ch.completedRequests, 0);
    }
  }

  // 获取进度统计
  getProgressStats() {
    let totalCompleted = 0;
    let activeChannels = 0;
    
    this.channelTrackers.forEach(tracker => {
      totalCompleted += tracker.totalCompleted;
      
      tracker.channels.forEach(ch => {
        if (ch.isActive) {
          activeChannels++;
        }
      });
    });
    
    return {
      totalCompleted,
      activeChannels
    };
  }

  // 获取账号通道状态
  getAccountChannelStatus(accountId) {
    const tracker = this.channelTrackers.get(accountId);
    if (!tracker) return { channels: [] };
    
    return {
      channels: tracker.channels.map(ch => ({
        channelId: ch.channelId,
        completedRequests: ch.completedRequests,
        isActive: ch.isActive
      }))
    };
  }

  // 清理跟踪器
  clearTrackers() {
    this.channelTrackers.clear();
  }
}

module.exports = ChannelManager;
