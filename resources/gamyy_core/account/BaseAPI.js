'use strict';

const HttpClient = require('./HttpClient');
const C = require('./constants');

class BaseAPI {
  constructor(session, config = {}) {
    this.session = session;
    this.config  = config;
    this.baseURL = C.BASE_URL;
    this.timeout = config.timeout || C.TIMEOUT;
    this.url     = null;
  }

  async request(url, options = {}) {
    const start = Date.now();
    const requestTime = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    let timerId;

    const plainBody = options._plainRequestBody ?? null;
    let headers = null;

    try {
      const agent = options._externalProxyAgent || this.session.getAgent();
      headers = this.calculateContentLength(this.buildHeaders(options), options);

      let signal = options.signal;
      if (!signal) {
        const ctrl = new AbortController();
        signal = ctrl.signal;
        timerId = setTimeout(() => ctrl.abort(), this.timeout);
      }

      const reqOptions = { ...options, headers, agent, signal, timeout: this.timeout };
      delete reqOptions._externalProxyAgent;
      delete reqOptions._plainRequestBody;

      const response = await HttpClient.request(url, reqOptions);
      if (timerId) clearTimeout(timerId);

      const buf = await response.buffer();
      const result = await this.processResponse(response, buf, {});

      const dur = Date.now() - start;
      const proxy = this.session.currentProxy;
      const proxyStr = !proxy || proxy.type === 'direct' ? 'direct' : `${proxy.host}:${proxy.port}`;
      const path = new URL(url).pathname;
      this.session._log(`${path} [${proxyStr}] ${dur}ms`);

      this.session.onRequestLog?.({
        accountId:         this.session.account?.id,
        requestUrl:        url,
        requestMethod:     options.method || 'GET',
        requestBodyPlain:  plainBody ?? (typeof options.body === 'string' ? options.body : null),
        responseDataPlain: result != null ? JSON.stringify(result) : null,
        durationMs:        dur,
        proxyHost:         proxy?.host,
        proxyPort:         proxy?.port,
        isSuccess:         true,
        requestTime,
        requestHeaders:    headers,
        responseHeaders:   response.headers.raw(),
      });

      return result;
    } catch (e) {
      if (timerId) clearTimeout(timerId);

      this.session.onRequestLog?.({
        accountId:        this.session.account?.id,
        requestUrl:       url,
        requestMethod:    options.method || 'GET',
        requestBodyPlain: plainBody ?? (typeof options.body === 'string' ? options.body : null),
        durationMs:       Date.now() - start,
        proxyHost:        this.session.currentProxy?.host,
        proxyPort:        this.session.currentProxy?.port,
        isSuccess:        false,
        errorMessage:     e.message,
        requestTime,
        requestHeaders:   headers,
      });

      if (e.message === 'Request aborted') throw new Error('REQUEST_CANCELLED');
      throw e;
    }
  }

  calculateContentLength(headers, options = {}) {
    const h = { ...headers };
    if ('Content-Length' in h) {
      let len = 0;
      if (options.body) {
        if (typeof options.body === 'string')      len = Buffer.byteLength(options.body, 'utf8');
        else if (Buffer.isBuffer(options.body))    len = options.body.length;
        else                                       len = Buffer.byteLength(JSON.stringify(options.body), 'utf8');
      }
      h['Content-Length'] = String(len);
    }
    return h;
  }

  async processResponse(response, buf, logData) {
    this.updateSessionFromResponse(response);
    return buf.toString('utf8');
  }

  updateSessionFromResponse(_response) {}

  buildHeaders(_options) {
    throw new Error('buildHeaders must be implemented by subclass');
  }
}

module.exports = BaseAPI;
