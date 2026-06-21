// services/ProxyHeartbeatDispatcher.js
// 代理级心跳调度器：解决"惊群效应"，让同一代理的所有通道心跳均匀分布
// 调度策略：deadline 最早的通道优先，同代理内相邻心跳保持最小间隔（dispatch.minSpacing）

// ========== 单代理调度队列 ==========

class ProxyDispatchQueue {
  constructor(proxyKey) {
    this.proxyKey = proxyKey;
    this.registeredChannels = new Set();
    this.queue = [];
    this.timer = null;
  }

  get totalActive() {
    return this.registeredChannels.size;
  }

  // ---- 通道生命周期管理 ----

  /** 通道启动心跳时注册（幂等，重复注册无副作用） */
  register(channel) {
    this.registeredChannels.add(channel);
  }

  /** 通道关闭或停止时注销，从调度队列中移除 */
  unregister(channel) {
    this.registeredChannels.delete(channel);
    this._dequeueChannel(channel);
    this._reschedule();
  }

  // ---- 心跳调度 ----

  /**
   * 通道请求在 deadline 时刻发送心跳（重新入队）
   * @param {ConnectionChannel} channel
   * @param {number} deadline - 期望发出心跳的时间戳（ms）
   */
  enqueue(channel, deadline) {
    // 先移除旧的排队记录（同一通道重复入队时更新 deadline）
    this._dequeueChannel(channel);

    // 通道已关闭或未注册，不入队
    if (!channel.isConnected || channel.isStopped) return;
    if (!this.registeredChannels.has(channel)) return;

    this.queue.push({ channel, deadline });
    // 按 deadline 升序，最紧迫的排最前面
    this.queue.sort((a, b) => a.deadline - b.deadline);

    this._reschedule();
  }

  // ---- 内部方法 ----

  _dequeueChannel(channel) {
    const idx = this.queue.findIndex(e => e.channel === channel);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  _reschedule() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) return;

    const delay = Math.max(0, this.queue[0].deadline - Date.now());

    this.timer = setTimeout(() => {
      this.timer = null;
      this._dispatch();
    }, delay);
  }

  _dispatch() {
    const now = Date.now();

    // 清理已断开的通道（channel 关闭但未及时 unregister 的兜底处理）
    this.queue = this.queue.filter(e => e.channel.isConnected && !e.channel.isStopped);

    if (this.queue.length === 0) return;

    // 取最紧迫的通道
    const entry = this.queue.shift();

    // 异步触发心跳，不阻塞调度循环
    // channel 完成心跳后会调用 scheduleNextHeartbeat → enqueue，重新进入队列
    entry.channel.checkAndSendHeartbeat();

    // 调度下一个
    this._reschedule();
  }

  destroy() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.registeredChannels.clear();
    this.queue = [];
  }
}

// ========== 单例管理 ==========

const dispatchers = new Map(); // proxyKey → ProxyDispatchQueue

function _getProxyKey(channel) {
  return channel.proxyConfig.realProxyIp
    || `${channel.proxyConfig.host}:${channel.proxyConfig.port}`;
}

function _getOrCreate(proxyKey) {
  if (!dispatchers.has(proxyKey)) {
    dispatchers.set(proxyKey, new ProxyDispatchQueue(proxyKey));
  }
  return dispatchers.get(proxyKey);
}

/** 通道启动心跳时调用，注册到本代理的调度队列（幂等） */
function register(channel) {
  _getOrCreate(_getProxyKey(channel)).register(channel);
}

/** 通道关闭或停止时调用，从调度队列注销 */
function unregister(channel) {
  const proxyKey = _getProxyKey(channel);
  const d = dispatchers.get(proxyKey);
  if (d) d.unregister(channel);
}

/**
 * 通道请求在 deadline 时刻发送心跳
 * 由 scheduleNextHeartbeat(delay) 调用：deadline = Date.now() + delay
 */
function enqueue(channel, deadline) {
  _getOrCreate(_getProxyKey(channel)).enqueue(channel, deadline);
}

/** 程序退出时清理所有调度器（可选） */
function clearAll() {
  dispatchers.forEach(d => d.destroy());
  dispatchers.clear();
}

module.exports = { register, unregister, enqueue, clearAll };
