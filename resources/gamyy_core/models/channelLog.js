// models/channelLog.js - 简化版（移除重试逻辑）
class ChannelLog {
  constructor(channelId, proxyConfig, targetHost, targetPort, proxyIndex, channelType, retryCount = 0) {
    this.id = Date.now() + Math.random().toString(36).substr(2, 9);
    this.channelId = channelId;
    this.proxyIp = proxyConfig.realProxyIp || proxyConfig.host;
    this.proxyPort = proxyConfig.port;
    this.realProxyIp = proxyConfig.realProxyIp || null;  // 🆕 真实代理IP
    this.proxyIndex = proxyIndex;
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.channelType = channelType;
    this.startTime = Date.now();
    this.endTime = null;
    this.status = 'connecting';
    this.retryCount = retryCount;  // 保留字段兼容数据库
    this.maxRetries = 0;
    this.error = null;
  }

  connected() {
    this.endTime = Date.now();
    this.status = 'connected';
    this.error = null;
  }

  // 🆕 简化：移除重试参数
  failed(error) {
    this.endTime = Date.now();
    this.status = 'failed';
    this.error = error;
  }

  closed() {
    this.endTime = Date.now();
    this.status = 'closed';
  }

  toDatabaseObject() {
    if (this.status === 'connecting') {
      return null;
    }
    
    return {
      channelId: this.channelId,
      proxyIp: this.proxyIp,
      proxyPort: this.proxyPort,
      realProxyIp: this.realProxyIp,  // 🆕 真实代理IP
      proxyIndex: this.proxyIndex,
      targetHost: this.targetHost,
      targetPort: this.targetPort,
      channelType: this.channelType,
      startTime: this.startTime,
      endTime: this.endTime,
      status: this.status,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
      error: this.error
    };
  }
}

module.exports = ChannelLog;