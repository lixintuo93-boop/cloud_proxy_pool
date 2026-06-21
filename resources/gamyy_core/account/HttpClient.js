'use strict';

const https = require('https');
const zlib  = require('zlib');
// 指纹 sidecar 客户端（与 services/connectionChannel 共用）。设了 FP_SIDECAR_ADDR 才走 sidecar。
const sidecar = require('../services/sidecarClient');

class HttpClient {
  static async request(url, options = {}) {
    if (sidecar.SIDECAR_ADDR) return HttpClient._requestViaSidecar(url, options);
    return HttpClient._requestDirect(url, options);
  }

  // ── 原生路径（未启用 sidecar 时，与历史行为完全一致）──────────────
  static async _requestDirect(url, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      if (urlObj.protocol !== 'https:') return reject(new Error('只支持HTTPS请求'));
      // options.agent === null 表示直连模式，不需要 SOCKS 代理
      if (options.agent != null && !options.agent.keepAliveAgent) return reject(new Error('无效的代理agent'));

      const reqOpts = {
        hostname: urlObj.hostname,
        port:     urlObj.port || 443,
        path:     urlObj.pathname + urlObj.search,
        method:   options.method || 'GET',
        headers:  { ...options.headers, 'Accept-Encoding': 'gzip, deflate, br' },
        timeout:  options.timeout || 30000,
        rejectUnauthorized: false,
        agent:    options.agent ? options.agent.keepAliveAgent : undefined
      };

      const req = https.request(reqOpts, (res) => {
        HttpClient._handleResponse(res, resolve, reject, { signal: options.signal, timeout: options.timeout });
      });

      HttpClient._wireRequest(req, options, resolve, reject);
    });
  }

  // ── sidecar 路径：明文 HTTP 经 CONNECT 隧道，TLS 指纹由 sidecar 施加 ──
  // 隧道内手动收发 HTTP/1.1（强制 Connection: close 读到 EOF），不走 Node http.request——
  // 后者接管外部已连接 socket 时行为异常（会导致 ECONNRESET），手动收发经端到端验证稳定。
  static async _requestViaSidecar(url, options = {}) {
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'https:') throw new Error('只支持HTTPS请求');

    const targetHost = urlObj.hostname;
    const targetPort = urlObj.port || 443;

    // 上游 SOCKS5：从 ProxyAgentWrapper.proxyConfig 取（direct/无代理 → 空）
    const proxyConfig = (options.agent && options.agent.proxyConfig) || null;
    const upstream = sidecar.buildSocksUrl(proxyConfig);

    // 指纹：代理层 cfg.fingerprint 优先；否则 options.fingerprint；最终回退默认 android_app
    const fpSource = proxyConfig?.cfg?.fingerprint || proxyConfig?.fingerprint || options.fingerprint || null;
    const fpHeader = sidecar.buildFingerprintHeader(fpSource, targetHost);

    const timeout = options.timeout || 30000;
    const sock = await sidecar.establishTunnel(`${targetHost}:${targetPort}`, fpHeader, upstream, timeout);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const timer = setTimeout(() => { sock.destroy(); finish(reject, new Error('Response timeout')); }, timeout);

      if (options.signal) {
        const onAbort = () => { sock.destroy(); finish(reject, new Error('Request aborted')); };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort);
      }

      // 组装请求头：透传调用方 headers，补 Host / Accept-Encoding，强制 Connection: close
      const h = { ...options.headers };
      const has = (k) => Object.keys(h).some(x => x.toLowerCase() === k);
      if (!has('host')) h['Host'] = targetHost;
      h['Accept-Encoding'] = 'gzip, deflate, br';
      // 删除任何已存在的 Connection 头后强制 close
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'connection') delete h[k];
      h['Connection'] = 'close';

      const method = options.method || 'GET';
      const reqPath = urlObj.pathname + urlObj.search;
      let head = `${method} ${reqPath} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(h)) head += `${k}: ${v}\r\n`;
      head += '\r\n';

      sock.write(head);
      if (options.body) sock.write(typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body);

      const chunks = [];
      sock.on('data', (d) => chunks.push(d));
      sock.on('error', (e) => { clearTimeout(timer); finish(reject, new Error(
        (e.code === 'ECONNRESET' || e.message === 'Request aborted') ? 'Request aborted' : e.message
      )); });
      sock.on('end', () => {
        clearTimeout(timer);
        if (settled) return;
        try {
          const parsed = HttpClient._parseRawResponse(Buffer.concat(chunks));
          HttpClient._decompress(parsed.body, parsed.headers['content-encoding']).then((decompressed) => {
            finish(resolve, {
              status: parsed.status,
              ok:     parsed.status >= 200 && parsed.status < 300,
              headers: { get: (n) => parsed.headers[n.toLowerCase()], raw: () => parsed.headers },
              buffer: async () => decompressed,
            });
          }).catch((e) => finish(reject, e));
        } catch (e) { finish(reject, e); }
      });
    });
  }

  // 解析裸 HTTP/1.1 响应（Connection: close → 读到 EOF）。处理 chunked 传输编码。
  static _parseRawResponse(buf) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) throw new Error('响应不完整(无头部分隔)');
    const headerText = buf.slice(0, sep).toString('utf8');
    let body = buf.slice(sep + 4);

    const lines = headerText.split('\r\n');
    const statusLine = lines.shift() || '';
    const status = parseInt(statusLine.split(/\s+/)[1], 10) || 0;

    const headers = {};
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }

    if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
      body = HttpClient._dechunk(body);
    }
    return { status, headers, body };
  }

  static _dechunk(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
      const nl = buf.indexOf('\r\n', i);
      if (nl < 0) break;
      const size = parseInt(buf.slice(i, nl).toString('ascii').trim(), 16);
      if (!Number.isFinite(size) || size <= 0) break;
      const start = nl + 2;
      out.push(buf.slice(start, start + size));
      i = start + size + 2; // 跳过数据 + 结尾 \r\n
    }
    return Buffer.concat(out);
  }

  // 公共：把 signal/body/error/timeout 绑到一个 ClientRequest 上（两条路径共用）。
  static _wireRequest(req, options, resolve, reject) {
    if (options.signal) {
      const onAbort = () => { req.destroy(); reject(new Error('Request aborted')); };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort);
    }

    req.on('error', (e) => reject(new Error(
      (e.code === 'ECONNRESET' || e.message === 'Request aborted') ? 'Request aborted' : e.message
    )));

    req.on('timeout', () => { req.destroy(); reject(new Error('SOCKS代理请求超时')); });

    if (options.body) {
      req.write(typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body);
    }
    req.end();
  }

  static _handleResponse(res, resolve, reject, opts = {}) {
    const chunks = [];
    const encoding = res.headers['content-encoding'];
    let timer;

    if (opts.timeout) {
      timer = setTimeout(() => { if (!res.destroyed) { res.destroy(); reject(new Error('Response timeout')); } }, opts.timeout);
    }

    res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

    res.on('end', () => {
      if (timer) clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      HttpClient._decompress(buf, encoding).then(decompressed => {
        resolve({
          status: res.statusCode,
          ok:     res.statusCode >= 200 && res.statusCode < 300,
          headers: {
            get: (name) => res.headers[name.toLowerCase()],
            raw: () => res.headers
          },
          buffer: async () => decompressed
        });
      }).catch(reject);
    });

    res.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
  }

  static _decompress(buf, encoding) {
    return new Promise((resolve, reject) => {
      const cb = (e, r) => e ? reject(e) : resolve(r);
      if (!encoding)           return resolve(buf);
      if (encoding === 'gzip')    return zlib.gunzip(buf, cb);
      if (encoding === 'deflate') return zlib.inflate(buf, cb);
      if (encoding === 'br')      return zlib.brotliDecompress(buf, cb);
      resolve(buf);
    });
  }
}

module.exports = HttpClient;
