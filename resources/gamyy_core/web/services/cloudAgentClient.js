'use strict';

const http = require('http');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ── 直连默认 HTTP Agent ────────────────────────────────────────────────────
// keepAlive 让 probe/startTask/轮询 复用 TCP 连接;
// maxSockets=3 限制单云端 host 并发,批量启动也不会打爆单台云端的 socket 队列。
const httpAgent = new http.Agent({
  keepAlive:       true,
  maxSockets:      3,
  maxFreeSockets:  2,
  keepAliveMsecs:  30_000,
});

// ── 走代理时 per-(host:port:user:pwd) 缓存 SocksProxyAgent ─────────────────
// 同一物理代理被多任务复用,共享 keepAlive 长连接池;maxSockets=30 防止
// 2000 任务的轮询打爆单个代理。开关关闭时该 cache 不会被填充。
const proxyAgentCache = new Map();

function getProxyAgent(proxyInfo) {
  if (!proxyInfo || !proxyInfo.host || !proxyInfo.port) return null;
  const u = proxyInfo.username || '';
  const p = proxyInfo.password || '';
  const key = `${proxyInfo.host}:${proxyInfo.port}:${u}:${p}`;
  if (proxyAgentCache.has(key)) return proxyAgentCache.get(key);
  const auth = u ? `${encodeURIComponent(u)}:${encodeURIComponent(p)}@` : '';
  const url = `socks5://${auth}${proxyInfo.host}:${proxyInfo.port}`;
  const agent = new SocksProxyAgent(url, {
    keepAlive:      true,
    maxSockets:     30,
    maxFreeSockets: 5,
    keepAliveMsecs: 30_000,
  });
  proxyAgentCache.set(key, agent);
  return agent;
}

// ── 超时表 ────────────────────────────────────────────────────────────────
// 走代理路径延迟与抖动更高,统一保守加大。caller 通过 opts.agent 决定。
const TIMEOUTS = {
  direct: {
    startTask:    60_000,
    stopTask:     10_000,
    checkHealth:   8_000,
    getStatus:     8_000,
    getStats:      8_000,
    probe:         3_000,
  },
  proxy: {
    startTask:   120_000,
    stopTask:     30_000,
    checkHealth:  20_000,
    getStatus:    20_000,
    getStats:     20_000,
    probe:         8_000,
  },
};
function _t(opts, key) {
  return TIMEOUTS[opts && opts.agent ? 'proxy' : 'direct'][key];
}

function request(url, method, body, timeoutMs, agent) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`无效的 Agent URL: ${url}`)); }

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port:     Number(parsed.port) || 80,
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { 'Content-Type': 'application/json' },
      timeout:  timeoutMs,
      agent:    agent || httpAgent,
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data: null }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('云端 Agent 请求超时')); });

    if (payload) req.write(payload);
    req.end();
  });
}

async function checkHealth(agentUrl, opts = {}) {
  const { status, data } = await request(`${agentUrl}/health`, 'GET', null, _t(opts, 'checkHealth'), opts.agent);
  if (status !== 200) throw new Error(`云端 Agent 健康检查失败: HTTP ${status}`);
  return data;
}

async function startTask(agentUrl, config, opts = {}) {
  const { status, data } = await request(`${agentUrl}/run`, 'POST', config, _t(opts, 'startTask'), opts.agent);
  if (status !== 200) throw new Error(`云端 Agent 启动任务失败: ${data?.error || `HTTP ${status}`}`);
  return data;
}

async function getTaskStatus(agentUrl, taskId, opts = {}) {
  const { status, data } = await request(`${agentUrl}/status/${taskId}`, 'GET', null, _t(opts, 'getStatus'), opts.agent);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`获取云端任务状态失败: HTTP ${status}`);
  return data;
}

async function stopTask(agentUrl, taskId, opts = {}) {
  const { status, data } = await request(`${agentUrl}/stop/${taskId}`, 'POST', null, _t(opts, 'stopTask'), opts.agent);
  if (status !== 200 && status !== 404) throw new Error(`停止云端任务失败: ${data?.error || `HTTP ${status}`}`);
  return data;
}

async function getTaskStats(agentUrl, taskId, opts = {}) {
  const { status, data } = await request(`${agentUrl}/stats/${taskId}`, 'GET', null, _t(opts, 'getStats'), opts.agent);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`获取云端任务统计失败: HTTP ${status}`);
  return data;
}

// 快速探活:返回 true/false,不抛错。timeoutMs 显式传 > opts 推导 > 默认表
async function probeAgent(agentUrl, timeoutMs, opts = {}) {
  const t = timeoutMs ?? _t(opts, 'probe');
  try {
    const { status } = await request(`${agentUrl}/health`, 'GET', null, t, opts && opts.agent);
    return status === 200;
  } catch (_) {
    return false;
  }
}

module.exports = { checkHealth, startTask, getTaskStatus, stopTask, probeAgent, getTaskStats, getProxyAgent };
