'use strict';

const { Router } = require('express');
const { getDb, ok, err, now } = require('./_helper');
const { isPort } = require('./_validate');
const { RECIPES: HEARTBEAT_RECIPES } = require('../../services/HeartbeatEndpointPool');

const router = Router();

// GET /api/system-config/heartbeat-endpoints
// 返回所有可选 endpoint 元数据，供前端渲染复选框列表
router.get('/heartbeat-endpoints', (_req, res) => {
  ok(res, HEARTBEAT_RECIPES.map(r => ({
    id:          r.id,
    name:        r.name,
    method:      r.method,
    path:        r.path,
    contentType: r.contentType,
    encrypted:   r.encrypted,
  })));
});

// GET /api/system-config
router.get('/', (_req, res) => {
  try {
    const row = getDb().prepare('SELECT * FROM system_config WHERE id = 1').get();
    const { proxy_type, ssh_tunnel_db_path, standard_db_path, ...rest } = row;
    const data = {
      ...rest,
      target_hosts:         JSON.parse(row.target_hosts         || '[]'),
      proxy_classifier:     JSON.parse(row.proxy_classifier     || '{}'),
      app_client_config:    JSON.parse(row.app_client_config    || '{}'),
      android_client_config:JSON.parse(row.android_client_config|| '{}'),
      wechat_client_config: JSON.parse(row.wechat_client_config || '{}'),
      app_ua_pool:          JSON.parse(row.app_ua_pool          || '[]'),
      android_ua_pool:      JSON.parse(row.android_ua_pool      || '[]'),
      wechat_ua_pool:       JSON.parse(row.wechat_ua_pool       || '[]'),
    };
    ok(res, data);
  } catch (e) {
    err(res, e.message, 500);
  }
});

// PUT /api/system-config
router.put('/', (req, res) => {
  try {
    const b = req.body;
    if (b.target_hosts != null) {
      if (!Array.isArray(b.target_hosts)) return err(res, 'target_hosts 应为数组', 400);
      for (let i = 0; i < b.target_hosts.length; i++) {
        const h = b.target_hosts[i];
        if (!h.host || typeof h.host !== 'string' || !h.host.trim())
          return err(res, `目标主机第 ${i + 1} 行 host 不能为空`, 400);
        if (!isPort(h.port))
          return err(res, `目标主机第 ${i + 1} 行 port 范围应为 1-65535`, 400);
      }
    }
    const db = getDb();

    if (b.default_proxy_max_count != null) {
      const v = parseInt(b.default_proxy_max_count, 10);
      if (!Number.isInteger(v) || v < 1 || v > 200)
        return err(res, 'default_proxy_max_count 应为 1-200 的整数', 400);
    }

    // UA 池校验：必须为字符串数组，长度 1~200，每条非空 trim
    const validatePool = (val, label) => {
      if (!Array.isArray(val)) return `${label} 应为数组`;
      if (val.length < 1 || val.length > 200) return `${label} 长度应为 1~200`;
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] !== 'string' || !val[i].trim())
          return `${label} 第 ${i + 1} 条不能为空`;
      }
      return null;
    };
    for (const [k, label] of [
      ['app_ua_pool', 'App iOS UA 池'],
      ['android_ua_pool', 'App Android UA 池'],
      ['wechat_ua_pool', '微信端 UA 池'],
    ]) {
      if (b[k] != null) {
        const msg = validatePool(b[k], label);
        if (msg) return err(res, msg, 400);
      }
    }

    // 心跳间隔/endpoint 校验已随心跳配置下沉到代理层（proxyTemplates / proxies 路由）

    db.prepare(`UPDATE system_config SET
      target_hosts             = COALESCE(@target_hosts, target_hosts),
      connect_timeout          = COALESCE(@connect_timeout, connect_timeout),
      request_timeout          = COALESCE(@request_timeout, request_timeout),
      cloud_unreachable_action     = COALESCE(@cloud_unreachable_action, cloud_unreachable_action),
      cloud_dispatch_via_proxy     = COALESCE(@cloud_dispatch_via_proxy, cloud_dispatch_via_proxy),
      proxy_classifier         = COALESCE(@proxy_classifier, proxy_classifier),
      default_proxy_max_count  = COALESCE(@default_proxy_max_count, default_proxy_max_count),
      app_client_config        = COALESCE(@app_client_config, app_client_config),
      android_client_config    = COALESCE(@android_client_config, android_client_config),
      wechat_client_config     = COALESCE(@wechat_client_config, wechat_client_config),
      app_ua_pool              = COALESCE(@app_ua_pool, app_ua_pool),
      android_ua_pool          = COALESCE(@android_ua_pool, android_ua_pool),
      wechat_ua_pool           = COALESCE(@wechat_ua_pool, wechat_ua_pool),
      updated_at               = @updated_at
      WHERE id = 1`).run({
      target_hosts:            b.target_hosts != null ? JSON.stringify(b.target_hosts) : null,
      connect_timeout:         b.connect_timeout ?? null,
      request_timeout:         b.request_timeout ?? null,
      cloud_unreachable_action:    b.cloud_unreachable_action ?? null,
      cloud_dispatch_via_proxy:    b.cloud_dispatch_via_proxy != null ? (b.cloud_dispatch_via_proxy ? 1 : 0) : null,
      proxy_classifier:        b.proxy_classifier != null ? JSON.stringify(b.proxy_classifier) : null,
      default_proxy_max_count: b.default_proxy_max_count != null ? parseInt(b.default_proxy_max_count, 10) : null,
      app_client_config:       b.app_client_config    != null ? JSON.stringify(b.app_client_config)    : null,
      android_client_config:   b.android_client_config!= null ? JSON.stringify(b.android_client_config): null,
      wechat_client_config:    b.wechat_client_config != null ? JSON.stringify(b.wechat_client_config) : null,
      app_ua_pool:             b.app_ua_pool          != null ? JSON.stringify(b.app_ua_pool)          : null,
      android_ua_pool:         b.android_ua_pool      != null ? JSON.stringify(b.android_ua_pool)      : null,
      wechat_ua_pool:          b.wechat_ua_pool       != null ? JSON.stringify(b.wechat_ua_pool)       : null,
      updated_at:              now(),
    });

    // 将本次修改的配置快照追加到版本历史（旧版本永不删除）
    const updated = db.prepare('SELECT * FROM system_config WHERE id = 1').get();
    db.prepare(`
      INSERT INTO system_config_versions
        (target_hosts, connect_timeout, request_timeout, proxy_classifier)
      VALUES (?, ?, ?, ?)
    `).run(
      updated.target_hosts,
      updated.connect_timeout, updated.request_timeout,
      updated.proxy_classifier,
    );

    ok(res, { updated: true });
  } catch (e) {
    err(res, e.message, 500);
  }
});

module.exports = router;
