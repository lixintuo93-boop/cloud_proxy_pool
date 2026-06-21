// services/SchedulerService.js - 重构版本
const TicketService = require('./TicketService');
const AccountManager = require('./AccountManager');
const ProxyManager = require('../utils/proxyManager');
const ChannelManager = require('./ChannelManager');
const ChannelStarter = require('./ChannelStarter');
const ScheduledService = require('./ScheduledService');


class SchedulerService {
  constructor(config) {
    this.config = config;
    this.ticketService = new TicketService(config);
    this.accountManager = new AccountManager();
    this.proxyManager = new ProxyManager();

    this.channelManager = new ChannelManager(this.ticketService, this.accountManager);
    this.channelStarter = new ChannelStarter(this.ticketService, this.accountManager, this.channelManager, config);
    this.scheduledService = new ScheduledService(this.ticketService, this.accountManager, this.channelManager, this.channelStarter, config);

    this.proxies = [];
    this.onAutoStop = null;
  }

  setOnAutoStop(callback) {
    this.onAutoStop = callback;
  }

  async initialize() {
    try {
      if (!this.config._proxies?.length) {
        throw new Error('没有可用的代理，请在 Web 管理界面为账号分配代理后再启动任务');
      }
      this.proxies = this.config._proxies;
      console.log(`📡 使用预分配代理: ${this.proxies.length} 个`);

      if (!this.config._accounts?.length) {
        throw new Error('没有可用的账号，任务配置缺少 _accounts 字段');
      }
      const allAccounts = this.config._accounts;
      console.log(`👤 使用传入账号: ${allAccounts.length} 个`);

      this.proxyManager.setProxies(this.proxies);
      this.accountManager.setAccounts(allAccounts);

      // 为账号分配代理
      await this.distributeAccountsToProxies();

      // 设置到TicketService
      this.ticketService.setProxyManager(this.proxyManager);
      this.ticketService.setAccountManager(this.accountManager);

      // 初始化TicketService（异步加载医生数据）
      await this.ticketService.init();

      const encryptionStatus = this.ticketService.getEncryptionStatus();
      if (!encryptionStatus.isEncrypted) {
        throw new Error('数据加密初始化失败');
      }

      return {
        accounts: allAccounts.length,
        totalAccounts: allAccounts.length,
        proxies: this.proxyManager.getUniqueProxyCount(this.accountManager)
      };
    } catch (error) {
      console.error('初始化失败:', error);
      throw error;
    }
  }

  // 为账号分配代理（轮询分配，所有代理都有归属，无遗漏）
  async distributeAccountsToProxies() {
    const accounts = this.accountManager.getAllAccounts();
    if (accounts.length === 0) {
      console.log('⚠️ 没有账号，跳过代理分配');
      return;
    }

    // 轮询分配：代理按顺序依次分给账号，确保所有代理都被使用
    const accountProxyArrays = accounts.map(() => []);
    this.proxies.forEach((proxy, proxyIndex) => {
      const accountIndex = proxyIndex % accounts.length;
      accountProxyArrays[accountIndex].push(proxy);
    });

    accounts.forEach((account, index) => {
      const accountId = account.id || account.account_id;
      this.accountManager.assignProxiesToAccount(accountId, accountProxyArrays[index]);
    });

    const counts = accountProxyArrays.map(a => a.length);
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const countDesc = minCount === maxCount ? `每账号${minCount}个` : `每账号${minCount}~${maxCount}个`;
    console.log(`✅ 代理分配完成: ${accounts.length}个账号，${this.proxies.length}个代理（轮询分配，${countDesc}）`);
  }

  // 启动定时查票
  async startScheduledCheck() {
    const accounts = this.accountManager.getSelectedAccounts();
    return this.scheduledService.startScheduledCheck(accounts, this.onAutoStop);
  }

  // 停止定时查票
  stopScheduledCheck() {
    this.scheduledService.stopScheduledCheck();
  }

  // 获取选中的锁号账号
  getSelectedLockAccounts() {
    return this.accountManager.getSelectedAccounts();
  }

  getProxyStats() {
    return this.scheduledService.getProxyStats();
  }

  /**
   * 🆕 改进的资源清理方法
   */
  async cleanup() {
    console.log('🧹 开始清理资源...');
    
    // 1. 停止定时查票
    try {
      this.stopScheduledCheck();
    } catch (e) {
      console.error('⚠️ 停止定时查票时出错:', e.message);
    }
    
    // 2. 清理 ticketService
    try {
      this.ticketService.cleanup();
    } catch (e) {
      console.error('⚠️ 清理ticketService时出错:', e.message);
    }
    
    // 3. 清理账号管理器
    try {
      this.accountManager.clear();
    } catch (e) {
      console.error('⚠️ 清理账号管理器时出错:', e.message);
    }
    
    console.log('✅ 资源清理完成');
  }
}

module.exports = SchedulerService;
