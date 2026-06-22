// services/connectionChannel.js - 智能响应匹配版本：基于响应内容匹配请求类型
const tls = require('tls');
const crypto = require('crypto');
const { SocksClient } = require('socks');

const ChannelLog = require('../models/channelLog');
const CryptoUtils = require('../crypto/cryptoUtils');
const ProxyHeartbeatDispatcher = require('./ProxyHeartbeatDispatcher');
const { pickRandomRecipe, pickInterval } = require('./HeartbeatEndpointPool');

// ========== 常量定义 ==========
const CONNECTION_CHANNEL_CONSTANTS = {
  // Socket最大监听器数量
  MAX_LISTENERS: 100,
  // 默认请求超时时间
  DEFAULT_REQUEST_TIMEOUT: 60000,
};

// 🆕 CryptoUtils 单例，避免每个通道都创建新实例
let sharedCryptoUtils = null;
function getSharedCryptoUtils() {
  if (!sharedCryptoUtils) {
    sharedCryptoUtils = new CryptoUtils();
  }
  return sharedCryptoUtils;
}

// 心跳 UA 兜底：仅当 config._accounts[0].user_agent 缺失时使用，正常路径不会触发
function _DEFAULT_HEARTBEAT_UA(platform) {
  if (platform === 'android') {
    return 'Mozilla/5.0 (Linux; Android 14; LE2110 Build/UKQ1.230924.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/34.333332)';
  }
  if (platform === 'wechat') {
    return 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.64(0x1800402d) NetType/WIFI Language/zh_CN';
  }
  return 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/59) uni-app';
}

class ConnectionChannel {
  constructor(config, proxyConfig, targetHost, targetPort, channelId, proxyIndex, logDb, sni = null) {
    this.config = config;
    this.proxyConfig = proxyConfig;
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.sni = sni;  // TLS握手时的SNI，为null时使用targetHost
    this.channelId = channelId;
    this.proxyIndex = proxyIndex;
    this.logDb = logDb;
    
    this.socket = null;
    this.rawTcpSocket = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.requestCount = 0;
    
    // 串行控制：通道是否正在处理请求
    this.isBusy = false;
    // 记录通道连接成功的时间戳
    this.connectedAt = null;
    // 记录通道最后活动时间（收到响应时更新），用于选择"最久没活动"的通道
    this.lastActiveAt = null;
    // 记录上次请求开始时间，用于计算复用间隔
    this.lastRequestStartTime = null;
    
    // 记录通道是在哪个阶段被尝试创建的 (1=P1, 2=P2, 3=P3, 0=未尝试)
    this.attemptPhase = 0;
    
    this.onConnected = null;
    this.channelLog = null;
    this.isStopped = false;
    
    // 连接结果回调（用于统计）
    this.onConnectResult = null;
    
    // 请求队列：按发送顺序存储等待响应的请求
    this.pendingRequests = [];
    
    // 当前正在接收的响应数据
    this.currentResponseBuffer = Buffer.from('');
    this.currentHeadersComplete = false;
    this.currentContentLength = null;
    this.currentIsChunked = false;
    
    // 是否已绑定全局数据监听器
    this.dataListenerBound = false;
    
    // 使用共享的CryptoUtils单例
    this.cryptoUtils = getSharedCryptoUtils();
    
    // 🆕 心跳相关属性
    this.heartbeatTimer = null;           // 心跳定时器（setTimeout句柄）
    this.heartbeatCount = 0;              // 心跳总次数
    this.heartbeatSuccessCount = 0;       // 心跳成功次数
    this.lastHeartbeatTime = null;        // 上次心跳时间
    this.lastHeartbeatSuccessAt = null;   // 最后一次心跳成功的时间戳（用于代理优先级评分）
    this.isHeartbeatPending = false;      // 是否有心跳请求正在等待响应

    // 🆕 systemConfig 心跳专用：每个代理固定的随机标识（32位十六进制）
    this.s456hr8 = null;

    // 🆕 心跳恢复后的回调（查票窗口期内心跳返回后，通知调度器安排查票）
    this.onHeartbeatRecovered = null;

    // 🆕 心跳取消用：存储 sendHeartbeatRequest 内部引用，供 _cancelPendingHeartbeat 使用
    this._heartbeatReject = null;
    this._heartbeatTimeoutTimer = null;
    this._heartbeatOnData = null;
  }

  // 心跳/keepAlive 已下沉到代理级：优先读 per-proxy 的 cfg.keepAlive，
  // 兜底到顶层 config.keepAlive（兼容尚未升级、仍下发顶层 keepAlive 的旧链路）。
  _ka() {
    return this.proxyConfig?.cfg?.keepAlive || this.config.keepAlive || {};
  }
  _hbTimeout() {
    return this.proxyConfig?.cfg?.heartbeatTimeout
        || this.config?.timeout?.heartbeatTimeout
        || 10000;
  }

  stop() { this.isStopped = true; this.stopHeartbeat(); }
  resume() { this.isStopped = false; this.startHeartbeat(); }
  
  /**
   * 取消所有pending的查票请求
   * @returns {Array} 被取消的请求信息列表
   */
  cancelAllPendingCheckRequests() {
    const cancelledRequests = [];
    const remainingRequests = [];
    
    for (const request of this.pendingRequests) {
      if (request.requestType === 'check') {
        cancelledRequests.push({
          requestId: request.requestId,
          type: request.requestType,
          startTime: request.startTime,
          channelId: this.channelId,
          cancelReason: 'CANCELLED_BY_TICKET_FOUND',
          account: request.account
        });
        
        // 清理超时定时器
        if (request.timeout) clearTimeout(request.timeout);
        
        // 调用reject
        request.reject({
          success: false,
          statusCode: 0,
          error: new Error('请求被取消: CANCELLED_BY_TICKET_FOUND'),
          errorType: 'REQUEST_CANCELLED',
          errorDetail: 'CANCELLED_BY_TICKET_FOUND',
          account: request.account.mobile,
          channelId: this.channelId,
          requestCount: request.requestIndex,
          duration: Date.now() - request.startTime,
          requestType: request.requestType,
          requestId: request.requestId,
          cancelled: true
        });
      } else {
        remainingRequests.push(request);
      }
    }
    
    this.pendingRequests = remainingRequests;
    
    // 🆕 关键修复：如果没有剩余pending请求，重置忙碌状态
    if (this.pendingRequests.length === 0) {
      this.isBusy = false;
    }
    
    if (cancelledRequests.length > 0) {
      // 不再打印单个通道取消日志
    }
    return cancelledRequests;
  }
  
  /**
   * 取消特定类型的所有pending请求
   * @param {string} requestType - 'check' 或 'lock'
   * @returns {Array} 被取消的请求信息列表
   */
  cancelPendingRequestsByType(requestType) {
    const cancelledRequests = [];
    const remainingRequests = [];
    
    for (const request of this.pendingRequests) {
      if (request.requestType === requestType) {
        cancelledRequests.push({
          requestId: request.requestId,
          type: request.requestType,
          startTime: request.startTime,
          channelId: this.channelId,
          cancelReason: `CANCELLED_${requestType.toUpperCase()}`,
          account: request.account
        });
        
        if (request.timeout) clearTimeout(request.timeout);
        
        request.reject({
          success: false,
          statusCode: 0,
          error: new Error(`请求被取消: CANCELLED_${requestType.toUpperCase()}`),
          errorType: 'REQUEST_CANCELLED',
          errorDetail: `CANCELLED_${requestType.toUpperCase()}`,
          account: request.account.mobile,
          channelId: this.channelId,
          requestCount: request.requestIndex,
          duration: Date.now() - request.startTime,
          requestType: request.requestType,
          requestId: request.requestId,
          cancelled: true
        });
      } else {
        remainingRequests.push(request);
      }
    }
    
    this.pendingRequests = remainingRequests;
    
    // 🆕 关键修复：如果没有剩余pending请求，重置忙碌状态
    if (this.pendingRequests.length === 0) {
      this.isBusy = false;
    }
    
    return cancelledRequests;
  }
  
  // 🆕 简化：只检查是否被停止，不再有重试次数限制
  isAvailable() { return !this.isStopped; }
  
  canBeUsed() {
    return this.isConnected && !this.isStopped;
  }

  // 🆕 判断通道是否可以接受新请求（已连接、未停止、未忙碌）
  isAvailableForRequest() {
    return this.isConnected && !this.isStopped && !this.isBusy;
  }

  formatLocalTime(timestamp = Date.now()) {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}.${String(date.getMilliseconds()).padStart(3,'0')}`;
  }

  createChannelLog() {
    this.channelLog = new ChannelLog(
      this.channelId, this.proxyConfig, this.targetHost, this.targetPort,
      this.proxyIndex, 'unified', 0  // 🆕 移除重试计数
    );
  }

  async saveChannelLog(status, error = null) {
    if (!this.channelLog) this.createChannelLog();
    
    if (status === 'connected') this.channelLog.connected();
    else if (status === 'failed') this.channelLog.failed(error);  // 🆕 简化参数
    else if (status === 'closed') this.channelLog.closed();
    
    if (this.logDb) {
      await this.logDb.saveChannelLog(this.channelLog).catch(() => {});
    }
  }

  // 🆕 简化：尝试一次连接，成功就成功，失败就失败，无需重试
  async connect() {
    if (this.isConnected || this.isConnecting) return;

    this.isConnecting = true;
    this.createChannelLog();
    
    try {
      await this.attemptConnect();
      if (this.onConnectResult) this.onConnectResult(true);
    } catch (error) {
      this.isConnecting = false;
      await this.saveChannelLog('failed', error.message);
      if (this.onConnectResult) this.onConnectResult(false, error.message);
      throw new Error(`通道建立失败: ${error.message}`);
    }
  }

  async reconnect() {
    this.isConnected = false;
    this.isConnecting = false;
    
    // 清理请求队列
    this.clearPendingRequests('连接断开');
    
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) {}
      this.socket = null;
    }
    
    this.dataListenerBound = false;
    return this.connect();
  }

  // 绑定全局数据监听器（只绑定一次）
  bindDataListener() {
    if (this.dataListenerBound || !this.socket) return;
    this.dataListenerBound = true;
    
    this.socket.on('data', (data) => this.handleIncomingData(data));
    this.socket.on('error', (error) => this.handleSocketError(error));
    this.socket.on('close', () => this.handleSocketClose());
  }

  // 处理接收到的数据
  handleIncomingData(data) {
    this.currentResponseBuffer = Buffer.concat([this.currentResponseBuffer, data]);
    this.tryCompleteResponse();
  }

  /**
   * 🆕 从响应内容中检测响应类型
   * @param {string} responseText - 原始响应文本
   * @returns {string} 'check' | 'lock' | 'unknown'
   */
  detectResponseType(responseText) {
    try {
      // 尝试解密响应内容
      const decryptedData = this.cryptoUtils.processResponse(responseText);
      
      if (!decryptedData || decryptedData.code === -1) {
        // 解密失败，尝试从原始响应判断
        return 'unknown';
      }
      
      const msg = decryptedData.msg || '';
      const value = decryptedData.value;
      
      // 🔑 关键判断逻辑：
      
      // 1. 锁号成功响应：msg 包含 "预约成功"
      if (msg.includes('预约成功')) {
        return 'lock';
      }
      
      // 2. 锁号失败响应：msg 包含锁号相关关键词
      const lockKeywords = [
        '锁号', '已被预约', '号源不足', '预约失败', '已锁定', '无法预约',
        '锁定失败', '号源已满', '已挂满', '无号', '没有号', '号已抢完',
        '重复预约', '已预约', '不能预约', '预约已满', '挂号失败',
        '锁定超时', '订单', '挂号', '排队'
      ];
      for (const keyword of lockKeywords) {
        if (msg.includes(keyword)) {
          return 'lock';
        }
      }
      
      // 3. 查号响应：msg 包含 "查询成功"
      if (msg.includes('查询成功')) {
        return 'check';
      }
      
      // 4. 查号响应：value 是数组且包含 planList 或 doctorList（医生/部门查询结果）
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item.planList || item.doctorList || item.registerTypeCode) {
            return 'check';
          }
        }
      }
      
      // 5. 锁号响应：value 包含 orderId 或 applyId（预约订单）
      if (value && (value.orderId || value.applyId || value.lockId)) {
        return 'lock';
      }
      
      // 6. 其他情况，根据 code 判断
      // code=0 但没有明确标识，默认为 check（因为查号更频繁）
      if (decryptedData.code === 0) {
        return 'check';
      }
      
      return 'unknown';
      
    } catch (error) {
      // 解密失败，静默返回unknown
      return 'unknown';
    }
  }

  /**
   * 🆕 根据响应类型智能匹配请求
   * @param {string} responseType - 检测到的响应类型
   * @returns {Object|null} 匹配到的请求，或 null
   */
  findMatchingRequest(responseType) {
    if (this.pendingRequests.length === 0) {
      return null;
    }
    
    // 1. 优先匹配相同类型的请求
    if (responseType !== 'unknown') {
      const matchIndex = this.pendingRequests.findIndex(req => req.requestType === responseType);
      
      if (matchIndex !== -1) {
        return this.pendingRequests.splice(matchIndex, 1)[0];
      }
    }
    
    // 2. 如果没有匹配到相同类型，或类型未知，回退到 FIFO
    return this.pendingRequests.shift();
  }

  // 🆕 重写：尝试完成当前响应（智能匹配版本）
  tryCompleteResponse() {
    if (this.pendingRequests.length === 0) {
      // 没有等待的请求，静默丢弃数据（请求被取消后响应仍会到达，这是正常情况）
      this.currentResponseBuffer = Buffer.from('');
      return;
    }

    // 解析响应头
    if (!this.currentHeadersComplete) {
      const headerEndIndex = this.currentResponseBuffer.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) return; // 头部还没接收完
      
      this.currentHeadersComplete = true;
      const headersText = this.currentResponseBuffer.subarray(0, headerEndIndex).toString();
      
      const contentLengthMatch = headersText.match(/Content-Length:\s*(\d+)/i);
      if (contentLengthMatch) {
        this.currentContentLength = parseInt(contentLengthMatch[1]);
      }
      this.currentIsChunked = headersText.toLowerCase().includes('transfer-encoding: chunked');
    }

    // 检查响应体是否完整
    const headerEndIndex = this.currentResponseBuffer.indexOf('\r\n\r\n');
    const bodyData = this.currentResponseBuffer.subarray(headerEndIndex + 4);
    
    let isComplete = false;
    if (this.currentContentLength !== null) {
      isComplete = bodyData.length >= this.currentContentLength;
    } else if (this.currentIsChunked) {
      isComplete = bodyData.includes(Buffer.from('0\r\n\r\n'));
    }

    if (isComplete) {
      const responseData = this.currentResponseBuffer;
      const responseText = responseData.toString();
      
      // 重置状态准备接收下一个响应
      this.currentResponseBuffer = Buffer.from('');
      this.currentHeadersComplete = false;
      this.currentContentLength = null;
      this.currentIsChunked = false;
      
      // 🆕 检测响应类型
      const responseType = this.detectResponseType(responseText);
      
      // 🆕 智能匹配请求
      const request = this.findMatchingRequest(responseType);
      
      if (request) {
        // 完成请求，附带检测到的响应类型
        this.completeRequest(request, responseData, responseType);
      }
    }
  }

  // 🆕 完成请求（增加响应类型参数）
  completeRequest(request, responseData, detectedResponseType = null) {
    if (request.timeout) clearTimeout(request.timeout);
    
    // 🆕 响应完成，解除忙碌状态
    this.isBusy = false;
    
    // 请求成功被服务器接收，重置connectedAt（刷新通道存活时间）
    this.connectedAt = Date.now();
    // 更新最后活动时间（用于锁号时选择"最久没活动"的通道）
    this.lastActiveAt = this.connectedAt;

    // 查票/锁号请求和心跳一样会刷新服务器侧的通道计时器
    // 基于最新的 connectedAt 重新调度下次心跳，避免心跳按旧计划提前触发
    if (this._ka().enabled && this.isConnected && !this.isStopped) {
      this.scheduleNextHeartbeat(this._ka().interval || 30000);
    }
    
    const duration = Date.now() - request.startTime;
    const responseText = responseData.toString();
    
    let statusCode = 0;
    let isSuccess = false;
    
    if (responseText.length > 0) {
      const statusMatch = responseText.match(/HTTP\/\d\.\d\s+(\d+)/);
      if (statusMatch) {
        statusCode = parseInt(statusMatch[1]);
        isSuccess = statusCode >= 200 && statusCode < 300;
      }
    }
    
    // 检查响应类型与请求类型是否匹配
    const typeMatched = !detectedResponseType || 
                        detectedResponseType === 'unknown' || 
                        detectedResponseType === request.requestType;
    
    request.resolve({
      success: isSuccess, 
      statusCode, 
      data: responseText, 
      rawData: responseData,
      account: request.account.mobile, 
      channelId: this.channelId, 
      requestCount: request.requestIndex, 
      duration,
      requestType: request.requestType,
      requestId: request.requestId,
      // 🆕 新增字段
      detectedResponseType: detectedResponseType,
      typeMatched: typeMatched
    });
  }

  // 处理socket错误
  handleSocketError(error) {
    this.isConnected = false;
    // 🆕 取消正在等待的心跳请求，立即记录实际耗时（而非等待60s超时）
    this._cancelPendingHeartbeat(`Socket错误: ${error.message}`);
    this.clearPendingRequests(`Socket错误: ${error.message}`);
  }

  // 处理socket关闭
  handleSocketClose() {
    this.isConnected = false;

    // 如果还有未完成的数据和请求，尝试完成
    if (this.currentResponseBuffer.length > 0 && this.pendingRequests.length > 0) {
      const responseText = this.currentResponseBuffer.toString();
      const responseType = this.detectResponseType(responseText);
      const request = this.findMatchingRequest(responseType);

      if (request) {
        this.completeRequest(request, this.currentResponseBuffer, responseType);
      }
    }

    // 🆕 取消正在等待的心跳请求，立即记录实际耗时（而非等待60s超时）
    this._cancelPendingHeartbeat('连接关闭');

    // 清理剩余请求
    this.clearPendingRequests('连接关闭');
    
    if (this.channelLog && this.channelLog.status === 'connected') {
      this.saveChannelLog('closed');
    }
  }

  /**
   * 取消正在等待的心跳请求（通道关闭或 Socket 错误时调用）
   * 立即 reject，使 sendHeartbeat catch 块以实际耗时记录日志，
   * 而非等待 60s 超时后才写入"心跳超时(60000ms)"
   */
  _cancelPendingHeartbeat(reason) {
    if (!this.isHeartbeatPending || !this._heartbeatReject) return;

    // 清理超时定时器
    if (this._heartbeatTimeoutTimer) {
      clearTimeout(this._heartbeatTimeoutTimer);
      this._heartbeatTimeoutTimer = null;
    }

    // 移除数据监听器（socket 尚未置 null，可安全移除）
    if (this._heartbeatOnData && this.socket) {
      try { this.socket.removeListener('data', this._heartbeatOnData); } catch (e) {}
      this._heartbeatOnData = null;
    }

    // 解除忙碌状态
    this.isBusy = false;

    // 调用 reject，触发 sendHeartbeat catch 块记录实际耗时和错误原因
    const rejectFn = this._heartbeatReject;
    this._heartbeatReject = null;
    rejectFn(new Error(reason));
  }

  // 清理所有等待的请求（改进版：更安全的清理逻辑）
  clearPendingRequests(reason) {
    // 🆕 先获取当前所有请求的引用，避免在循环中修改数组
    const requestsToClear = this.pendingRequests.slice();
    this.pendingRequests = []; // 立即清空数组
    
    // 🆕 清理请求队列后解除忙碌状态
    this.isBusy = false;
    
    // 逐个处理每个请求
    for (const request of requestsToClear) {
      try {
        // 清理超时定时器
        if (request.timeout) {
          clearTimeout(request.timeout);
          request.timeout = null;
        }
        
        // 调用reject通知调用方
        if (request.reject) {
          request.reject({
            success: false, 
            statusCode: 0,
            error: new Error(reason),
            errorType: 'CONNECTION_ERROR',
            errorDetail: reason,
            account: request.account ? request.account.mobile : 'unknown', 
            channelId: this.channelId,
            requestCount: request.requestIndex, 
            duration: Date.now() - request.startTime,
            requestType: request.requestType,
            requestId: request.requestId
          });
        }
      } catch (e) {
        // 静默处理单个请求的错误，继续清理其他请求
      }
    }
    
    // 重置响应缓冲状态
    this.currentResponseBuffer = Buffer.from('');
    this.currentHeadersComplete = false;
    this.currentContentLength = null;
    this.currentIsChunked = false;
  }

  async attemptConnect() {
    let rawTcpSocket;

    if (this.proxyConfig.proxyType === 'direct') {
      // 直连模式：绕过 SOCKS，直接建立 TCP 连接
      const net = require('net');
      rawTcpSocket = await new Promise((resolve, reject) => {
        const sock = net.createConnection({ host: this.targetHost, port: this.targetPort });
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error(`直连TCP超时(${this.config.timeout.connectTimeout}ms)`));
        }, this.config.timeout.connectTimeout);
        sock.on('connect', () => { clearTimeout(timer); resolve(sock); });
        sock.on('error', (e)  => { clearTimeout(timer); reject(e); });
      });
    } else {
      const { socket } = await SocksClient.createConnection({
        proxy: this.proxyConfig,
        destination: { host: this.targetHost, port: this.targetPort },
        command: 'connect',
        timeout: this.config.timeout.connectTimeout
      });
      rawTcpSocket = socket;
    }

    // 保存原始 TCP socket 引用
    this.rawTcpSocket = rawTcpSocket;

    // 直连模式：额外启用 TCP 层 Keepalive，防止 NAT/防火墙在两次应用层心跳之间静默丢连接
    // initial delay 取应用层心跳间隔的一半，确保在心跳间隔内至少触发一次探测
    // 仅在系统配置中开启"直连TCP保活"时生效
    const isDirect = this.proxyConfig.proxyType === 'direct';
    if (isDirect && this._ka().enabled && this._ka().directKeepaliveEnabled) {
      const appInterval = this._ka().interval || 30000;
      rawTcpSocket.setKeepAlive(true, Math.floor(appInterval / 2));
    }

    this.socket = tls.connect({
      socket: rawTcpSocket,
      host: this.targetHost,
      servername: this.sni || this.targetHost,
      rejectUnauthorized: false
    });

    this.socket.setMaxListeners(CONNECTION_CHANNEL_CONSTANTS.MAX_LISTENERS);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`TLS连接超时(${this.config.timeout.connectTimeout}ms)`));
      }, this.config.timeout.connectTimeout);

      this.socket.on('secureConnect', async () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.isConnecting = false;
        // 记录通道连接成功的时间戳
        this.connectedAt = Date.now();
        // 初始化最后活动时间为连接时间
        this.lastActiveAt = this.connectedAt;

        // 绑定全局数据监听器
        this.bindDataListener();

        // 直连模式：TCP Keepalive + 应用层心跳双保险；代理模式：仅应用层心跳
        this.startHeartbeat();
        
        await this.saveChannelLog('connected');
        // console.log(`✅ [通道 ${this.channelId}] 连接成功`);
        if (this.onConnected) this.onConnected();
        resolve(this);
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeout);
        this.isConnecting = false;
        reject(error);
      });
    });
  }

  getStatusDescription() {
    if (this.isStopped) return '已停止';
    if (this.isConnected) {
      // 🆕 显示忙碌状态
      const busyStatus = this.isBusy ? '忙碌' : '空闲';
      return `已连接(${this.requestCount}次,${busyStatus})`;
    }
    if (this.isConnecting) return '连接中';
    return '待连接';
  }

  /**
   * 发送请求
   * @param {string} requestData - 请求数据
   * @param {Object} account - 账号信息
   * @param {string} requestType - 请求类型 ('check' | 'lock')
   * @param {string} requestId - 请求唯一ID
   */
  async sendRequest(requestData, account, requestType = 'check', requestId = null) {
    if (this.isStopped) {
      throw { 
        success: false, statusCode: 0, 
        error: new Error('通道已停止'), 
        errorType: 'CHANNEL_STOPPED',
        requestType,
        requestId
      };
    }
    if (!this.isConnected) {
      throw { 
        success: false, statusCode: 0, 
        error: new Error('通道未连接'), 
        errorType: 'CHANNEL_DISCONNECTED',
        requestType,
        requestId
      };
    }
    
    // 🆕 检查通道是否忙碌（串行控制）
    if (this.isBusy) {
      throw { 
        success: false, statusCode: 0, 
        error: new Error('通道忙碌'), 
        errorType: 'CHANNEL_BUSY',
        requestType,
        requestId
      };
    }
    
    // 🆕 标记通道为忙碌
    this.isBusy = true;

    this.requestCount++;
    const requestIndex = this.requestCount;
    const startTime = Date.now();
    
    // 🆕 记录请求开始时间（用于复用时计算间隔）
    this.lastRequestStartTime = startTime;
    
    const currentRequestId = requestId || `${this.channelId}-${requestIndex}-${startTime}`;

    return new Promise((resolve, reject) => {
      // 创建请求对象
      const request = {
        account,
        requestIndex,
        startTime,
        requestType,
        requestId: currentRequestId,
        resolve,
        reject,
        timeout: null
      };

      // 设置超时
      request.timeout = setTimeout(() => {
        // 从队列中移除
        const index = this.pendingRequests.indexOf(request);
        if (index !== -1) {
          this.pendingRequests.splice(index, 1);
        }
        // 🆕 超时时解除忙碌状态
        this.isBusy = false;
        reject({
          success: false, 
          statusCode: 0,
          error: new Error('请求超时'),
          errorType: 'TIMEOUT',
          errorDetail: `请求超时(${this.config.timeout.requestTimeout}ms)`,
          account: account.mobile,
          channelId: this.channelId,
          requestCount: requestIndex,
          duration: Date.now() - startTime,
          requestType,
          requestId: currentRequestId
        });
      }, this.config.timeout.requestTimeout);

      // 加入请求队列
      this.pendingRequests.push(request);

      // 发送请求
      try {
        this.socket.write(requestData);
      } catch (error) {
        // 从队列中移除
        const index = this.pendingRequests.indexOf(request);
        if (index !== -1) {
          this.pendingRequests.splice(index, 1);
        }
        if (request.timeout) clearTimeout(request.timeout);
        // 🆕 写入失败时解除忙碌状态
        this.isBusy = false;
        
        reject({
          success: false, 
          statusCode: 0,
          error: error,
          errorType: 'WRITE_ERROR',
          errorDetail: `写入数据失败: ${error.message}`,
          account: account.mobile, 
          channelId: this.channelId,
          requestCount: requestIndex, 
          duration: Date.now() - startTime,
          requestType,
          requestId: currentRequestId
        });
      }
    });
  }

  getStatus() {
    return {
      id: this.channelId,
      connected: this.isConnected, 
      requestCount: this.requestCount,
      queueLength: this.pendingRequests.length,
      status: this.getStatusDescription()
    };
  }

  close() {
    // 🆕 停止心跳
    this.stopHeartbeat();
    
    this.clearPendingRequests('通道关闭');
    if (this.socket) { 
      try { this.socket.end(); } catch (e) {} 
      this.socket = null; 
    }
    this.rawTcpSocket = null;
    this.isConnected = false;
    this.requestCount = 0;
    this.dataListenerBound = false;
    this.isBusy = false;
    this.connectedAt = null;
    this.lastActiveAt = null;
    this.lastRequestStartTime = null;
    
    // 🆕 重置心跳相关状态
    this.heartbeatCount = 0;
    this.heartbeatSuccessCount = 0;
    this.lastHeartbeatTime = null;
    this.isHeartbeatPending = false;
    this._heartbeatReject = null;
    this._heartbeatTimeoutTimer = null;
    this._heartbeatOnData = null;
  }

  reset() {
    this.close();
    this.requestCount = 0;
    this.isConnecting = false;
    this.isStopped = false;
    this.isBusy = false;
    this.connectedAt = null;
    this.lastActiveAt = null;
    this.lastRequestStartTime = null;

    // 🆕 重置心跳相关状态
    this.heartbeatCount = 0;
    this.heartbeatSuccessCount = 0;
    this.lastHeartbeatTime = null;
    this.isHeartbeatPending = false;
  }

  // ==================== 心跳功能 ====================

  /**
   * 启动心跳定时器
   */
  startHeartbeat() {
    if (!this._ka().enabled) {
      return;
    }

    // 清理已有调度
    this.stopHeartbeat();

    // 注册到代理级调度器（幂等，重复注册无副作用）
    ProxyHeartbeatDispatcher.register(this);

    this.scheduleNextHeartbeat(this._pickHeartbeatDelay());
  }

  /**
   * 停止心跳定时器
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // 从代理级调度器注销
    ProxyHeartbeatDispatcher.unregister(this);
  }

  /**
   * 调度下一次心跳（delay 毫秒后触发）
   * 将心跳请求提交给代理级调度器，由调度器统一协调发出时机，
   * 避免同代理多通道同时发心跳（惊群效应）。
   */
  scheduleNextHeartbeat(delay) {
    // 清理旧定时器（理论上已无 timer，保留作兼容兜底）
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this._ka().enabled || !this.isConnected || this.isStopped) return;

    // 提交给代理级调度器（deadline = 当前时刻 + delay）
    const deadline = Date.now() + delay;
    ProxyHeartbeatDispatcher.enqueue(this, deadline);
  }

  /**
   * 检查并发送心跳
   * 只在通道空闲时发送；发送完成（或跳过）后自动调度下一次
   */
  async checkAndSendHeartbeat() {
    if (!this.isConnected || this.isStopped) {
      return;
    }

    // 通道正忙或有心跳待处理，稍后重试
    if (this.isBusy || this.isHeartbeatPending) {
      this.scheduleNextHeartbeat(1000);
      return;
    }

    await this.sendHeartbeat();

    if (this.isConnected && !this.isStopped) {
      // 每次心跳后重新抽 [min, max] 区间内的随机间隔；
      // 老云端 config 没有 min/max 字段时回退到旧的 interval（兼容）
      this.scheduleNextHeartbeat(this._pickHeartbeatDelay());
    }
  }

  /**
   * 抽下一次心跳的延迟（ms）。
   * 优先用 keepAlive.intervalMin / intervalMax 在 [min,max] 内均匀抽样；
   * 两个字段缺失时回退到旧字段 keepAlive.interval（保留兼容老云端 agent）。
   */
  _pickHeartbeatDelay() {
    const ka = this._ka();
    if (ka.intervalMin != null && ka.intervalMax != null) {
      return pickInterval(ka.intervalMin, ka.intervalMax);
    }
    return parseInt(ka.interval, 10) || 30000;
  }

  /**
   * 发送心跳请求
   */
  async sendHeartbeat() {
    const sendTime = Date.now();
    this.heartbeatCount++;
    this.lastHeartbeatTime = sendTime;
    this.isHeartbeatPending = true;
    
    const keepAliveConfig = this._ka();
    const timeout = this._hbTimeout();

    // 构建心跳请求
    const heartbeatRequest = this.buildHeartbeatRequest();
    
    // 心跳日志数据
    // heartbeat_type 直接写"实际发出去的是什么"：
    //   - 'head' 类型 → 'head'
    //   - 'systemConfig' 类型（模拟业务）→ 本次抽中的 recipe id（如 'yizhu4_carousel'）
    // 这样日志一栏即所见即所得，不再需要额外的 recipe_id 列对照。
    const configuredType = this._ka().request?.type || 'head';
    const loggedType = configuredType === 'systemConfig'
      ? (this._lastHeartbeatRecipeId || 'systemConfig')   // 极端兜底：recipe 没抽出来时退回旧值
      : 'head';
    const heartbeatLog = {
      channelId: this.channelId,
      proxyIp: this.proxyConfig.realProxyIp || this.proxyConfig.host,
      proxyPort: this.proxyConfig.port,
      targetHost: this.targetHost,
      targetPort: this.targetPort,
      startTime: sendTime,
      endTime: null,
      duration: 0,
      success: false,
      statusCode: null,
      errorMessage: null,
      responseHeaders: null,
      heartbeatType: loggedType,
    };
    
    try {
      // 使用 sendHeartbeatRequest 发送心跳（走独立的响应处理）
      const result = await this.sendHeartbeatRequest(heartbeatRequest, timeout);
      
      const receiveTime = Date.now();
      const duration = receiveTime - sendTime;
      
      // 更新日志
      heartbeatLog.endTime = receiveTime;
      heartbeatLog.duration = duration;
      heartbeatLog.success = true;
      heartbeatLog.statusCode = result.statusCode;
      heartbeatLog.responseHeaders = result.headers ? JSON.stringify(result.headers) : null;

      // 记录最后一次心跳成功时间（用于代理优先级评分）
      this.lastHeartbeatSuccessAt = receiveTime;
      this.heartbeatSuccessCount++;

      this.connectedAt = receiveTime;
      this.lastActiveAt = receiveTime;

      // 🆕 心跳成功恢复后，通知调度器（查票窗口期内可安排查票）
      if (this.onHeartbeatRecovered) {
        this.onHeartbeatRecovered(this);
      }

    } catch (error) {
      const receiveTime = Date.now();
      const duration = receiveTime - sendTime;

      // 更新日志
      heartbeatLog.endTime = receiveTime;
      heartbeatLog.duration = duration;
      heartbeatLog.success = false;
      heartbeatLog.errorMessage = error.message || String(error);

      // 心跳超时或失败，关闭通道
      this.close();
      
    } finally {
      this.isHeartbeatPending = false;
      
      // 保存心跳日志
      if (this.logDb) {
        try {
          await this.logDb.saveHeartbeatLog(heartbeatLog);
        } catch (e) {
          // 静默处理日志保存失败
        }
      }
    }
  }

  /**
   * 构建心跳 HTTP 请求（根据配置类型路由）
   * - 'head'         → 轻量 HEAD 请求
   * - 'systemConfig' → "模拟业务（随机抽端点）"：从 HeartbeatEndpointPool 抽 1 条
   *                    recipe 拼请求，每次心跳 path/body 都不同
   */
  buildHeartbeatRequest() {
    const heartbeatType = this._ka().request?.type || 'head';

    if (heartbeatType === 'systemConfig') {
      return this.buildBusinessHeartbeatRequest();
    }

    // 默认: HEAD 请求（没有 recipe 概念）
    this._lastHeartbeatRecipeId = null;
    const headers = [
      `HEAD / HTTP/1.1`,
      `Host: ${this.targetHost}`,
      'Connection: keep-alive',
      'User-Agent: Mozilla/5.0',
      '',
      ''
    ];
    return headers.join('\r\n');
  }

  /**
   * 获取或生成当前代理的 s456hr8 标识（每通道实例生成一次，固定不变）
   */
  getOrCreateS456hr8() {
    if (!this.s456hr8) {
      this.s456hr8 = crypto.randomBytes(16).toString('hex');
    }
    return this.s456hr8;
  }

  /**
   * 构建"模拟业务"心跳请求：从 HeartbeatEndpointPool 抽 1 条 recipe，按 recipe.path /
   * bodyTemplate / encrypted 组装。
   *
   * 头部顺序按 platform 走，和业务请求保持一致（避免心跳与业务的指纹不一致）：
   *   - android：s456hr8 first，user-agent 小写
   *   - wechat ：Host first，含 Referer
   *   - 默认（iOS）：Host first，User-Agent 大写
   *
   * UA / Referer 一律从 _accounts[0] 取（与上游业务请求统一），缺失时兜底 constants 默认。
   */
  buildBusinessHeartbeatRequest() {
    const recipe = pickRandomRecipe(this._ka().request?.enabledEndpoints);
    // 记录本次心跳实际抽中的 recipe id；sendHeartbeat 会把它作为 heartbeat_type 落入
    // heartbeat_logs，让日志一行即所见即所得（不再有"类型 vs 端点"两列对照）。
    this._lastHeartbeatRecipeId = recipe.id;

    const s456hr8 = this.getOrCreateS456hr8();
    const host    = this.sni || this.targetHost;

    const acc      = (this.config._accounts && this.config._accounts[0]) || {};
    const platform = acc.platform || this.config.account?.platform || 'ios';
    const ua       = acc.user_agent || _DEFAULT_HEARTBEAT_UA(platform);
    const referer  = platform === 'wechat' ? (acc.referer || '') : null;

    const body          = recipe.encrypted ? this.cryptoUtils.encryptData(recipe.bodyTemplate) : recipe.bodyTemplate;
    const contentLength = Buffer.byteLength(body, 'utf8');

    let headers;
    if (platform === 'android') {
      headers = [
        `${recipe.method} ${recipe.path} HTTP/1.1`,
        `s456hr8: ${s456hr8}`,
        `SubmitSign: `,
        `hospitalId: ${recipe.hospitalIdHdr}`,
        `from: 0`,
        `user-agent: ${ua}`,
        `Content-Type: ${recipe.contentType}`,
        `Content-Length: ${contentLength}`,
        `Host: ${host}`,
        `Connection: Keep-Alive`,
        `Accept-Encoding: gzip`,
        ``,
        body,
      ];
    } else if (platform === 'wechat') {
      headers = [
        `${recipe.method} ${recipe.path} HTTP/1.1`,
        `Host: ${host}`,
        `Connection: keep-alive`,
        `Content-Length: ${contentLength}`,
        `hospitalId: ${recipe.hospitalIdHdr}`,
        `s456hr8: ${s456hr8}`,
        `content-type: ${recipe.contentType}`,
        `SubmitSign: `,
        `token: `,
        `from: 8`,
        `Accept-Encoding: gzip,compress,br,deflate`,
        `User-Agent: ${ua}`,
        `Referer: ${referer}`,
        ``,
        body,
      ];
    } else {
      // 默认 iOS App
      headers = [
        `${recipe.method} ${recipe.path} HTTP/1.1`,
        `Host: ${host}`,
        `Accept: */*`,
        `from: 0`,
        `hospitalId: ${recipe.hospitalIdHdr}`,
        `Accept-Language: zh-CN,zh-Hans;q=0.9`,
        `Accept-Encoding: gzip, deflate, br`,
        `s456hr8: ${s456hr8}`,
        `Content-Type: ${recipe.contentType}`,
        `Content-Length: ${contentLength}`,
        `User-Agent: ${ua}`,
        `Connection: keep-alive`,
        `SubmitSign: `,
        ``,
        body,
      ];
    }
    return headers.join('\r\n');
  }

  /**
   * 发送心跳请求并等待响应
   * 心跳使用独立的响应处理，不进入业务请求队列
   * 因为心跳只在通道空闲时发送，不会与业务请求冲突
   */
  sendHeartbeatRequest(requestData, timeout) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        reject(new Error('通道未连接'));
        return;
      }

      // 🆕 提前捕获 socket 引用：防止 close() 后 this.socket 置 null，
      //     导致 onData / timeout 回调执行 removeListener 时报 TypeError
      const tlsSocket = this.socket;

      // 标记通道为忙碌（心跳期间不接受业务请求）
      this.isBusy = true;

      // 🆕 存储 reject 引用，供 _cancelPendingHeartbeat 提前终止使用
      this._heartbeatReject = reject;

      let timeoutTimer = null;
      let responseBuffer = Buffer.from('');
      let resolved = false;

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        // 解除忙碌状态
        this.isBusy = false;
        // 🆕 清理取消引用
        this._heartbeatReject = null;
        this._heartbeatTimeoutTimer = null;
        this._heartbeatOnData = null;
      };

      const onData = (data) => {
        if (resolved) return;

        responseBuffer = Buffer.concat([responseBuffer, data]);

        // 检查响应头是否完整
        const headerEndIndex = responseBuffer.indexOf('\r\n\r\n');
        if (headerEndIndex !== -1) {
          resolved = true;

          // 解析状态码
          const headersText = responseBuffer.subarray(0, headerEndIndex).toString();
          const statusMatch = headersText.match(/HTTP\/\d\.\d\s+(\d+)/);
          const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;

          // 解析响应头为对象（key 统一小写）
          const headerLines = headersText.split('\r\n');
          const headers = {};
          for (let i = 1; i < headerLines.length; i++) {
            const colonIdx = headerLines[i].indexOf(':');
            if (colonIdx > 0) {
              const key = headerLines[i].substring(0, colonIdx).trim().toLowerCase();
              const val = headerLines[i].substring(colonIdx + 1).trim();
              headers[key] = val;
            }
          }

          // 移除临时监听器（用捕获的 tlsSocket，而非 this.socket）
          tlsSocket.removeListener('data', onData);

          cleanup();
          resolve({ statusCode, headers, data: responseBuffer.toString() });
        }
      };

      // 设置超时
      timeoutTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;

        // 移除临时监听器（用捕获的 tlsSocket）
        tlsSocket.removeListener('data', onData);

        cleanup();
        reject(new Error(`心跳超时(${timeout}ms)`));
      }, timeout);

      // 临时添加数据监听器用于心跳响应（用捕获的 tlsSocket）
      // 🆕 存储引用，供 _cancelPendingHeartbeat 清理使用
      this._heartbeatTimeoutTimer = timeoutTimer;
      this._heartbeatOnData = onData;
      tlsSocket.on('data', onData);

      // 发送请求
      try {
        tlsSocket.write(requestData);
      } catch (error) {
        resolved = true;
        tlsSocket.removeListener('data', onData);
        cleanup();
        reject(error);
      }
    });
  }
}

module.exports = ConnectionChannel;
