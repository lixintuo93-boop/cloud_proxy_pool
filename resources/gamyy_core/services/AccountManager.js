// services/AccountManager.js - 统一账号管理
class AccountManager {
  constructor() {
    this.accounts = [];
    this.accountProxyMap = new Map();
    this.selectedAccounts = [];
  }

  // 设置所有账号
  setAccounts(accounts) {
    this.accounts = accounts;
  }

  // 为账号分配代理
  assignProxiesToAccount(accountId, proxies) {
    const proxyConfigs = proxies.map(proxy => {
      const config = {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        proxyId: proxy.proxy_id || proxy.id,
        realProxyIp: proxy.realProxyIp || proxy.host,
        proxyType: proxy.proxyType || 'standard'
      };

      // 直连模式：无需代理认证
      if (proxy.proxyType !== 'direct') {
        // 需要认证的代理类型（socks库使用userId和password字段）
        if ((proxy.proxyType === 'dingmao' || proxy.proxyType === 'standard') && proxy.username && proxy.password) {
          config.userId = proxy.username;
          config.password = proxy.password;
        }
      }

      // 代理级通道构建覆盖（startTime / windowTime / attempts）
      config.channelBuildOverride = proxy.channelBuildOverride || {};

      // 代理级目标主机覆盖（per-proxy targetHosts）：connectionPool 和 ScheduledService 都依赖它
      if (proxy.targetHosts && proxy.targetHosts.length) {
        config.targetHosts = proxy.targetHosts;
      }

      // 代理级完整有效配置（checkRequest / lockRequest / channelBuildPhase1 / queryParams 等）
      // _proxyCfg.pickCfg 通过 proxyConfig.cfg 路径取代理级配置；缺失则会 fall back 到任务级（=首代理），
      // 导致非首代理的查号/锁号/通道配置静默失效。这里必须透传过来。
      if (proxy.cfg) {
        config.cfg = proxy.cfg;
      }

      return config;
    });

    this.accountProxyMap.set(accountId, proxyConfigs);
    return proxyConfigs;
  }

  // 获取账号的代理配置
  getProxiesForAccount(accountId) {
    return this.accountProxyMap.get(accountId) || [];
  }

  // 随机选择指定数量的账号
  selectRandomAccounts(count) {
    if (this.accounts.length === 0) {
      return [];
    }
    
    const shuffled = [...this.accounts].sort(() => 0.5 - Math.random());
    this.selectedAccounts = shuffled.slice(0, Math.min(count, shuffled.length));
    return this.selectedAccounts;
  }

  // 获取选中的账号
  getSelectedAccounts() {
    return this.selectedAccounts.length > 0 ? this.selectedAccounts : this.accounts;
  }

  // 获取所有账号
  getAllAccounts() {
    return this.accounts;
  }

  // 调试信息
  debugAccountAssignments() {
    console.log('🔍 === 账号代理分配调试 ===');
    console.log(`总账号数: ${this.accounts.length}`);
    console.log(`选中账号数: ${this.selectedAccounts.length}`);
    
    this.accountProxyMap.forEach((proxies, accountId) => {
      const account = this.accounts.find(acc => acc.id === accountId || acc.account_id === accountId);
      const mobile = account ? account.mobile : '未知';
      console.log(`   账号 ${mobile} (${accountId}): ${proxies.length} 个代理`);
    });
    
    console.log('🔍 ========================');
  }

  // 清空数据
  clear() {
    this.accounts = [];
    this.accountProxyMap.clear();
    this.selectedAccounts = [];
  }
}

module.exports = AccountManager;
