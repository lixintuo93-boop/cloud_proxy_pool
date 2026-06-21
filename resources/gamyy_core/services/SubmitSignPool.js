// services/SubmitSignPool.js - SubmitSign 池管理
// 每个 SubmitSign 记录包含完整元数据，用于智能选择和消耗追踪

const { v4: uuidv4 } = require('uuid');

// SubmitSign 有效期（服务器侧约10分钟）
const SUBMIT_SIGN_TTL_MS = 10 * 60 * 1000;

class SubmitSignPool {
  constructor() {
    /** @type {Map<string, SubmitSignRecord>} id -> record */
    this._pool = new Map();
  }

  /**
   * 添加一条 SubmitSign 记录
   * @param {object} opts
   * @param {string}      opts.submitSign        SubmitSign 值
   * @param {string}      opts.cookie            配对的 Cookie（App端）
   * @param {string}      opts.accountId         账号 ID（account_id）
   * @param {string}      opts.proxyIp           请求所用代理的真实 IP
   * @param {string}      opts.channelId         请求所用通道 ID
   * @param {string}      opts.targetServerIp    目标服务器 IP（如 "123.114.40.188"）
   * @param {string|null} opts.serverTime        服务器响应 Date 头（原始字符串）
   * @param {'doctor'|'dept'} opts.queryMode          查号模式
   * @param {string}      opts.queryDateStart          查号请求开始日期（'YYYY-MM-DD'）
   * @param {string|null} opts.queryDateEnd            查号请求结束日期（dept 模式，'YYYY-MM-DD'）
   * @param {string|null} opts.responseMaxSlotDate     该 SubmitSign 可锁号源日期上限（从响应体或查询参数推断）
   * @param {string}      [opts.slotDate]              查到号时选中的号源日期（元数据，不参与筛选）
   * @returns {string} 记录 ID
   */
  add(opts) {
    const {
      submitSign,
      cookie = '',
      accountId,
      proxyIp,
      channelId,
      targetServerIp,
      serverTime = null,
      queryMode,
      queryDateStart,
      queryDateEnd = null,
      responseMaxSlotDate = null,
      slotDate = '',
    } = opts;

    if (!submitSign) return null;

    // 若同一 submitSign 值已存在（同值去重），直接返回已有记录 ID
    for (const [id, rec] of this._pool) {
      if (rec.submitSign === submitSign && rec.accountId === accountId) {
        return id;
      }
    }

    const id = uuidv4();
    const now = Date.now();

    /** @type {SubmitSignRecord} */
    const record = {
      id,
      submitSign,
      cookie,
      accountId,
      acquiredAt: now,
      proxyIp,
      channelId,
      targetServerIp,
      serverTime,
      queryMode,
      queryDateStart,
      queryDateEnd,
      responseMaxSlotDate,
      slotDate,
      consumed: false,
      consumedAt: null,
      consumedReason: null,   // 'lock_success' | 'changed_error' | 'unknown'
      usedCount: 0,
      firstUsedAt: null,
      lastUsedAt: null,
    };

    this._pool.set(id, record);
    return id;
  }

  /**
   * 更新某条记录的 slotDate（查到有票后补充，仅作元数据记录，不参与筛选）
   */
  updateSlotDate(id, slotDate) {
    const rec = this._pool.get(id);
    if (rec && slotDate) rec.slotDate = slotDate;
  }

  /**
   * 按 submitSign 值查找记录（用于 'first' 策略时根据值反查）
   * @param {string} submitSign
   * @returns {SubmitSignRecord|null}
   */
  findByValue(submitSign) {
    if (!submitSign) return null;
    for (const rec of this._pool.values()) {
      if (rec.submitSign === submitSign && !rec.consumed) {
        return rec;
      }
    }
    return null;
  }

  /**
   * 选出最适合锁号的 SubmitSign
   * 筛选条件：
   *   1. accountId 匹配
   *   2. 未被消耗
   *   3. 未过期（acquiredAt 距现在 < 10 分钟）
   *   4. responseMaxSlotDate >= lockPlanDate（该 SubmitSign 生成时服务器已存在目标日期号源）
   *   5. 若 proxyIp 非空，则只选该代理采集的 SubmitSign（per-proxy 隔离）
   *
   * 排序优先级：acquiredAt 越新越优先
   *
   * @param {string} accountId
   * @param {string} lockPlanDate  目标日期 'YYYY-MM-DD'
   * @param {'doctor'|'dept'} queryMode
   * @param {string|null} [proxyIp]  若传入，则只返回该代理采集的记录（用于 per-proxy 隔离）
   * @returns {SubmitSignRecord|null}
   */
  select(accountId, lockPlanDate, queryMode, proxyIp = null) {
    const now = Date.now();
    const candidates = [];

    for (const rec of this._pool.values()) {
      if (rec.accountId !== accountId) continue;
      // per-proxy 隔离：只选当前代理采集的 SubmitSign
      if (proxyIp && rec.proxyIp !== proxyIp) continue;
      if (rec.consumed) continue;
      if (now - rec.acquiredAt >= SUBMIT_SIGN_TTL_MS) continue;

      // responseMaxSlotDate < lockPlanDate：该 SubmitSign 生成时服务器尚未释放目标日期号源，锁号必然失败
      if (rec.responseMaxSlotDate && rec.responseMaxSlotDate < lockPlanDate) continue;

      candidates.push(rec);
    }

    if (candidates.length === 0) return null;

    // 排序：acquiredAt 越新越优先
    candidates.sort((a, b) => b.acquiredAt - a.acquiredAt);

    return candidates[0];
  }

  /**
   * 轮询策略：选出最久未被使用的 SubmitSign（LRU）
   * 筛选条件与 select() 相同，仅排序不同：lastUsedAt 越早（或从未使用）越优先
   *
   * @param {string} accountId
   * @param {string} lockPlanDate
   * @param {'doctor'|'dept'} queryMode
   * @param {string|null} [proxyIp]
   * @returns {SubmitSignRecord|null}
   */
  selectRotate(accountId, lockPlanDate, queryMode, proxyIp = null) {
    const now = Date.now();
    const candidates = [];

    for (const rec of this._pool.values()) {
      if (rec.accountId !== accountId) continue;
      if (proxyIp && rec.proxyIp !== proxyIp) continue;
      if (rec.consumed) continue;
      if (now - rec.acquiredAt >= SUBMIT_SIGN_TTL_MS) continue;
      if (rec.responseMaxSlotDate && rec.responseMaxSlotDate < lockPlanDate) continue;
      candidates.push(rec);
    }

    if (candidates.length === 0) return null;

    // 排序：lastUsedAt 越早越优先（null 视为 0，即从未使用的优先级最高）
    candidates.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));

    return candidates[0];
  }

  /**
   * 标记一条记录已被使用（增加使用次数）
   * @param {string} id
   */
  markUsed(id) {
    if (!id) return;
    const rec = this._pool.get(id);
    if (!rec) return;
    const now = Date.now();
    rec.usedCount += 1;
    if (!rec.firstUsedAt) rec.firstUsedAt = now;
    rec.lastUsedAt = now;
  }

  /**
   * 标记一条记录已被消耗（不可再用）
   * @param {string} id
   * @param {'lock_success'|'changed_error'|'unknown'} reason
   */
  markConsumed(id, reason = 'unknown') {
    if (!id) return;
    const rec = this._pool.get(id);
    if (!rec || rec.consumed) return;  // 幂等保护：已消耗则不重复写入
    rec.consumed = true;
    rec.consumedAt = Date.now();
    rec.consumedReason = reason;
  }

  /**
   * 清理过期 & 已消耗的记录
   */
  cleanup() {
    const now = Date.now();
    for (const [id, rec] of this._pool) {
      if (rec.consumed || now - rec.acquiredAt >= SUBMIT_SIGN_TTL_MS) {
        this._pool.delete(id);
      }
    }
  }

  /**
   * 清空所有记录
   */
  clear() {
    this._pool.clear();
  }

  /**
   * 当前池中有效记录数（未消耗、未过期）
   */
  get size() {
    const now = Date.now();
    let count = 0;
    for (const rec of this._pool.values()) {
      if (!rec.consumed && now - rec.acquiredAt < SUBMIT_SIGN_TTL_MS) count++;
    }
    return count;
  }

  /**
   * 获取某账号的所有有效记录（调试用）
   */
  getByAccount(accountId) {
    const now = Date.now();
    const result = [];
    for (const rec of this._pool.values()) {
      if (rec.accountId === accountId && !rec.consumed && now - rec.acquiredAt < SUBMIT_SIGN_TTL_MS) {
        result.push(rec);
      }
    }
    return result;
  }
}

module.exports = SubmitSignPool;
