'use strict';

// ============================================================================
// fp-sidecar 客户端（account/HttpClient 与 services/connectionChannel 共用）
// ----------------------------------------------------------------------------
// 经本地 fp-sidecar 的 CONNECT 隧道出网：sidecar 用指定 TLS 指纹(uTLS)对目标握手，
// 调用方在隧道里走明文 HTTP（sidecar 负责加解密）。
// 开关：环境变量 FP_SIDECAR_ADDR（如 127.0.0.1:8788）。未设则 SIDECAR_ADDR=null，调用方走原生路径。
// ============================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const { resolveFingerprint } = require('./fingerprints');

const SIDECAR_ADDR = process.env.FP_SIDECAR_ADDR || null;

// raw 模式 ClientHello hex 文件缓存（相对项目根，services/.. = 根）
const _rawHexCache = new Map();
function loadRawHex(ref) {
  if (_rawHexCache.has(ref)) return _rawHexCache.get(ref);
  const abs = path.join(__dirname, '..', ref);
  const hex = fs.readFileSync(abs, 'utf8')
    .split('\n').filter(l => l && !l.trimStart().startsWith('#')).join('').replace(/\s+/g, '');
  _rawHexCache.set(ref, hex);
  return hex;
}

// 把代理层指纹配置（{name} 或内联）解析并构造 sidecar 的 X-Fingerprint 头（base64 JSON）。
// sni: 可选 SNI 覆盖（connectionChannel 用 this.sni；缺省 sidecar 用 CONNECT 目标 host）。
function buildFingerprintHeader(fpSource, sni = null) {
  const fp = resolveFingerprint(fpSource);
  let spec;
  if (fp && fp.mode === 'raw' && fp.rawClientHelloRef) {
    spec = { mode: 'raw', rawHex: loadRawHex(fp.rawClientHelloRef), alpn: fp.alpn };
  } else {
    spec = { mode: 'preset', clientHello: fp?.clientHello || 'HelloChrome_Auto', alpn: fp?.alpn };
  }
  if (sni) spec.serverName = sni;
  return Buffer.from(JSON.stringify(spec)).toString('base64');
}

// 从代理配置构造上游 socks5 URL（兼容 username/userId 字段）。直连/无代理返回 ''。
function buildSocksUrl(pc) {
  if (!pc || pc.type === 'direct' || pc.proxyType === 'direct' || !pc.host) return '';
  const user = pc.username || pc.userId;
  const pass = pc.password;
  let url = 'socks5://';
  if (user && pass) url += `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
  url += `${pc.host}:${pc.port}`;
  return url;
}

// CONNECT 到 sidecar，建立隧道，返回握手成功(200)后的明文 socket（paused，调用方接管读）。
function establishTunnel(target, fpHeaderB64, upstream, timeout) {
  return new Promise((resolve, reject) => {
    const ci = SIDECAR_ADDR.lastIndexOf(':');
    const shost = SIDECAR_ADDR.slice(0, ci);
    const sport = parseInt(SIDECAR_ADDR.slice(ci + 1), 10);
    const sock = net.connect(sport, shost);
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; sock.destroy(); reject(e); } };

    const onReadable = () => {
      let c;
      while ((c = sock.read()) !== null) {
        buf = Buffer.concat([buf, c]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) continue;
        sock.removeListener('readable', onReadable);
        const statusLine = buf.slice(0, idx).toString().split('\r\n')[0];
        if (!/ 200 /.test(statusLine)) return fail(new Error('sidecar隧道建立失败: ' + statusLine));
        const leftover = buf.slice(idx + 4);
        if (leftover.length) sock.unshift(leftover);
        settled = true;
        sock.setTimeout(0);
        return resolve(sock);
      }
    };

    sock.on('readable', onReadable);
    sock.on('error', fail);
    if (timeout) sock.setTimeout(timeout, () => fail(new Error('sidecar隧道超时')));
    sock.on('connect', () => {
      let head = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nX-Fingerprint: ${fpHeaderB64}\r\n`;
      if (upstream) head += `X-Upstream-Proxy: ${upstream}\r\n`;
      head += '\r\n';
      sock.write(head);
    });
  });
}

module.exports = { SIDECAR_ADDR, buildFingerprintHeader, buildSocksUrl, establishTunnel, loadRawHex };
