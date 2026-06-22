'use strict';

const https = require('https');
const zlib  = require('zlib');

class HttpClient {
  static async request(url, options = {}) {
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
    });
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
