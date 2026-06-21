// utils/proxyManager.js - 代理管理器
const { SocksProxyAgent } = require('socks-proxy-agent');

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.proxySubmitSignMap = new Map();
  }

  setProxies(proxies) {
    this.proxies = proxies;
    this.proxySubmitSignMap.clear();
  }

  // 获取所有代理配置
  getAllProxyConfigs() {
    const configs = this.proxies.map(proxy => {
      const config = {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        proxyId: proxy.proxy_id || proxy.id,
        proxyType: proxy.proxyType || 'standard'
      };

      if (proxy.username && proxy.password) {
        config.userId = proxy.username;
        config.password = proxy.password;
      }

      // 标准代理携带真实出口IP，用于唯一标识和数据库记录
      if (proxy.realProxyIp) {
        config.realProxyIp = proxy.realProxyIp;
      }

      // 代理级目标主机覆盖（优先级最高）
      if (proxy.targetHosts && proxy.targetHosts.length) {
        config.targetHosts = proxy.targetHosts;
      }

      // 代理级通道构建覆盖（startTime / windowTime / attempts）
      config.channelBuildOverride = proxy.channelBuildOverride || {};

      // 代理级完整有效配置：channel.proxyConfig.cfg 路径下游被多处使用
      if (proxy.cfg) {
        config.cfg = proxy.cfg;
      }

      return config;
    });

    return configs;
  }

  // 存储代理IP的submitsign
  setProxySubmitSign(proxyHost, proxyPort, submitSign) {
    const proxyKey = `${proxyHost}:${proxyPort}`;
    this.proxySubmitSignMap.set(proxyKey, submitSign);
  }

  // 获取代理IP的submitsign
  getProxySubmitSign(proxyHost, proxyPort) {
    const proxyKey = `${proxyHost}:${proxyPort}`;
    return this.proxySubmitSignMap.get(proxyKey);
  }

  // 创建SOCKS代理agent
  createSocksProxyAgent(proxy) {
    if (!proxy) return null;

    try {
      let proxyUrl;

      if (proxy.username && proxy.password) {
        proxyUrl = `socks5://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
      } else {
        proxyUrl = `socks5://${proxy.host}:${proxy.port}`;
      }

      const agent = new SocksProxyAgent(proxyUrl, {
        timeout: 6000000
      });
      
      return {
        agent: agent,
        host: proxy.host,
        port: proxy.port,
        protocol: 'socks5',
        proxyType: proxy.proxyType || 'standard',
        username: proxy.username || null,
        password: proxy.password || null
      };
    } catch (error) {
      console.error('创建SOCKS代理失败:', error);
      return null;
    }
  }

  getProxyCount() {
    return this.proxies.length;
  }

  hasProxies() {
    return this.proxies.length > 0;
  }

  // 获取唯一代理数量
  getUniqueProxyCount(accountManager) {
    const uniqueProxies = new Set();
    accountManager.getAllAccounts().forEach(account => {
      const proxies = accountManager.getProxiesForAccount(account.id || account.account_id);
      proxies.forEach(proxy => {
        uniqueProxies.add(proxy.realProxyIp || `${proxy.host}:${proxy.port}`);
      });
    });
    return uniqueProxies.size;
  }
}

module.exports = ProxyManager;
