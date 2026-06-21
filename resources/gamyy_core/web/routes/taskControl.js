'use strict';

const { Router } = require('express');
const { getDb, ok, err } = require('./_helper');
const { resolveProxyEffectiveConfig } = require('./tasks');
const C = require('../../account/constants');

const router = Router();

// 取代理的有效模板：proxy.template_id 优先；为空则用"默认配置"代理模板兜底
function loadEffectiveTemplate(db, proxy) {
  if (proxy.template_id) {
    const t = db.prepare('SELECT * FROM proxy_templates WHERE id = ?').get(proxy.template_id);
    if (t) return t;
  }
  return db.prepare("SELECT * FROM proxy_templates WHERE name = '默认配置'").get() || null;
}

// 从 task_proxies 快照读出该任务关联的代理（已启用且仍属于该账号）
function loadTaskProxies(db, taskId) {
  return db.prepare(`
    SELECT p.* FROM task_proxies tp
    JOIN proxies p ON p.id = tp.proxy_id
    WHERE tp.task_id = ?
      AND p.enabled  = 1
    ORDER BY p.id ASC
  `).all(taskId);
}

// POST /api/tasks/:id/start
router.post('/:id/start', async (req, res) => {
  try {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return err(res, '任务不存在', 404);
    if (!task.enabled) return err(res, '任务已禁用', 400);

    if (!task.account_id) return err(res, '该任务没有绑定账号', 400);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND enabled = 1').get(task.account_id);
    if (!account) return err(res, '该任务绑定的账号不存在或已禁用', 400);

    const sys = db.prepare('SELECT * FROM system_config WHERE id = 1').get();

    const taskProxies = loadTaskProxies(db, task.id);

    if (taskProxies.length === 0) {
      return err(res, '该任务没有关联的代理（task_proxies 快照为空），请重新分配或重建任务', 400);
    }

    // 顶层 config 只放"真正全局"字段（来自 system_config）+ 任务/账号元数据。
    // 所有调度参数（checkMode/checkRequest/lockRequest/channelBuildPhase1/queryParams/...）
    // 严格 per-proxy，挂在 _proxies[i].cfg 上，不在顶层冒充任务级。
    const config = {
      // 真正全局（来自 system_config 表）
      connectionPool:         { targetHosts: JSON.parse(sys.target_hosts || '[]') },
      timeout: {
        connectTimeout:       sys.connect_timeout,
        requestTimeout:       sys.request_timeout,
        // 心跳超时(heartbeatTimeout)与 keepAlive 已下沉到代理级，挂在 _proxies[i].cfg 上，顶层不再有
      },
      proxyClassifier:        JSON.parse(sys.proxy_classifier || '{}'),
      cloudUnreachableAction: sys.cloud_unreachable_action || 'fallback',
    };

    config.account = {
      type: account.account_type ?? 'wechat',
      platform: account.account_platform ?? 'android',
    };

    // 从子表加载账号凭证字段
    const device  = db.prepare('SELECT * FROM account_devices     WHERE account_id = ?').get(account.id);
    const ext     = db.prepare('SELECT * FROM account_details_ext WHERE account_id = ?').get(account.id);
    const session = db.prepare('SELECT * FROM account_sessions    WHERE account_id = ?').get(account.id);

    const patientIdNum = task.patient_id != null ? Number(task.patient_id) : null;
    let patientRow = (patientIdNum != null && !isNaN(patientIdNum))
      ? db.prepare('SELECT * FROM account_patients WHERE account_id = ? AND CAST(patient_id AS INTEGER) = CAST(? AS INTEGER)').get(account.id, patientIdNum)
      : null;
    if (!patientRow) {
      patientRow = db.prepare('SELECT * FROM account_patients WHERE account_id = ? LIMIT 1').get(account.id);
    }

    const isApp    = (account.account_type || 'wechat') === 'app';
    const platform = account.account_platform || (isApp ? 'ios' : 'wechat');

    // 客户端身份字段（UA / Referer）一律以 account_devices 为真相源；system_config 不再覆盖。
    // 极端兜底：device 缺字段时回退到 constants 中的默认 UA（仅防御历史遗留账号；新建账号
    // 由 AccountCreator / register / add-manual 三条路径保证 user_agent 一定写入）。
    let userAgent = device?.user_agent || null;
    let referer   = device?.referer   || null;
    if (!userAgent) {
      userAgent = platform === 'wechat'  ? C.DEFAULT_UA.wechat
                : platform === 'android' ? C.DEFAULT_UA.android
                :                          C.DEFAULT_UA.app;
    }

    const cookieRaw = session?.cookie_mobile_manage || null;
    const cookieVal = cookieRaw ? cookieRaw.split(';')[0].trim() : null;

    config._accounts = [{
      id:                        account.id,
      mobile:                    account.mobile,
      platform,
      token:                     ext?.token || null,
      s456hr8:                   device?.s456hr8   || null,
      device_id:                 device?.device_id || null,
      user_agent:                userAgent,
      referer,
      cookie_mobile_manage:      cookieVal,
      cookie_mobile_manage_full: cookieRaw,
      patient_id:                patientRow?.patient_id ?? null,
      patient_name:              patientRow?.name        ?? null,
      patient_id_card:           patientRow?.id_card     ?? null,
      doctorCode:                task.doctor_code,
      lockPlanDate:              task.lock_plan_date,
    }];
    config.account.accounts = config._accounts;

    config._proxies = taskProxies.map(p => {
      const tmpl = loadEffectiveTemplate(db, p);
      const proxyCfg = resolveProxyEffectiveConfig(sys, p, tmpl);
      const extraInfo = JSON.parse(p.extra_info || '{}');

      return {
        id:                   p.id,
        host:                 p.host || extraInfo.ip || null,
        port:                 p.port,
        proxyType:            p.proxy_type || 'standard',
        username:             p.username || extraInfo.username || null,
        password:             p.password || extraInfo.password || null,
        realProxyIp:          p.real_ip || extraInfo.real_ip || null,
        sourceId:             p.source_id,
        // 兼容旧字段：保留 channelBuildOverride（即 phase1 的 channelBuild 段）
        channelBuildOverride: proxyCfg.channelBuildPhase1,
        targetHosts:          proxyCfg.channelBuildPhase1?.targetHosts || null,
        cloud_agent_url:      p.cloud_agent_url || null,
        extraInfo,
        // 新：完整的代理级有效配置（云端 agent 在代理上下文中按 cfg 字段读取）
        cfg: {
          checkMode:          proxyCfg.checkMode,
          doctorSource:       proxyCfg.doctorSource,
          doctorSelectMode:   proxyCfg.doctorSelectMode,
          queryParams:        proxyCfg.queryParams,
          deptQueryParams:    proxyCfg.deptQueryParams,
          checkRequest:       proxyCfg.checkRequest,
          lockRequest:        proxyCfg.lockRequest,
          channelBuildPhase1: proxyCfg.channelBuildPhase1,
          // TLS 指纹（代理级）：account/HttpClient 经 sidecar 时按 cfg.fingerprint 选指纹
          fingerprint:        proxyCfg.fingerprint,
          // 心跳/keepAlive 下沉到代理级：connectionChannel 优先按 cfg.keepAlive 读取
          keepAlive:          proxyCfg.keepAlive,
          heartbeatTimeout:   proxyCfg.timeout?.heartbeatTimeout,
        },
      };
    });

    const sysVer  = db.prepare('SELECT id FROM system_config_versions ORDER BY id DESC LIMIT 1').get();

    config._taskId   = task.id;
    config._taskName = task.name;
    config._accountId = account.id;
    config._accountSnapshot = JSON.stringify({
      mobile:       account.mobile,
      account_type: account.account_type,
      platform:     account.account_platform,
    });
    config._systemConfigVersionId = sysVer?.id ?? null;
    config._proxySnapshot = JSON.stringify(config._proxies.map(p => ({
      id:        p.id,
      host:      p.host,
      port:      p.port,
      proxyType: p.proxyType || p.proxy_type,
    })));

    // dept 模式且未明确配置 deptCode 时，在本机解析 doctorCode→deptCode 映射
    // 改为 per-proxy 检测：只要任意代理是 dept 模式且未配 deptCode 就构 deptCodesMap
    const anyDeptModeNeedsMap = config._proxies.some(p => {
      const cfg = p.cfg || {};
      return cfg.checkMode === 'dept' && !cfg.deptQueryParams?.deptCode;
    });
    if (anyDeptModeNeedsMap) {
      const doctorCodes = [...new Set(config._accounts.map(a => a.doctorCode).filter(Boolean))];
      if (doctorCodes.length > 0) {
        try {
          const path = require('path');
          const Database = require('better-sqlite3');
          const hospitalDb = new Database(path.join(__dirname, '../../data/hospital.db'), { readonly: true });
          const placeholders = doctorCodes.map(() => '?').join(',');
          const rows = hospitalDb.prepare(
            `SELECT doctor_code, dept_code FROM doctors WHERE doctor_code IN (${placeholders})`
          ).all(...doctorCodes);
          hospitalDb.close();
          if (rows.length > 0) {
            config._deptCodesMap = Object.fromEntries(rows.map(r => [r.doctor_code, r.dept_code]));
          }
        } catch (e) {
          console.warn(`⚠️ 构建 _deptCodesMap 失败: ${e.message}`);
        }
      }
    }

    // ─── 云端管理通信转发开关 ─────────────────────────────────────────
    // 开关开 + 任务含云端代理(cloud_agent_url 非空) → 走该账号的 ops_proxy 转发
    // 开关关 / 无云端代理 → 本地直连(沿用现状)
    const hasCloudProxy = taskProxies.some(p => p.cloud_agent_url);
    if (hasCloudProxy && sys.cloud_dispatch_via_proxy) {
      if (!account.ops_proxy_id) {
        return err(res, '系统已开启"通过操作代理转发云端管理通信",但该账号未分配操作代理(ops_proxy),请先分配后再启动', 400);
      }
      // 操作代理只看 ops_enabled(与 _pickProxy / AccountOperationService 语义一致);
      // proxies.enabled 是任务代理的开关,不参与操作代理可用性判断
      const op = db.prepare(
        "SELECT host, port, username, password, proxy_type FROM proxies WHERE id = ? AND ops_enabled = 1"
      ).get(account.ops_proxy_id);
      if (!op) {
        return err(res, '该账号绑定的操作代理不存在或操作用途已禁用(ops_enabled = 0),请重新分配后再启动', 400);
      }
      if (op.proxy_type === 'direct' || !op.port) {
        return err(res, '该账号的操作代理是直连或无本地端口,无法用于云端管理通信转发,请改绑带本地端口的代理', 400);
      }
      config.cloudDispatch = {
        viaProxy: true,
        opsProxy: { host: op.host, port: op.port, username: op.username, password: op.password },
      };
    } else {
      config.cloudDispatch = { viaProxy: false, opsProxy: null };
    }

    await req.taskRunner.start(Number(req.params.id), config);
    ok(res, { started: true });
  } catch (e) {
    err(res, e.message, 500);
  }
});

// POST /api/tasks/:id/stop
router.post('/:id/stop', async (req, res) => {
  try {
    await req.taskRunner.stop(Number(req.params.id));
    ok(res, { stopped: true });
  } catch (e) {
    err(res, e.message, 400);
  }
});

// GET /api/tasks/:id/status
router.get('/:id/status', (req, res) => {
  try {
    const status = req.taskRunner.getStatus(Number(req.params.id));
    ok(res, status);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// GET /api/tasks/:id/proxies
router.get('/:id/proxies', (req, res) => {
  try {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return err(res, '任务不存在', 404);
    if (!task.account_id) return ok(res, []);
    const slice = loadTaskProxies(db, task.id);
    const sys = db.prepare('SELECT * FROM system_config WHERE id = 1').get();
    const riskIps = new Set(
      db.prepare('SELECT ip FROM risk_flagged_ips').all().map(r => r.ip)
    );
    ok(res, slice.map(p => {
      const tmpl = loadEffectiveTemplate(db, p);
      const eff = resolveProxyEffectiveConfig(sys, p, tmpl);
      const extra = JSON.parse(p.extra_info || '{}');
      const host = p.host || extra.ip || null;
      const realProxyIp = p.real_ip || extra.real_ip || null;
      return {
        id:                p.id,
        host,
        port:              p.port,
        proxy_type:        p.proxy_type || 'standard',
        realProxyIp,
        template_id:       p.template_id,
        is_risk_flagged:   (realProxyIp && riskIps.has(realProxyIp)) || (host && riskIps.has(host)) ? 1 : 0,
        // 代理级覆盖原值（用于 UI 表明该字段是否被代理覆盖）
        check_mode:                   p.check_mode,
        check_start_time:             p.check_start_time,
        check_window_time:            p.check_window_time,
        check_min_interval:           p.check_min_interval,
        check_distribution:           p.check_distribution,
        check_stop_after_found_count: p.check_stop_after_found_count,
        check_reuse_channel:          p.check_reuse_channel ? JSON.parse(p.check_reuse_channel) : null,
        lock_config:                  p.lock_config ? JSON.parse(p.lock_config) : null,
        channel_build_overrides:      JSON.parse(p.channel_build_overrides || '{}'),
        target_hosts:                 p.target_hosts ? JSON.parse(p.target_hosts) : null,
        // 心跳/keepAlive 代理级覆盖原值（null = 跟随模板）
        keepalive_enabled:            p.keepalive_enabled,
        keepalive_interval_min:       p.keepalive_interval_min,
        keepalive_interval_max:       p.keepalive_interval_max,
        keepalive_request_type:       p.keepalive_request_type,
        keepalive_business_endpoints: p.keepalive_business_endpoints ? JSON.parse(p.keepalive_business_endpoints) : null,
        direct_keepalive_enabled:     p.direct_keepalive_enabled,
        heartbeat_timeout:            p.heartbeat_timeout,
        // 有效配置（合并模板/系统后）：用于 UI 直接展示生效值
        // 注意 shape：把对象整段返回，前端按 .channel_build_overrides.startTime / .lock_config.windowTime 访问
        effective: {
          check_mode:                   eff.checkMode,
          check_start_time:             eff.checkRequest?.startTime ?? null,
          check_window_time:            eff.checkRequest?.windowTime ?? null,
          check_min_interval:           eff.checkRequest?.minInterval ?? null,
          check_distribution:           eff.checkRequest?.distribution ?? null,
          check_stop_after_found_count: eff.checkRequest?.stopAfterFoundCount ?? 3,
          check_reuse_channel:          eff.checkRequest?.reuseChannel ?? null,
          lock_config:                  eff.lockRequest?.global ?? {},
          channel_build_overrides:      eff.channelBuildPhase1 ?? {},
          target_hosts:                 eff.channelBuildPhase1?.targetHosts ?? null,
          doctor_source:                eff.doctorSource,
          doctor_select_mode:           eff.doctorSelectMode,
          doctor_codes:                 eff.queryParams?.doctorCodes,
          doctor_plan_date_start:       eff.queryParams?.planDateStart,
          dept_code:                    eff.deptQueryParams?.deptCode,
          dept_plan_date_start:         eff.deptQueryParams?.planDateStart,
          dept_plan_date_end:           eff.deptQueryParams?.planDateEnd,
          // 心跳有效值
          keepalive_enabled:            eff.keepAlive?.enabled,
          keepalive_interval_min:       eff.keepAlive?.intervalMin,
          keepalive_interval_max:       eff.keepAlive?.intervalMax,
          keepalive_request_type:       eff.keepAlive?.request?.type,
          keepalive_business_endpoints: eff.keepAlive?.request?.enabledEndpoints ?? [],
          direct_keepalive_enabled:     eff.keepAlive?.directKeepaliveEnabled,
          heartbeat_timeout:            eff.timeout?.heartbeatTimeout,
        },
      };
    }));
  } catch (e) {
    err(res, e.message, 500);
  }
});

// GET /api/tasks/:id/proxy-stats
router.get('/:id/proxy-stats', (req, res) => {
  try {
    ok(res, req.taskRunner.getProxyStats(Number(req.params.id)));
  } catch (e) {
    err(res, e.message, 500);
  }
});

module.exports = router;
