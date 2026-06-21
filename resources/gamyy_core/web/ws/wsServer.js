'use strict';

const { WebSocketServer } = require('ws');

function setupWebSocket(httpServer, taskRunner) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // clientId -> { ws, subscriptions: Set }
  const clients = new Map();
  let nextId = 1;

  wss.on('connection', (ws) => {
    const clientId = nextId++;
    clients.set(clientId, { ws, subscriptions: new Set() });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      const client = clients.get(clientId);
      if (!client) return;

      if (msg.action === 'subscribe') {
        client.subscriptions.add(msg.channel + (msg.taskId ? `:${msg.taskId}` : ''));
      } else if (msg.action === 'unsubscribe') {
        client.subscriptions.delete(msg.channel + (msg.taskId ? `:${msg.taskId}` : ''));
      }
    });

    ws.on('close', () => clients.delete(clientId));
  });

  // 转发 TaskRunner 事件到订阅客户端
  //
  // statusChange 使用批量去重推送：
  // 同一任务在同一个事件循环 tick 内发出多次状态变化（如 INITIALIZING→RUNNING）
  // 只保留最后一次，通过 setImmediate 延迟到当前 tick 全部执行完再统一推送。
  // 1000 个任务同时启动时可将 WS 消息数从 2000+ 次/tick 降低到 ≤1000 次。
  const pendingChanges = new Map(); // taskId -> latestData
  let flushScheduled = false;

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      for (const [, data] of pendingChanges) {
        broadcast(clients, `task-status:${data.taskId}`, data);
        broadcast(clients, 'all-tasks', data);
      }
      pendingChanges.clear();
    });
  };

  taskRunner.on('statusChange', (data) => {
    pendingChanges.set(data.taskId, data);
    scheduleFlush();
  });

  taskRunner.on('taskStopped', (data) => {
    // taskStopped 不走批量，立即推送确保前端及时感知任务结束
    broadcast(clients, `task-status:${data.taskId}`, { ...data, status: 'idle' });
    broadcast(clients, 'all-tasks', { ...data, status: 'idle' });
  });

  return {
    broadcast: (channel, data) => broadcast(clients, channel, data),
  };
}

function broadcast(clients, channel, data) {
  const payload = JSON.stringify({ channel, data });
  for (const [, client] of clients) {
    if (client.subscriptions.has(channel) && client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}

module.exports = { setupWebSocket };
