'use strict';

// HH:MM:SS or HH:MM:SS.mmm
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?$/;
// YYYY-MM-DD or YYYY-MM-DD HH:MM or YYYY-MM-DD HH:MM:SS
const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

function isTimeString(v) {
  if (v === null || v === undefined || v === '') return true;
  return TIME_RE.test(v);
}

function isNonNegInt(v) {
  if (v === null || v === undefined) return true;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0;
}

function isPositiveInt(v) {
  if (v === null || v === undefined) return true;
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

function isPort(v) {
  if (v === null || v === undefined) return true;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function isDatetime(v) {
  if (v === null || v === undefined || v === '') return true;
  return DATE_RE.test(v);
}

// Validates channel build overrides / channelBuildPhase1 object.
// Returns an error string, or null if valid.
function validateChannelOverrides(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.startTime != null && obj.startTime !== '' && !isTimeString(obj.startTime))
    return 'startTime 格式不正确，应为 HH:MM:SS';
  if (obj.windowTime != null && !isNonNegInt(obj.windowTime))
    return 'windowTime 应为非负整数（毫秒）';
  if (obj.attempts != null && !isPositiveInt(obj.attempts))
    return 'attempts 应为正整数';
  if (obj.distribution != null && !['uniform', 'random'].includes(obj.distribution))
    return 'distribution 应为 uniform 或 random';
  if (obj.earlyStop != null) {
    const es = obj.earlyStop;
    if (typeof es !== 'object') return 'earlyStop 应为对象';
    if (es.algorithm != null && !['fixed', 'dynamic'].includes(es.algorithm))
      return 'earlyStop.algorithm 应为 fixed 或 dynamic';
    if (es.fixedThreshold != null && !isPositiveInt(es.fixedThreshold))
      return 'earlyStop.fixedThreshold 应为正整数（毫秒）';
    if (es.multiplier != null && (typeof es.multiplier !== 'number' || es.multiplier <= 0))
      return 'earlyStop.multiplier 应为正数';
  }
  if (obj.autoCloseExcess != null) {
    const ace = obj.autoCloseExcess;
    if (typeof ace !== 'object') return 'autoCloseExcess 应为对象';
    if (ace.maxSuccessChannels != null && ace.maxSuccessChannels !== 'auto' && !isPositiveInt(ace.maxSuccessChannels))
      return 'autoCloseExcess.maxSuccessChannels 应为正整数或 auto';
    if (ace.monitorInterval != null && !isNonNegInt(ace.monitorInterval))
      return 'autoCloseExcess.monitorInterval 应为非负整数（毫秒）';
  }
  if (obj.maxSuccessChannels != null && !isNonNegInt(obj.maxSuccessChannels))
    return 'maxSuccessChannels 应为非负整数（0 表示不限）';
  if (obj.targetHosts != null) {
    const thErr = validateTargetHosts(obj.targetHosts);
    if (thErr) return thErr;
  }
  return null;
}

// 校验心跳间隔区间 [min,max]（任一为 null/undefined 视为不改，合法）。
// 返回错误字符串，或 null 表示合法。
function validateKeepaliveInterval(min, max) {
  if (min == null && max == null) return null;
  if (min != null) {
    const n = parseInt(min, 10);
    if (!Number.isInteger(n) || n < 1000) return '心跳间隔下界应为 ≥1000 的整数（ms）';
  }
  if (max != null) {
    const n = parseInt(max, 10);
    if (!Number.isInteger(n) || n < 1000) return '心跳间隔上界应为 ≥1000 的整数（ms）';
  }
  if (min != null && max != null && parseInt(min, 10) > parseInt(max, 10))
    return '心跳间隔下界不能大于上界';
  return null;
}

// 校验启用的心跳业务 endpoint id 列表（null/undefined = 不改，合法）。
// allowedIds 由调用方传入（来自 HeartbeatEndpointPool.ALL_IDS）。返回错误字符串或 null。
function validateHeartbeatEndpoints(ids, allowedIds) {
  if (ids == null) return null;
  if (!Array.isArray(ids)) return 'keepalive_business_endpoints 应为数组';
  const allowed = new Set(allowedIds || []);
  for (const id of ids) {
    if (typeof id !== 'string' || !allowed.has(id)) return `未知 endpoint id: ${id}`;
  }
  return null;
}

// Validates a target_hosts array (null/undefined = inherit, treated as valid).
// Returns an error string, or null if valid.
function validateTargetHosts(arr) {
  if (arr === null || arr === undefined) return null;
  if (!Array.isArray(arr)) return 'target_hosts 应为数组';
  for (let i = 0; i < arr.length; i++) {
    const h = arr[i];
    if (!h.host || typeof h.host !== 'string' || !h.host.trim())
      return `目标主机第 ${i + 1} 行 host 不能为空`;
    if (!isPort(h.port))
      return `目标主机第 ${i + 1} 行 port 应为 1-65535 的整数`;
  }
  return null;
}

module.exports = { isTimeString, isNonNegInt, isPositiveInt, isPort, isDatetime, validateChannelOverrides, validateTargetHosts, validateKeepaliveInterval, validateHeartbeatEndpoints };
