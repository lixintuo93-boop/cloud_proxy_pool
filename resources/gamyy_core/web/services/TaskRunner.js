'use strict';

const EventEmitter = require('events');
const SchedulerService = require('../../services/SchedulerService');
const cloudAgentClient = require('./cloudAgentClient');

// ── 轮询配置 ────────────────────────────────────────────────────────────────
// 轮询间隔：30秒。每个 handle 的首次触发延迟使用 [0, POLL_INTERVAL) 随机抖动，
// 将 N 个 handle 的轮询均匀分散在窗口内，避免同秒突发。
const POLL_INTERVAL = 30000;

// ── 异步信号量 ───────────────────────────────────────────────────────────────
// 用于限制同时进行的云端启动请求数量，防止 N 个任务同时发出 HTTP 请求打爆云端
class AsyncSemaphore {
  constructor(max) { this._max = max; this._count = 0; this._queue = []; }
  acquire() {
    if (this._count < this._max) { this._count++; return Promise.resolve(); }
    return new Promise(resolve => this._queue.push(resolve));
  }
  release() {
    // 有等待者时直接转移槽位（count 不变），否则释放
    if (this._queue.length > 0) { this._queue.shift()(); }
    else { this._count--; }
  }
}

const TaskStatus = {
  IDLE:         'idle',
  INITIALIZING: 'initializing',
  RUNNING:      'running',
  STOPPING:     'stopping',
  ERROR:        'error',
};

// 任务级终止事件：任意代理报告这两个原因都意味着该账号在号源系统已经有号了
// （刚锁成功 / 之前就有），其他代理继续跑没有任何收益，应当主动停掉整个任务
const TERMINAL_REASONS = new Set(['lock_success', 'already_booked']);

// per-cloud_agent_url 熔断参数
const BREAKER_FAIL_THRESHOLD = 3;       // 连续失败次数阈值
const BREAKER_COOLDOWN_MS    = 60_000;  // 冷却时长

// _startCloudHandle 重试参数：1 次初始 + 3 次重试 = 共 4 次尝试。
// 两套 backoff:
//   - DIRECT(直连):4 × 60s + 4+8+16 = 268s,前端 timeout 300s
//   - PROXY(走代理):4 × 120s + 8+16+32 = 536s,前端 timeout 600s
// 走代理时延迟与抖动更大,backoff 整体翻倍
const STARTTASK_MAX_ATTEMPTS       = 4;
const STARTTASK_BACKOFF_MS_DIRECT  = [4_000,  8_000, 16_000];
const STARTTASK_BACKOFF_MS_PROXY   = [8_000, 16_000, 32_000];

class TaskRunner extends EventEmitter {
  constructor() {
    super();
    // taskId -> entry
    this.runningTasks = new Map();
    // 启动信号量：POST /run 重量级，严控并发保护云端 agent 进程
    // (探活阶段已移除，原 _probeSem 不再需要)
    this._startSem = new AsyncSemaphore(15);
    // per-cloud_agent_url 熔断：Map<agentUrl, { failures, openUntil }>
    // 连续 BREAKER_FAIL_THRESHOLD 次失败 → 冷却 BREAKER_COOLDOWN_MS，期间直接走 fallback/discard
    this._breaker = new Map();
  }

  _isBreakerOpen(agentUrl) {
    const b = this._breaker.get(agentUrl);
    return !!(b && b.openUntil > Date.now());
  }
  _breakerOnSuccess(agentUrl) {
    if (this._breaker.has(agentUrl)) this._breaker.delete(agentUrl);
  }
  _breakerOnFailure(agentUrl) {
    const b = this._breaker.get(agentUrl) || { failures: 0, openUntil: 0 };
    b.failures += 1;
    if (b.failures >= BREAKER_FAIL_THRESHOLD) {
      b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      console.warn(`☁️ Agent ${agentUrl} 熔断 ${Math.round(BREAKER_COOLDOWN_MS/1000)}s（连续失败 ${b.failures} 次）`);
    }
    this._breaker.set(agentUrl, b);
  }

  // 把不可达 agent 对应的代理推入 fallback 队列（或丢弃），统一处理 startTask 失败 / 熔断 两种情形
  _routeUnreachable(agentUrl, proxies, config, fallbackProxies, reason) {
    if (config.cloudUnreachableAction === 'discard') {
      console.warn(`☁️ ${agentUrl} ${reason}，已丢弃 ${proxies.length} 个代理`);
      return;
    }
    const canFallback = proxies.filter(p => p.port);
    const noPort      = proxies.filter(p => !p.port);
    if (noPort.length > 0) {
      console.warn(`☁️ ${agentUrl} ${reason}，${noPort.length} 个无本地端口代理已丢弃（仅云端运行）`);
    }
    if (canFallback.length > 0) {
      console.warn(`☁️ ${agentUrl} ${reason}，${canFallback.length} 个代理降级到本地`);
      fallbackProxies.push(...canFallback.map(p => ({ ...p, cloud_agent_url: undefined })));
    }
  }

  getStatus(taskId) {
    const entry = this.runningTasks.get(taskId);
    if (!entry) return { status: TaskStatus.IDLE };
    return {
      status:    entry.status,
      mode:      entry.mode || 'local',
      startedAt: entry.startedAt,
      error:     entry.error || null,
    };
  }

  getAllStatuses() {
    const result = {};
    for (const [taskId, entry] of this.runningTasks) {
      result[taskId] = {
        status:    entry.status,
        mode:      entry.mode || 'local',
        startedAt: entry.startedAt,
        error:     entry.error || null,
      };
    }
    return result;
  }

  async start(taskId, config) {
    if (this.runningTasks.has(taskId)) {
      const entry = this.runningTasks.get(taskId);
      if (entry.status === TaskStatus.RUNNING || entry.status === TaskStatus.INITIALIZING) {
        throw new Error(`任务 ${taskId} 已在运行中`);
      }
    }

    // 按 cloud_agent_url 分组；无 cloud_agent_url 的归本地
    const cloudGroupMap = new Map(); // agentUrl -> [proxy, ...]
    const localProxies  = [];
    for (const p of config._proxies || []) {
      if (p.cloud_agent_url) {
        if (!cloudGroupMap.has(p.cloud_agent_url)) cloudGroupMap.set(p.cloud_agent_url, []);
        cloudGroupMap.get(p.cloud_agent_url).push(p);
      } else {
        localProxies.push(p);
      }
    }

    // 无云端代理：纯本地
    if (cloudGroupMap.size === 0) {
      return this._runLocal(taskId, config, 'local');
    }

    // ─── 阶段 1（探活已移除）：直接进入启动 ─────────────────────────────────
    // 设计取舍：批量启动 2000 任务时探活会带来等量 HTTP 请求且未必能识别瞬时抖动，
    // 改成直接 /run + 内置重试(_startCloudHandle)。只跳过历史已熔断的 agent，
    // 避免对已知坏 agent 浪费一次 60s 超时的启动尝试。
    const reachableGroups = new Map(); // agentUrl -> [proxy, ...]
    const fallbackProxies = [...localProxies];

    for (const [agentUrl, proxies] of cloudGroupMap) {
      if (this._isBreakerOpen(agentUrl)) {
        this._routeUnreachable(agentUrl, proxies, config, fallbackProxies, '熔断中（短期内已多次失败）');
      } else {
        reachableGroups.set(agentUrl, proxies);
      }
    }

    // 全部命中熔断：纯本地降级
    if (reachableGroups.size === 0) {
      return this._runLocal(taskId, { ...config, _proxies: fallbackProxies }, 'local_fallback');
    }

    // 计算云端管理通信的传输选项:
    //   开关开 + 账号有 ops_proxy → 走 SOCKS5 代理转发(cloudAgentClient 内部走更长 timeout)
    //   开关关 / 无 cloud 代理   → 直连(本路径已在 taskControl 入口严格校验,这里只读结果)
    const _cd = config.cloudDispatch;
    const _cloudViaProxy = !!(_cd && _cd.viaProxy && _cd.opsProxy);
    const cloudOpts = _cloudViaProxy
      ? { agent: cloudAgentClient.getProxyAgent(_cd.opsProxy) }
      : undefined;

    // 至少有一个云端可达：先初始化 entry（mode 留到阶段 2 之后再定型）
    const entry = {
      mode:         'cloud',  // 临时值，阶段 2 后矫正
      status:       TaskStatus.INITIALIZING,
      startedAt:    new Date().toISOString(),
      error:        null,
      scheduler:    null,
      logDb:        null,
      runId:        null,
      cloudHandles: [],
      cloudOpts,    // 透传给所有 cloudAgentClient 调用,决定走直连还是代理
      viaProxy:     _cloudViaProxy,
    };
    this.runningTasks.set(taskId, entry);
    this._emit(taskId, entry);

    // ─── 阶段 2：并行启动所有 cloud handles ─────────────────────────────────
    const groupEntries  = [...reachableGroups];
    const cloudResults  = await Promise.allSettled(
      groupEntries.map(([agentUrl, proxies]) =>
        this._startCloudHandle(taskId, entry, agentUrl, proxies, config)
      )
    );

    // 收集 startTask 失败的 agent（_startCloudHandle 内已重试 3 次仍失败）→ 计入熔断 + 走 fallback
    cloudResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        const [agentUrl, proxies] = groupEntries[i];
        this._breakerOnFailure(agentUrl);
        this._routeUnreachable(agentUrl, proxies, config, fallbackProxies, `startTask 失败: ${r.reason?.message || '未知'}`);
      }
    });

    // ─── 阶段 3：把 startTask 失败 + 原 fallback 合并起来跑一次本地 ──────────────
    if (fallbackProxies.length > 0) {
      try {
        await this._startLocalHandle(taskId, entry, config, fallbackProxies);
      } catch (e) {
        console.error(`本地降级启动失败: ${e.message}`);
      }
    }

    // 全部启动失败
    if (entry.cloudHandles.length === 0 && !entry.scheduler) {
      const firstErr = cloudResults.find(r => r.status === 'rejected');
      entry.status = TaskStatus.ERROR;
      entry.error  = firstErr?.reason?.message || '所有部分启动失败';
      this._emit(taskId, entry);
      this.runningTasks.delete(taskId);
      throw new Error(entry.error);
    }

    // 定型最终 mode
    if (entry.cloudHandles.length > 0 && entry.scheduler) entry.mode = 'hybrid';
    else if (entry.cloudHandles.length > 0)               entry.mode = 'cloud';
    else                                                  entry.mode = 'local';

    if (entry.status === TaskStatus.INITIALIZING) {
      entry.status = TaskStatus.RUNNING;
      this._emit(taskId, entry);
    }
  }

  async stop(taskId) {
    const entry = this.runningTasks.get(taskId);
    if (!entry) throw new Error(`任务 ${taskId} 未在运行`);
    if (entry.status === TaskStatus.STOPPING) return;

    entry.status = TaskStatus.STOPPING;
    this._emit(taskId, entry);

    const cleanups = [];

    for (const handle of entry.cloudHandles || []) {
      cleanups.push((async () => {
        // 标记取消，防止 doPoll 在执行期间重新调度
        handle._pollCancelled = true;
        if (handle.pollTimer) { clearTimeout(handle.pollTimer); handle.pollTimer = null; }
        if (handle.remoteTaskId != null) {
          await cloudAgentClient.stopTask(handle.agentUrl, handle.remoteTaskId, entry.cloudOpts).catch(() => {});
        }
      })());
    }

    cleanups.push((async () => {
      if (entry.logDb && entry.runId) {
        try { await entry.logDb.updateRun(entry.runId, { status: 'stopped', stopReason: 'manual' }); } catch (_) {}
      }
      if (entry.scheduler) {
        await entry.scheduler.cleanup().catch(() => {});
      }
    })());

    await Promise.allSettled(cleanups);
    this.runningTasks.delete(taskId);
    this.emit('taskStopped', { taskId, reason: 'manual' });
  }

  async stopAll() {
    const ids = [...this.runningTasks.keys()];
    await Promise.allSettled(ids.map(id => this.stop(id)));
  }

  getProxyStats(taskId) {
    const entry = this.runningTasks.get(taskId);
    if (!entry) return [];
    const stats = [];
    for (const handle of entry.cloudHandles || []) {
      stats.push(...(handle.cachedProxyStats || []).map(s => ({ ...s, runMode: 'cloud' })));
    }
    if (entry.scheduler) {
      stats.push(...entry.scheduler.getProxyStats().map(s => ({ ...s, runMode: 'local' })));
    }
    return stats;
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────────

  // 纯本地模式（无云端代理或全部降级）
  async _runLocal(taskId, config, mode) {
    const entry = {
      scheduler:    null,
      logDb:        null,
      runId:        null,
      cloudHandles: [],
      mode,
      status:       TaskStatus.INITIALIZING,
      startedAt:    new Date().toISOString(),
      error:        null,
    };
    this.runningTasks.set(taskId, entry);
    this._emit(taskId, entry);

    try {
      await this._startLocalHandle(taskId, entry, config, config._proxies);
      if (entry.status === TaskStatus.INITIALIZING) {
        entry.status = TaskStatus.RUNNING;
        this._emit(taskId, entry);
      }
    } catch (err) {
      entry.status = TaskStatus.ERROR;
      entry.error  = err.message;
      this._emit(taskId, entry);
      throw err;
    }
  }

  // 检查任务所有部分是否都已结束，是则移除并 emit taskStopped
  // 🆕 携带 finalStats（本地+云端最后一帧统计）和 reason，供前端在停止瞬间还能看到完整状态
  // 🆕 lock_success / already_booked 是"任务级终止事件"——账号已经被挂上号了，
  //    其他还在跑的代理继续抢号没意义，直接主动停掉整个任务（取消所有云端 handle + 清理本地 scheduler）
  _checkAllStopped(taskId, reason) {
    const e = this.runningTasks.get(taskId);
    if (!e) return;

    if (TERMINAL_REASONS.has(reason)) {
      // 主动取消其他还在跑的云端 handle 并远程 stopTask（fire-and-forget）
      for (const handle of e.cloudHandles || []) {
        if (handle._pollCancelled) continue;
        handle._pollCancelled = true;
        if (handle.pollTimer) { clearTimeout(handle.pollTimer); handle.pollTimer = null; }
        if (handle.remoteTaskId != null) {
          cloudAgentClient.stopTask(handle.agentUrl, handle.remoteTaskId, e.cloudOpts).catch(() => {});
        }
      }
      // 清理本地 scheduler（若还在跑）。先快照统计 + 落 DB，再异步 cleanup
      if (e.scheduler) {
        try { e.localCachedFinalStats = e.scheduler.getProxyStats(); } catch (_) {}
        const sched = e.scheduler;
        const logDb = e.logDb;
        const runId = e.runId;
        e.scheduler = null;
        (async () => {
          if (logDb && runId) {
            try { await logDb.updateRun(runId, { status: 'stopped', stopReason: reason }); } catch (_) {}
          }
          try { await sched.cleanup(); } catch (_) {}
        })();
      }
    }

    const anyCloudRunning = e.cloudHandles.some(h => h.pollTimer !== null);
    const localRunning    = e.scheduler !== null;
    if (!anyCloudRunning && !localRunning) {
      const finalStats = [];
      for (const handle of e.cloudHandles || []) {
        finalStats.push(...(handle.cachedProxyStats || []).map(s => ({ ...s, runMode: 'cloud' })));
      }
      if (Array.isArray(e.localCachedFinalStats)) {
        finalStats.push(...e.localCachedFinalStats.map(s => ({ ...s, runMode: 'local' })));
      }
      this.runningTasks.delete(taskId);
      this.emit('taskStopped', { taskId, reason, finalStats });
    }
  }

  // 启动本地 SchedulerService 部分（将 entry.scheduler/logDb/runId 填充）
  async _startLocalHandle(taskId, entry, config, proxies) {
    let autoStopCalled = false;
    const onAutoStop = async (reason) => {
      if (autoStopCalled) return;
      autoStopCalled = true;
      const e = this.runningTasks.get(taskId);
      if (!e || e.status === TaskStatus.STOPPING) return;
      console.log(`🛑 任务 ${taskId} 本地部分自动停止: ${reason}`);
      // 🆕 cleanup 会清空 connectionPool/ticketService 内存数据，必须先快照最后一帧统计
      if (e.scheduler) {
        try { e.localCachedFinalStats = e.scheduler.getProxyStats(); } catch (_) {}
      }
      try {
        if (e.logDb && e.runId) {
          try { await e.logDb.updateRun(e.runId, { status: 'stopped', stopReason: reason }); } catch (_) {}
        }
        if (e.scheduler) { try { await e.scheduler.cleanup(); } catch (_) {} }
      } finally {
        e.scheduler = null;
        this._checkAllStopped(taskId, reason);
      }
    };

    try {
      const localConfig = { ...config, _proxies: proxies };
      const scheduler = new SchedulerService(localConfig);
      scheduler.setOnAutoStop(onAutoStop);
      entry.scheduler = scheduler;

      const initResult = await scheduler.initialize();
      entry.logDb = scheduler.ticketService.logDb;
      entry.runId = entry.logDb.runId;
      this._emit(taskId, entry, { initResult });

      await scheduler.startScheduledCheck();
    } catch (err) {
      const schedulerToCleanup = entry.scheduler;
      entry.scheduler = null;
      if (entry.logDb && entry.runId) {
        try { await entry.logDb.updateRun(entry.runId, { status: 'error', stopReason: err.message }); } catch (_) {}
      }
      if (schedulerToCleanup) { try { await schedulerToCleanup.cleanup(); } catch (_) {} }
      throw err;
    }
  }

  // 启动单个云端 Agent 的 handle（只发该 Agent 对应的那批代理）
  async _startCloudHandle(taskId, entry, agentUrl, proxies, config) {
    // 该 Agent 的代理在云端以直连方式运行，cloud_agent_url 不需要再传递
    const cloudConfig = {
      ...config,
      _proxies: proxies.map(p => ({
        ...p,
        proxyType:       'direct',
        cloud_agent_url: undefined,
      })),
    };

    const handle = {
      agentUrl,
      remoteTaskId:     null,
      pollTimer:        null,
      _pollCancelled:   false,
      cachedProxyStats: [],
    };
    entry.cloudHandles.push(handle);

    try {
      // 限速：startSem(15) 保护云端 agent 进程
      // 重试：3 次重试 + 指数 backoff,backoff 期间不持有信号量,避免阻塞其他任务
      // 走代理时 backoff 翻倍(代理路径抖动期更长)
      const backoffs = entry.viaProxy ? STARTTASK_BACKOFF_MS_PROXY : STARTTASK_BACKOFF_MS_DIRECT;
      let result, lastErr;
      for (let attempt = 1; attempt <= STARTTASK_MAX_ATTEMPTS; attempt++) {
        await this._startSem.acquire();
        try {
          result = await cloudAgentClient.startTask(agentUrl, cloudConfig, entry.cloudOpts);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        } finally {
          this._startSem.release();
        }
        if (attempt < STARTTASK_MAX_ATTEMPTS) {
          const waitMs = backoffs[attempt - 1];
          console.warn(`☁️ Agent ${agentUrl} 第 ${attempt} 次启动失败: ${lastErr.message}，${waitMs/1000}s 后重试`);
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
      if (lastErr) throw lastErr;

      handle.remoteTaskId = result.taskId;
      console.log(`☁️ 任务 ${taskId} 已委托云端 Agent ${agentUrl}（${proxies.length} 个代理），远程 taskId: ${result.taskId}`);

      // 错峰：将 N 个 handle 的轮询随机分散在整个 POLL_INTERVAL 窗口内。
      // 用 Math.random() 替代固定槽位，避免槽位内 N/SLOTS 个 handle 同秒触发的突发。
      // 2000 个 handle 在 30s 内伪均匀分布，峰值 ≈ 67 req/s（status+stats=134 req/s）。
      const initialDelay = Math.floor(Math.random() * POLL_INTERVAL);

      // 自重调度轮询（替代 setInterval），配合 _pollCancelled 避免停止后 zombie 定时器
      const doPoll = async () => {
        if (handle._pollCancelled || !this.runningTasks.has(taskId)) {
          handle.pollTimer = null;
          return;
        }
        handle.pollTimer = null; // 执行期间清空，此时 stop() 的 clearTimeout 无效但 _pollCancelled 会拦截重排

        try {
          const remote = await cloudAgentClient.getTaskStatus(agentUrl, handle.remoteTaskId, entry.cloudOpts);
          if (!remote || remote.status !== 'running') {
            // 云端任务已结束，拉取最终统计后不再重排
            try {
              const finalStats = await cloudAgentClient.getTaskStats(agentUrl, handle.remoteTaskId, entry.cloudOpts);
              if (finalStats) handle.cachedProxyStats = finalStats;
            } catch (_) {}
            const reason = remote?.stopReason || 'cloud_agent_stopped';
            console.log(`☁️ 云端任务 ${taskId}@${agentUrl} 已结束: ${reason}`);
            this._checkAllStopped(taskId, reason);
            return;
          }
          // 任务仍在运行，更新统计缓存
          try {
            const stats = await cloudAgentClient.getTaskStats(agentUrl, handle.remoteTaskId, entry.cloudOpts);
            if (stats) handle.cachedProxyStats = stats;
          } catch (_) {}
        } catch (_) {}

        // 重排：仅在未取消且任务仍存在时安排下次轮询
        if (!handle._pollCancelled && this.runningTasks.has(taskId)) {
          handle.pollTimer = setTimeout(doPoll, POLL_INTERVAL);
        }
      };

      // 首次触发使用错峰延迟，之后每次以固定 POLL_INTERVAL 重排
      handle.pollTimer = setTimeout(doPoll, initialDelay);

    } catch (e) {
      const idx = entry.cloudHandles.indexOf(handle);
      if (idx !== -1) entry.cloudHandles.splice(idx, 1);
      console.error(`☁️ 云端 Agent ${agentUrl} 启动失败: ${e.message}`);
      throw e;
    }
  }

  _emit(taskId, entry, extra = {}) {
    this.emit('statusChange', {
      taskId,
      status:    entry.status,
      mode:      entry.mode || 'local',
      startedAt: entry.startedAt,
      error:     entry.error,
      ...extra,
    });
  }
}

module.exports = { TaskRunner, TaskStatus };
