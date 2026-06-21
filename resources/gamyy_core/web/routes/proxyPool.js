'use strict';

const { Router } = require('express');
const Database   = require('better-sqlite3');
const axios      = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { spawn }  = require('child_process');
const path       = require('path');
const { getDb, ok, err, now } = require('./_helper');
const { isPort, isDatetime } = require('./_validate');

const router = Router();

const AFD_SCRIPT = path.join(__dirname, '../services/afd_query.py');

// ──────────── 内存任务队列（批量测试 / 批量AFD） ────────────
const jobs = new Map();
let _jobSeq = 0;
function newJob(type, total) {
  const id = `${++_jobSeq}_${Date.now()}`;
  const job = { id, type, total, done: 0, errors: 0, results: [], status: 'running', startedAt: now() };
  jobs.set(id, job);
  setTimeout(() => jobs.delete(id), 30 * 60 * 1000);
  return job;
}

// ──────────── 工具函数 ────────────

function parseProxy(row) {
  if (!row) return null;
  const ei = JSON.parse(row.extra_info || '{}');
  return {
    ...row,
    host:                    row.host || ei.ip || null,
    username:                row.username || ei.username  || null,
    password:                row.password || ei.password  || null,
    extra_info:              ei,
    channel_build_overrides: JSON.parse(row.channel_build_overrides || '{}'),
  };
}

function buildExtraInfo(p) {
  return JSON.stringify({
    ip:         p.host   || null,
    username:   p.username || null,
    password:   p.password || null,
    real_ip:    p.real_ip  || null,
    group_name: p.group_name || null,
  });
}

async function runConcurrent(items, fn, concurrency = 10) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const r = await Promise.allSettled(batch.map(fn));
    results.push(...r);
  }
  return results;
}

async function testStandardProxy(proxy) {
  if (!proxy.host || !proxy.port) {
    return { success: false, error: '代理 IP 或端口为空', responseTime: 0 };
  }
  const start = Date.now();
  try {
    const proxyConf = { host: proxy.host, port: Number(proxy.port) };
    if (proxy.username) proxyConf.auth = { username: proxy.username, password: proxy.password || '' };
    const resp = await axios.get(
      'http://ip-api.com/json/?fields=query,country,isp,mobile,proxy,hosting',
      { proxy: proxyConf, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const d = resp.data;
    return { success: true, realIp: d.query || null, responseTime: Date.now() - start, country: d.country || null, isp: d.isp || null };
  } catch (e) {
    return { success: false, error: e.message, responseTime: Date.now() - start };
  }
}

async function testDirectProxy() {
  const start = Date.now();
  try {
    const resp = await axios.get(
      'http://ip-api.com/json/?fields=query,country,isp,mobile,proxy,hosting',
      { proxy: false, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const d = resp.data;
    return { success: true, realIp: d.query || null, responseTime: Date.now() - start, country: d.country || null, isp: d.isp || null };
  } catch (e) {
    return { success: false, error: e.message, responseTime: Date.now() - start };
  }
}

async function testSshProxy(proxy) {
  // 仅云端代理（无本地端口）：改探活云端 Agent 替代 SOCKS5 测试
  if (!proxy.port) {
    if (!proxy.cloud_agent_url) {
      return { success: false, error: '无本地端口且未配置云端 Agent URL', responseTime: 0 };
    }
    const start = Date.now();
    const { probeAgent } = require('../services/cloudAgentClient');
    const online = await probeAgent(proxy.cloud_agent_url, 8000);
    return online
      ? { success: true, realIp: proxy.real_ip || null, responseTime: Date.now() - start, mode: 'cloud-agent-probe' }
      : { success: false, error: '云端 Agent 不可达', responseTime: Date.now() - start };
  }
  const start = Date.now();
  try {
    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${proxy.port}`);
    const resp = await axios.get(
      'http://ip-api.com/json/?fields=query,country,isp,mobile,proxy,hosting',
      { httpAgent: agent, httpsAgent: agent, proxy: false, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const d = resp.data;
    return { success: true, realIp: d.query || null, responseTime: Date.now() - start, country: d.country || null, isp: d.isp || null };
  } catch (e) {
    return { success: false, error: e.message, responseTime: Date.now() - start };
  }
}

function queryAFD(ip, proxyUrl = null) {
  return new Promise((resolve) => {
    const args = [AFD_SCRIPT, ip];
    if (proxyUrl) args.push(proxyUrl);
    const child = spawn('python', args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)); }
      catch (_) { resolve({ error: stderr.trim() || 'AFD script parse error', raw: stdout }); }
    });
    child.on('error', e => resolve({ error: e.message }));
    setTimeout(() => { try { child.kill(); } catch (_) {} }, 60000);
  });
}

// ──────────── 路由 ────────────

// GET /api/proxy-pool   ?page=1&limit=50&search=&group=&platform=&enabled=&working=&assigned=
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 50, search, group, platform, enabled, working, assigned, proxy_type } = req.query;
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

    let where = 'WHERE 1=1';
    const params = [];
    if (search)                { where += ' AND (p.host LIKE ? OR p.real_ip LIKE ? OR p.username LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (group)                 { where += ' AND p.group_name = ?';  params.push(group); }
    if (platform)              { where += ' AND p.platform = ?';    params.push(platform); }
    if (enabled !== undefined) { where += ' AND p.enabled = ?';     params.push(enabled === '1' ? 1 : 0); }
    if (working !== undefined) { where += ' AND p.is_working = ?';  params.push(working === '1' ? 1 : 0); }
    if (assigned === 'true')   { where += ' AND p.account_id IS NOT NULL'; }
    if (assigned === 'false')  { where += ' AND p.account_id IS NULL'; }
    if (proxy_type)            { where += ' AND p.proxy_type = ?'; params.push(proxy_type); }
    else                       { where += " AND p.proxy_type != 'ssh'"; }

    const total = db.prepare(`SELECT COUNT(*) AS n FROM proxies p ${where}`).get(...params).n;
    const rows  = db.prepare(
      `SELECT p.*, a.mobile AS account_mobile,
              CASE WHEN EXISTS (
                SELECT 1 FROM risk_flagged_ips rfi WHERE rfi.ip = p.real_ip OR rfi.ip = p.host
              ) THEN 1 ELSE 0 END AS is_risk_flagged
       FROM proxies p LEFT JOIN accounts a ON a.id = p.account_id
       ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`
    ).all(...params, Number(limit), offset);

    ok(res, { data: rows.map(parseProxy), total, page: Number(page), limit: Number(limit) });
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxy-pool/risk-ips  — 返回所有风控 IP 列表
router.get('/risk-ips', (_req, res) => {
  try {
    const rows = getDb().prepare('SELECT ip FROM risk_flagged_ips ORDER BY id DESC').all();
    ok(res, rows.map(r => r.ip));
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxy-pool/groups
router.get('/groups', (_req, res) => {
  try {
    const rows = getDb().prepare('SELECT DISTINCT group_name FROM proxies WHERE group_name IS NOT NULL ORDER BY group_name').all();
    ok(res, rows.map(r => r.group_name));
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxy-pool/stats  ?type=ssh|standard
router.get('/stats', (req, res) => {
  try {
    const db = getDb();
    const typeFilter = req.query.type ? 'WHERE proxy_type = ?' : "WHERE proxy_type != 'ssh'";
    const params = req.query.type ? [req.query.type] : [];
    const r = db.prepare(`
      SELECT
        COUNT(*)                                        AS total,
        SUM(enabled)                                    AS enabled_count,
        SUM(is_working)                                 AS working_count,
        SUM(CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned_count
      FROM proxies ${typeFilter}
    `).get(...params);
    ok(res, r);
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxy-pool/platforms
router.get('/platforms', (_req, res) => {
  try {
    const rows = getDb().prepare('SELECT DISTINCT platform FROM proxies WHERE platform IS NOT NULL ORDER BY platform').all();
    ok(res, rows.map(r => r.platform));
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool   — 添加标准代理
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    if (!b.host || !b.port) return err(res, 'host 和 port 必填');
    if (!isPort(b.port)) return err(res, 'port 范围应为 1-65535', 400);
    if (!isDatetime(b.expire_time)) return err(res, 'expire_time 格式不正确，应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS', 400);

    const ptype    = b.proxy_type || 'standard';
    const sourceId = `${b.host}:${b.port}${b.username ? ':' + b.username : ''}`;
    const result = db.prepare(`
      INSERT INTO proxies
        (source_id, proxy_type, host, port, group_name, platform,
         username, password, real_ip, expire_time, extra_info,
         enabled, is_working, synced_at, updated_at)
      VALUES
        (@source_id, @proxy_type, @host, @port, @group_name, @platform,
         @username, @password, @real_ip, @expire_time, @extra_info,
         1, 1, @now, @now)
      ON CONFLICT(source_id, proxy_type) DO UPDATE SET
        host = excluded.host, port = excluded.port,
        group_name = excluded.group_name, platform = excluded.platform,
        username = excluded.username, password = excluded.password,
        expire_time = excluded.expire_time, extra_info = excluded.extra_info,
        updated_at = excluded.updated_at
    `).run({
      source_id:   sourceId,
      proxy_type:  ptype,
      host:        b.host,
      port:        Number(b.port),
      group_name:  b.group_name || null,
      platform:    b.platform   || null,
      username:    b.username   || null,
      password:    b.password   || null,
      real_ip:     b.real_ip    || null,
      expire_time: b.expire_time|| null,
      extra_info:  buildExtraInfo(b),
      now: now(),
    });
    const rowId = result.lastInsertRowid || db.prepare('SELECT id FROM proxies WHERE source_id=? AND proxy_type=?').get(sourceId, ptype).id;
    ok(res, parseProxy(db.prepare('SELECT * FROM proxies WHERE id = ?').get(rowId)), 201);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, '该代理已存在');
    err(res, e.message, 500);
  }
});

// POST /api/proxy-pool/batch-import
router.post('/batch-import', (req, res) => {
  try {
    const db = getDb();
    const { text, group_name, platform, proxy_type } = req.body;
    if (!text) return err(res, 'text is required');

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let imported = 0, skipped = 0;
    const ptype = proxy_type || 'standard';
    const newSourceIds = [];

    const upsert = db.prepare(`
      INSERT INTO proxies
        (source_id, proxy_type, host, port, group_name, platform,
         username, password, expire_time, extra_info, enabled, is_working, synced_at, updated_at)
      VALUES
        (@source_id, @proxy_type, @host, @port, @group_name, @platform,
         @username, @password, @expire_time, @extra_info, 1, 1, @now, @now)
      ON CONFLICT(source_id, proxy_type) DO NOTHING
    `);

    db.transaction(() => {
      for (const line of lines) {
        const sep = line.includes('|') ? '|' : ':';
        const parts = line.split(sep).map(s => s.trim());
        if (parts.length < 2) { skipped++; continue; }
        const [host, port, username, password, expireTime] = parts;
        if (!host || !port || isNaN(Number(port))) { skipped++; continue; }
        const sourceId = `${host}:${port}${username ? ':' + username : ''}`;
        const p = { host, port: Number(port), username: username || null, password: password || null, group_name: group_name || null };
        const r = upsert.run({
          source_id:   sourceId,
          proxy_type:  ptype,
          host, port:  Number(port),
          group_name:  group_name || null,
          platform:    platform   || null,
          username:    username   || null,
          password:    password   || null,
          expire_time: expireTime || null,
          extra_info:  buildExtraInfo(p),
          now: now(),
        });
        if (r.changes > 0) { imported++; newSourceIds.push({ source_id: sourceId, proxy_type: ptype }); }
        else { skipped++; }
      }
    })();

    const ids = newSourceIds.map(({ source_id, proxy_type: pt }) =>
      db.prepare('SELECT id FROM proxies WHERE source_id=? AND proxy_type=?').get(source_id, pt)?.id
    ).filter(Boolean);

    ok(res, { imported, skipped, total: lines.length, ids });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/import-db
router.post('/import-db', (req, res) => {
  try {
    const { dbPath } = req.body;
    if (!dbPath) return err(res, 'dbPath is required');
    const extDb = new Database(dbPath, { readonly: true });
    const srcRows = extDb.prepare('SELECT * FROM proxies').all();
    extDb.close();

    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO proxies
        (source_id, proxy_type, host, port, group_name, platform,
         username, password, real_ip, expire_time, extra_info,
         is_working, response_time, last_tested_at,
         ip_risk_level, ip_location, ip_isp, ip_scene,
         enabled, synced_at, updated_at)
      VALUES
        (@source_id, @proxy_type, @host, @port, @group_name, @platform,
         @username, @password, @real_ip, @expire_time, @extra_info,
         @is_working, @response_time, @last_tested_at,
         @ip_risk_level, @ip_location, @ip_isp, @ip_scene,
         1, @now, @now)
      ON CONFLICT(source_id, proxy_type) DO UPDATE SET
        host = excluded.host, port = excluded.port,
        group_name = excluded.group_name, platform = excluded.platform,
        username = excluded.username, password = excluded.password,
        real_ip = excluded.real_ip, expire_time = excluded.expire_time,
        extra_info = excluded.extra_info,
        is_working = excluded.is_working, response_time = excluded.response_time,
        last_tested_at = excluded.last_tested_at,
        ip_risk_level = excluded.ip_risk_level, ip_location = excluded.ip_location,
        ip_isp = excluded.ip_isp, ip_scene = excluded.ip_scene,
        updated_at = excluded.updated_at
    `);

    let imported = 0;
    db.transaction(() => {
      for (const r of srcRows) {
        const host = r.host || r.ip || null;
        const p = { host, port: r.port, username: r.username, password: r.password, real_ip: r.real_ip, group_name: r.group_name };
        upsert.run({
          source_id:     String(r.id || r.proxy_id),
          proxy_type:    'standard',
          host,
          port:          r.port,
          group_name:    r.group_name ? String(r.group_name) : null,
          platform:      r.platform   || null,
          username:      r.username   || null,
          password:      r.password   || null,
          real_ip:       r.real_ip    || null,
          expire_time:   r.expire_time|| null,
          extra_info:    buildExtraInfo(p),
          is_working:    r.is_working  != null ? r.is_working  : 1,
          response_time: r.response_time || null,
          last_tested_at:r.last_tested_at|| null,
          ip_risk_level: r.ip_risk_level || null,
          ip_location:   r.ip_location   || null,
          ip_isp:        r.ip_isp        || null,
          ip_scene:      r.ip_scene      || null,
          now: now(),
        });
        imported++;
      }
    })();

    ok(res, { imported, total: srcRows.length });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/batch-check-agents  — 批量探活云端 Agent
router.post('/batch-check-agents', async (req, res) => {
  try {
    const db = getDb();
    const { ids } = req.body || {};
    let rows;
    if (ids && ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      rows = db.prepare(`SELECT id, port, real_ip, cloud_agent_url FROM proxies WHERE id IN (${ph}) AND cloud_agent_url IS NOT NULL`).all(...ids);
    } else {
      rows = db.prepare("SELECT id, port, real_ip, cloud_agent_url FROM proxies WHERE proxy_type = 'ssh' AND cloud_agent_url IS NOT NULL").all();
    }
    if (rows.length === 0) return ok(res, []);
    const { probeAgent } = require('../services/cloudAgentClient');
    const results = await Promise.all(rows.map(async (row) => {
      const start = Date.now();
      const online = await probeAgent(row.cloud_agent_url, 5000);
      return { id: row.id, port: row.port, real_ip: row.real_ip || null, cloud_agent_url: row.cloud_agent_url, ok: online, latencyMs: online ? Date.now() - start : null };
    }));
    ok(res, results);
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/auto-fill-agent-urls
// 将所有 real_ip 不为空且 cloud_agent_url 为空的 SSH 代理自动填充 http://<real_ip>:7070
router.post('/auto-fill-agent-urls', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, real_ip FROM proxies
       WHERE proxy_type = 'ssh'
         AND real_ip IS NOT NULL AND real_ip != ''
         AND (cloud_agent_url IS NULL OR cloud_agent_url = '')`
    ).all();
    const stmt = db.prepare(`UPDATE proxies SET cloud_agent_url = ? WHERE id = ?`);
    const update = db.transaction(() => {
      for (const row of rows) {
        stmt.run(`http://${row.real_ip}:7070`, row.id);
      }
    });
    update();
    ok(res, { updated: rows.length });
  } catch (e) { err(res, e.message, 500); }
});

// PUT /api/proxy-pool/:id
router.put('/:id', (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const p = db.prepare('SELECT * FROM proxies WHERE id = ?').get(req.params.id);
    if (!p) return err(res, '代理不存在', 404);

    if (b.port !== undefined && !isPort(b.port)) return err(res, 'port 范围应为 1-65535', 400);
    if (b.expire_time !== undefined && !isDatetime(b.expire_time)) return err(res, 'expire_time 格式不正确，应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS', 400);
    db.prepare(`
      UPDATE proxies SET
        host = COALESCE(@host, host), port = COALESCE(@port, port),
        group_name = COALESCE(@group_name, group_name),
        platform = COALESCE(@platform, platform),
        username = @username, password = @password,
        expire_time = @expire_time, extra_info = @extra_info, updated_at = @now
      WHERE id = @id
    `).run({
      id:          req.params.id,
      host:        b.host        || null,
      port:        b.port        ? Number(b.port) : null,
      group_name:  b.group_name  !== undefined ? (b.group_name  || null) : null,
      platform:    b.platform    !== undefined ? (b.platform    || null) : null,
      username:    b.username    !== undefined ? (b.username    || null) : null,
      password:    b.password    !== undefined ? (b.password    || null) : null,
      expire_time: b.expire_time !== undefined ? (b.expire_time || null) : null,
      extra_info:  buildExtraInfo({ ...p, ...b }),
      now: now(),
    });
    ok(res, parseProxy(db.prepare('SELECT * FROM proxies WHERE id = ?').get(req.params.id)));
  } catch (e) { err(res, e.message, 500); }
});

// PATCH /api/proxy-pool/:id/cloud-agent  — 设置或清除云端 Agent URL
router.patch('/:id/cloud-agent', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM proxies WHERE id = ?').get(req.params.id)) return err(res, '代理不存在', 404);
    const url = req.body.cloud_agent_url || null;
    db.prepare('UPDATE proxies SET cloud_agent_url = ?, updated_at = ? WHERE id = ?').run(url, now(), req.params.id);
    ok(res, { cloud_agent_url: url });
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxy-pool/:id/cloud-agent/health  — 检测云端 Agent 是否在线
router.get('/:id/cloud-agent/health', async (req, res) => {
  try {
    const db = getDb();
    const p = db.prepare('SELECT cloud_agent_url FROM proxies WHERE id = ?').get(req.params.id);
    if (!p) return err(res, '代理不存在', 404);
    if (!p.cloud_agent_url) return err(res, '该代理未配置 cloud_agent_url', 400);

    const { checkHealth } = require('../services/cloudAgentClient');
    const start = Date.now();
    const data = await checkHealth(p.cloud_agent_url);
    ok(res, { ...data, latencyMs: Date.now() - start });
  } catch (e) { err(res, e.message.includes('ECONNREFUSED') || e.message.includes('timeout') ? '连接失败' : e.message, 502); }
});

// DELETE /api/proxy-pool/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!db.prepare('SELECT id FROM proxies WHERE id = ?').get(req.params.id)) return err(res, '代理不存在', 404);
    db.prepare('DELETE FROM proxies WHERE id = ?').run(req.params.id);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/batch-ops
router.post('/batch-ops', (req, res) => {
  try {
    const { action, ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return err(res, 'ids array is required');
    const db = getDb();
    const opsUnbindAccountIds = [];
    db.transaction(() => {
      for (const id of ids) {
        if (action === 'delete')      db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
        if (action === 'enable')      db.prepare('UPDATE proxies SET enabled = 1, updated_at = ? WHERE id = ?').run(now(), id);
        if (action === 'disable')     db.prepare('UPDATE proxies SET enabled = 0, account_id = NULL, updated_at = ? WHERE id = ?').run(now(), id);
        if (action === 'ops_enable')  db.prepare('UPDATE proxies SET ops_enabled = 1, updated_at = ? WHERE id = ?').run(now(), id);
        if (action === 'ops_disable') {
          const affected = db.prepare('SELECT id FROM accounts WHERE ops_proxy_id = ?').all(id);
          db.prepare('UPDATE proxies SET ops_enabled = 0, updated_at = ? WHERE id = ?').run(now(), id);
          if (affected.length) {
            db.prepare('UPDATE accounts SET ops_proxy_id = NULL, updated_at = ? WHERE ops_proxy_id = ?').run(now(), id);
            for (const a of affected) opsUnbindAccountIds.push(a.id);
          }
        }
      }
    })();
    if (opsUnbindAccountIds.length && typeof req.broadcast === 'function') {
      req.broadcast('proxy-assignment-changed', { accountIds: opsUnbindAccountIds });
    }
    ok(res, { affected: ids.length, action });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/:id/test
router.post('/:id/test', async (req, res) => {
  try {
    const db = getDb();
    const p = db.prepare('SELECT * FROM proxies WHERE id = ?').get(req.params.id);
    if (!p) return err(res, '代理不存在', 404);

    const proxy = parseProxy(p);
    const result = proxy.proxy_type === 'direct'
      ? await testDirectProxy()
      : proxy.proxy_type === 'ssh'
        ? await testSshProxy(proxy)
        : await testStandardProxy(proxy);

    db.prepare(`
      UPDATE proxies SET
        is_working = ?, real_ip = ?, response_time = ?, last_tested_at = ?,
        extra_info = ?, updated_at = ?
      WHERE id = ?
    `).run(
      result.success ? 1 : 0,
      result.realIp || p.real_ip,
      result.responseTime,
      now(),
      buildExtraInfo({ ...proxy, real_ip: result.realIp || proxy.real_ip || proxy.extra_info.real_ip }),
      now(),
      p.id,
    );

    ok(res, { ...result, proxyId: p.id });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/batch-test
router.post('/batch-test', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return err(res, 'ids array is required');
    const db = getDb();
    const job = newJob('test', ids.length);
    ok(res, { jobId: job.id, total: job.total });

    const proxies = ids.map(id => db.prepare('SELECT * FROM proxies WHERE id = ?').get(id)).filter(Boolean).map(parseProxy);
    runConcurrent(proxies, async (proxy) => {
      const result = proxy.proxy_type === 'direct'
        ? await testDirectProxy()
        : proxy.proxy_type === 'ssh'
          ? await testSshProxy(proxy)
          : await testStandardProxy(proxy);
      db.prepare(`UPDATE proxies SET is_working=?, real_ip=?, response_time=?, last_tested_at=?, extra_info=?, updated_at=? WHERE id=?`).run(
        result.success ? 1 : 0, result.realIp || proxy.real_ip, result.responseTime, now(),
        buildExtraInfo({ ...proxy, real_ip: result.realIp || proxy.real_ip }),
        now(), proxy.id,
      );
      job.done++;
      job.results.push({ id: proxy.id, ...result });
      if (!result.success) job.errors++;
    }, 10).then(() => { job.status = 'done'; });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/:id/afd
router.post('/:id/afd', async (req, res) => {
  try {
    const db = getDb();
    const p = db.prepare('SELECT * FROM proxies WHERE id = ?').get(req.params.id);
    if (!p) return err(res, '代理不存在', 404);
    const proxy = parseProxy(p);

    const targetIp = proxy.real_ip || proxy.extra_info.real_ip || proxy.host;
    let proxyUrl = null;
    const useProxy = req.body.useProxy !== false;
    if (useProxy) {
      if (proxy.proxy_type === 'ssh') {
        // 仅云端代理无本地端口：AFD 查 IP 属性与出口无关，直接走直连
        if (proxy.port) proxyUrl = `socks5://127.0.0.1:${proxy.port}`;
      } else if (proxy.host && proxy.username) {
        proxyUrl = `http://${proxy.username}:${proxy.password || ''}@${proxy.host}:${proxy.port}`;
      }
    }

    const result = await queryAFD(targetIp, proxyUrl);
    if (!result.error) {
      db.prepare(`UPDATE proxies SET ip_risk_level=?, ip_location=?, ip_isp=?, ip_scene=?, updated_at=? WHERE id=?`)
        .run(result.risk_level || null, result.location || null, result.isp || null, result.scene || null, now(), p.id);
    }

    ok(res, { ...result, proxyId: p.id, targetIp });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/batch-afd
router.post('/batch-afd', async (req, res) => {
  try {
    const { ids, useProxy = true } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return err(res, 'ids array is required');
    const db = getDb();
    const job = newJob('afd', ids.length);
    ok(res, { jobId: job.id, total: job.total });

    const items = ids.map(id => {
      const p = db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
      return { id, proxy: p ? parseProxy(p) : null };
    });
    runConcurrent(items, async ({ id, proxy }) => {
      if (!proxy) { job.done++; job.errors++; return; }
      const targetIp = proxy.real_ip || proxy.extra_info.real_ip || proxy.host;
      let proxyUrl = null;
      if (useProxy) {
        if (proxy.proxy_type === 'ssh') {
          if (proxy.port) proxyUrl = `socks5://127.0.0.1:${proxy.port}`;
        } else if (proxy.host && proxy.username) {
          proxyUrl = `http://${proxy.username}:${proxy.password || ''}@${proxy.host}:${proxy.port}`;
        }
      }
      const result = await queryAFD(targetIp, proxyUrl);
      if (!result.error) {
        db.prepare(`UPDATE proxies SET ip_risk_level=?, ip_location=?, ip_isp=?, ip_scene=?, updated_at=? WHERE id=?`)
          .run(result.risk_level || null, result.location || null, result.isp || null, result.scene || null, now(), proxy.id);
      }
      job.done++;
      job.results.push({ id, targetIp, ...result });
      if (result.error) job.errors++;
    }, 25).then(() => { job.status = 'done'; });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/add-direct  — 探测本机公网 IP 并 upsert 直连代理条目
router.post('/add-direct', async (req, res) => {
  try {
    const result = await testDirectProxy();
    const db = getDb();
    db.prepare(`
      INSERT INTO proxies
        (source_id, proxy_type, host, port, real_ip,
         is_working, response_time, last_tested_at, enabled, synced_at, updated_at)
      VALUES
        ('direct:local', 'direct', NULL, NULL, @real_ip,
         @is_working, @response_time, @now, 1, @now, @now)
      ON CONFLICT(source_id, proxy_type) DO UPDATE SET
        real_ip        = excluded.real_ip,
        is_working     = excluded.is_working,
        response_time  = excluded.response_time,
        last_tested_at = excluded.last_tested_at,
        updated_at     = excluded.updated_at
    `).run({
      real_ip:       result.realIp || null,
      is_working:    result.success ? 1 : 0,
      response_time: result.responseTime,
      now:           now(),
    });
    const row = db.prepare("SELECT * FROM proxies WHERE source_id='direct:local' AND proxy_type='direct'").get();
    ok(res, parseProxy(row));
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/ssh-sync  — 从 cloud_proxy_pool 的 proxy_manager.db 同步活跃 SSH 代理
router.post('/ssh-sync', (req, res) => {
  try {
    const { dbPath } = req.body;
    if (!dbPath) return err(res, 'dbPath is required');

    let srcDb;
    try { srcDb = new Database(dbPath, { readonly: true }); }
    catch (e) { return err(res, `无法打开数据库：${e.message}`, 400); }

    let rows;
    try {
      rows = srcDb.prepare(`
        SELECT p.id AS proxy_id, p.port, p.group_name, p.name AS proxy_name,
               s.server_host, s.server_port AS ssh_port, s.name AS server_name,
               s.username AS ssh_username, s.password AS ssh_password
        FROM proxies p
        JOIN ssh_servers s ON s.id = p.ssh_server_id
        WHERE p.is_active = 1
      `).all();
    } catch (e) {
      srcDb.close();
      return err(res, `读取数据库失败（表结构不匹配）：${e.message}`, 400);
    }
    srcDb.close();

    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO proxies
        (source_id, proxy_type, host, port, group_name, real_ip, username, password,
         extra_info, enabled, is_working, synced_at, updated_at)
      VALUES
        (@source_id, 'ssh', '127.0.0.1', @port, @group_name, @real_ip, @username, @password,
         @extra_info, 1, 1, @now, @now)
      ON CONFLICT(source_id, proxy_type) DO UPDATE SET
        port       = excluded.port,
        group_name = excluded.group_name,
        real_ip    = excluded.real_ip,
        username   = excluded.username,
        password   = excluded.password,
        extra_info = excluded.extra_info,
        synced_at  = excluded.synced_at,
        updated_at = excluded.updated_at
    `);

    let inserted = 0, updated = 0;
    db.transaction(() => {
      for (const r of rows) {
        const sourceId = `ssh:${r.server_host}:${r.port}`;
        const existing = db.prepare("SELECT id FROM proxies WHERE source_id=? AND proxy_type='ssh'").get(sourceId);
        upsert.run({
          source_id:  sourceId,
          port:       r.port,
          group_name: r.group_name ? String(r.group_name) : null,
          real_ip:    r.server_host,
          username:   r.ssh_username || null,
          password:   r.ssh_password || null,
          extra_info: JSON.stringify({
            ssh_server_name: r.server_name  || null,
            ssh_server_host: r.server_host,
            ssh_port:        r.ssh_port     || 22,
            proxy_name:      r.proxy_name   || null,
          }),
          now: now(),
        });
        if (existing) updated++; else inserted++;
      }
    })();

    ok(res, { inserted, updated, total: rows.length });
  } catch (e) { err(res, e.message, 500); }
});

// POST /api/proxy-pool/ssh-batch-import  — 手动批量导入 SSH 代理
// body: { text, group_name?, platform? }
// 每行格式："IP" 或 "IP:port" 或 "IP|port"，允许混合。仅 IP 表示该代理仅在云端运行，
// 无本地 SOCKS5 端口；IP+port 表示同时具备本地隧道转发。
// 唯一键：proxy_type='ssh' AND real_ip = ?（与 ssh-sync 的 source_id 格式无关，按 real_ip 去重）
router.post('/ssh-batch-import', (req, res) => {
  try {
    const db = getDb();
    const { text, group_name, platform } = req.body;
    if (!text || !text.trim()) return err(res, 'text is required');

    const lines = text.split('\n').map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
    const ipRe = /^\d{1,3}(\.\d{1,3}){3}$/;

    const errors = [];
    let inserted = 0, updated = 0, skipped = 0;

    const findByRealIp = db.prepare("SELECT id FROM proxies WHERE proxy_type='ssh' AND real_ip = ?");
    const updateById = db.prepare(`
      UPDATE proxies SET
        host            = @host,
        port            = @port,
        group_name      = COALESCE(@group_name, group_name),
        platform        = COALESCE(@platform, platform),
        cloud_agent_url = @cloud_agent_url,
        extra_info      = @extra_info,
        enabled         = 1,
        synced_at       = @now,
        updated_at      = @now
      WHERE id = @id
    `);
    const insertNew = db.prepare(`
      INSERT INTO proxies
        (source_id, proxy_type, host, port, group_name, platform,
         real_ip, cloud_agent_url, extra_info,
         enabled, is_working, synced_at, updated_at)
      VALUES
        (@source_id, 'ssh', @host, @port, @group_name, @platform,
         @real_ip, @cloud_agent_url, @extra_info,
         1, 1, @now, @now)
    `);

    db.transaction(() => {
      for (const raw of lines) {
        const parts = raw.split(/[:|\s]+/).map(s => s.trim()).filter(Boolean);
        const ip = parts[0];
        const portRaw = parts[1];

        if (!ip || !ipRe.test(ip)) {
          errors.push({ line: raw, reason: 'IP 格式不合法' });
          skipped++;
          continue;
        }
        let port = null;
        if (portRaw !== undefined) {
          const n = Number(portRaw);
          if (!Number.isInteger(n) || n < 1 || n > 65535) {
            errors.push({ line: raw, reason: '端口需为 1-65535 的整数' });
            skipped++;
            continue;
          }
          port = n;
        }

        const row = {
          source_id:       `ssh:${ip}:${port == null ? '-' : port}`,
          host:            port == null ? null : '127.0.0.1',
          port,
          group_name:      group_name || null,
          platform:        platform || null,
          real_ip:         ip,
          cloud_agent_url: `http://${ip}:7070`,
          extra_info:      JSON.stringify({ ip, real_ip: ip, source: 'manual-batch' }),
          now:             now(),
        };

        const existing = findByRealIp.get(ip);
        if (existing) {
          updateById.run({ ...row, id: existing.id });
          updated++;
        } else {
          insertNew.run(row);
          inserted++;
        }
      }
    })();

    ok(res, { inserted, updated, skipped, total: lines.length, errors });
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxy-pool/jobs/:jobId
router.get('/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return err(res, '任务不存在或已过期', 404);
  ok(res, job);
});

module.exports = router;
