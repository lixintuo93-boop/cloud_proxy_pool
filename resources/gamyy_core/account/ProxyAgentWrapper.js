'use strict';

const { SocksProxyAgent } = require('socks-proxy-agent');

class ProxyAgentWrapper {
  constructor(proxyConfig, silent = false) {
    if (!proxyConfig) throw new Error('必须提供SOCKS代理配置');
    this.proxyConfig = proxyConfig;
    this.silent = silent;
    this._createAgent();
    if (!silent) console.log(`🎯 创建SOCKS5代理: ${proxyConfig.host}:${proxyConfig.port}`);
  }

  _createAgent() {
    const { host, port, username, password } = this.proxyConfig;
    let url = 'socks5://';
    if (username && password) url += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
    url += `${host}:${port}`;
    this.keepAliveAgent = new SocksProxyAgent(url, {
      keepAlive: true,
      timeout: 30000,
      freeSocketTimeout: 15000
    });
  }

  destroy() {
    if (this.keepAliveAgent && this.keepAliveAgent.destroy) {
      this.keepAliveAgent.destroy();
    }
  }
}

module.exports = ProxyAgentWrapper;
