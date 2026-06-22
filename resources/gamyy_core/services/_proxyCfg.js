'use strict';

// 严格 per-proxy：所有调度配置都从 proxyConfig.cfg 取，task 顶层不再有 checkRequest/lockRequest/channelBuildPhase1 等字段。
// 第一个参数 _taskConfig 保留只是为了不破坏旧调用方的签名（一些点已经习惯传两个参数）。

function pickCfg(_taskConfig, proxyConfig) {
  return (proxyConfig && proxyConfig.cfg) || {};
}

function checkReq(_taskConfig, proxyConfig) {
  return pickCfg(_taskConfig, proxyConfig).checkRequest || {};
}

function lockGlobal(_taskConfig, proxyConfig) {
  const cfg = pickCfg(_taskConfig, proxyConfig);
  return (cfg.lockRequest && cfg.lockRequest.global) || {};
}

function channelPhase1(_taskConfig, proxyConfig) {
  return pickCfg(_taskConfig, proxyConfig).channelBuildPhase1 || {};
}

module.exports = { pickCfg, checkReq, lockGlobal, channelPhase1 };
