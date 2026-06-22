// agent/server.js - 云端 Agent 入口
// 只负责接收本机推送的任务配置并驱动查号锁号模块执行，不包含任何 Web 管理功能

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  if (typeof warning === 'string' &&
      (warning.includes('NODE_TLS_REJECT_UNAUTHORIZED') ||
       warning.includes('TLS ServerName to an IP address'))) return;
  return originalEmitWarning.call(process, warning, ...args);
};

const http = require('http');
const fs   = require('fs');
const path = require('path');
const SchedulerService = require('../services/SchedulerService');

const PORT = process.env.AGENT_PORT || 7070;

// 确保 data/ 目录存在（LogDatabase 写入日志文件时需要）
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ─── 任务注册表 ───────────────────────────────────────────────────────────────
// taskId -> { taskId, status, startedAt, endedAt, stopReason }
const taskRegistry = new Map();

// taskId -> SchedulerService（用于手动停止）
const schedulers = new Map();

// ─── HTTP 服务 ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://localhost`);
  const pathname = urlObj.pathname;

  // GET /health
  if (req.method === 'GET' && pathname === '/health') {
    const running = [...taskRegistry.values()].filter(t => t.status === 'running').length;
    return reply(res, 200, {
      status:       'ok',
      uptime:       Math.floor(process.uptime()),
      runningTasks: running,
    });
  }

  // GET /status/:taskId
  const statusMatch = pathname.match(/^\/status\/(\d+)$/);
  if (req.method === 'GET' && statusMatch) {
    const record = taskRegistry.get(Number(statusMatch[1]));
    return record
      ? reply(res, 200, record)
      : reply(res, 404, { error: 'task not found' });
  }

  // POST /run
  if (req.method === 'POST' && pathname === '/run') {
    return readBody(req, res, (config) => {
      const taskId = config.taskId ?? Date.now();

      if (taskRegistry.get(taskId)?.status === 'running') {
        return reply(res, 409, { error: 'task already running', taskId });
      }

      const record = {
        taskId,
        status:     'running',
        startedAt:  new Date().toISOString(),
        endedAt:    null,
        stopReason: null,
      };
      taskRegistry.set(taskId, record);

      // 立即响应，任务异步执行
      reply(res, 200, { accepted: true, taskId });
      runTask(taskId, config, record);
    });
  }

  // GET /stats/:taskId — 返回代理实时统计，供本地端 10 秒轮询
  const statsMatch = pathname.match(/^\/stats\/(\d+)$/);
  if (req.method === 'GET' && statsMatch) {
    const taskId = Number(statsMatch[1]);
    const scheduler = schedulers.get(taskId);
    if (!scheduler) return reply(res, 404, { error: 'task not found or not running' });
    try {
      return reply(res, 200, scheduler.getProxyStats());
    } catch (e) {
      return reply(res, 500, { error: e.message });
    }
  }

  // POST /stop/:taskId
  const stopMatch = pathname.match(/^\/stop\/(\d+)$/);
  if (req.method === 'POST' && stopMatch) {
    const taskId = Number(stopMatch[1]);
    const record = taskRegistry.get(taskId);
    if (!record || record.status !== 'running') {
      return reply(res, 404, { error: 'no running task with that id' });
    }
    const scheduler = schedulers.get(taskId);
    if (scheduler) {
      scheduler.stopScheduledCheck();
      scheduler.cleanup().catch(() => {});
    }
    record.status     = 'stopped';
    record.endedAt    = new Date().toISOString();
    record.stopReason = 'manual_stop';
    schedulers.delete(taskId);
    return reply(res, 200, { stopped: true, taskId });
  }

  reply(res, 404, { error: 'not found' });
});

// ─── 任务执行 ─────────────────────────────────────────────────────────────────
async function runTask(taskId, config, record) {
  const scheduler = new SchedulerService(config);
  schedulers.set(taskId, scheduler);

  scheduler.setOnAutoStop((reason) => {
    record.status     = 'completed';
    record.endedAt    = new Date().toISOString();
    record.stopReason = reason;
    schedulers.delete(taskId);
    scheduler.cleanup().catch(() => {});
    console.log(`[Task ${taskId}] 结束: ${reason}`);
  });

  try {
    const initResult = await scheduler.initialize();
    console.log(`[Task ${taskId}] 初始化完成: ${initResult.accounts} 个账号，${initResult.proxies} 个代理`);
    await scheduler.startScheduledCheck();
    // startScheduledCheck 设置定时器后即返回，任务在后台运行直到 onAutoStop 触发
  } catch (e) {
    record.status     = 'failed';
    record.endedAt    = new Date().toISOString();
    record.stopReason = e.message;
    schedulers.delete(taskId);
    console.error(`[Task ${taskId}] 启动失败: ${e.message}`);
    scheduler.cleanup().catch(() => {});
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, res, cb) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      cb(JSON.parse(body));
    } catch (e) {
      reply(res, 400, { error: 'invalid JSON body' });
    }
  });
  req.on('error', () => reply(res, 400, { error: 'request error' }));
}

// ─── 优雅退出 ─────────────────────────────────────────────────────────────────
function shutdown() {
  console.log('\n正在关闭 Agent...');
  server.close();
  for (const [taskId, scheduler] of schedulers) {
    console.log(`  停止任务 ${taskId}...`);
    scheduler.stopScheduledCheck();
    scheduler.cleanup().catch(() => {});
  }
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ─── 启动 ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Gamyy Cloud Agent 已启动，监听端口 ${PORT}`);
  console.log(`   健康检查: GET  http://0.0.0.0:${PORT}/health`);
  console.log(`   启动任务: POST http://0.0.0.0:${PORT}/run`);
  console.log(`   任务状态: GET  http://0.0.0.0:${PORT}/status/:taskId`);
  console.log(`   停止任务: POST http://0.0.0.0:${PORT}/stop/:taskId`);
});
