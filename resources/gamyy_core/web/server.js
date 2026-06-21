'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

const { getDb, closeDb } = require('./db/configDb');
const { TaskRunner } = require('./services/TaskRunner');
const { setupWebSocket } = require('./ws/wsServer');

// 路由
const systemConfigRouter = require('./routes/systemConfig');
const tasksRouter = require('./routes/tasks');
const accountsRouter = require('./routes/accounts');
const accountOperationsRouter = require('./routes/accountOperations');
const proxyTemplatesRouter = require('./routes/proxyTemplates');
const proxiesRouter        = require('./routes/proxies');
const fingerprintsRouter   = require('./routes/fingerprints');
const proxyPoolRouter      = require('./routes/proxyPool');
const taskControlRouter = require('./routes/taskControl');
const logsRouter = require('./routes/logs');
const referenceRouter = require('./routes/reference');
const registerRouter  = require('./routes/register');

const PORT = process.env.PORT || 3000;

// 全局单例
const taskRunner = new TaskRunner();
let _broadcast = () => {};  // 启动后由 setupWebSocket 填充

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use((req, _res, next) => {
    req.taskRunner = taskRunner;
    req.broadcast  = _broadcast;
    next();
  });

  // API 路由
  app.use('/api/system-config',   systemConfigRouter);
  app.use('/api/accounts',        accountsRouter);
  app.use('/api/accounts',        accountOperationsRouter);
  app.use('/api/tasks',           tasksRouter);
  app.use('/api/proxy-templates', proxyTemplatesRouter);
  app.use('/api/proxies',         proxiesRouter);
  app.use('/api/fingerprints',    fingerprintsRouter);
  app.use('/api/proxy-pool',      proxyPoolRouter);
  app.use('/api/tasks',           taskControlRouter); // /api/tasks/:id/start|stop|status
  app.use('/api/logs',            logsRouter);
  app.use('/api/register',        registerRouter);
  app.use('/api',                 referenceRouter);

  // 前端静态文件（Phase 6 构建后放到 web/public）
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'), err => {
      if (err) res.status(404).json({ error: 'Frontend not built yet' });
    });
  });

  return app;
}

function start() {
  // 确保数据库初始化
  getDb();

  const app = createApp();
  const server = http.createServer(app);

  // 追踪所有打开的 socket（HTTP + WebSocket），关闭时主动销毁
  const openSockets = new Set();
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });

  // WebSocket
  const ws = setupWebSocket(server, taskRunner);
  _broadcast = ws.broadcast;

  server.listen(PORT, () => {
    console.log(`✅ Web GUI 服务已启动: http://localhost:${PORT}`);
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n正在关闭服务...');

    // 3 秒后强制退出，防止连接挂起
    const forceTimer = setTimeout(() => {
      console.log('强制退出');
      process.exit(0);
    }, 3000);
    forceTimer.unref();

    try {
      await taskRunner.stopAll();
    } catch (_) {}

    closeDb();

    // 销毁所有现有连接（WebSocket / keep-alive），让 server.close() 立即回调
    for (const socket of openSockets) socket.destroy();

    server.close(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
