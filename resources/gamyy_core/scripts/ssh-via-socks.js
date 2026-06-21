#!/usr/bin/env node
// SSH ProxyCommand 脚本：通过本地 SOCKS5 代理建立 TCP 连接，供 ssh/scp 使用
// 用法（由 SSH 自动调用）：node ssh-via-socks.js <host> <port>

'use strict';
const { SocksClient } = require('socks');

const host       = process.argv[2];
const port       = parseInt(process.argv[3], 10);
const proxyHost  = '127.0.0.1';
const proxyPort  = parseInt(process.env.SOCKS_PORT || '5002', 10);

if (!host || !port) {
  process.stderr.write('用法: node ssh-via-socks.js <host> <port>\n');
  process.exit(1);
}

SocksClient.createConnection({
  proxy:       { host: proxyHost, port: proxyPort, type: 5 },
  command:     'connect',
  destination: { host, port },
}, (err, info) => {
  if (err) {
    process.stderr.write(`SOCKS5 连接失败 (${proxyHost}:${proxyPort} → ${host}:${port}): ${err.message}\n`);
    process.exit(1);
  }
  const socket = info.socket;
  socket.on('error', () => process.exit(1));
  socket.on('close', () => process.exit(0));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
