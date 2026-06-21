// models/RequestLog.js
class RequestLog {
  constructor(accountId, proxyInfo, mobile, requestData, channelId, requestIndex) {
    this.id = Date.now() + Math.random().toString(36).substr(2, 9);
    this.accountId = accountId;
    this.mobile = mobile;
    this.proxyInfo = proxyInfo;
    this.channelId = channelId;
    this.requestIndex = requestIndex;
    this.startTime = Date.now();
    this.endTime = null;
    this.statusCode = null;
    this.requestData = requestData;
    this.requestHeaders = null; // 🆕 新增：请求头信息
    this.responseData = null;
    this.responseHeaders = null; // 返回头信息
    this.error = null;
    this.submitSign = null;
  }

  // 修改 complete 方法，新增 requestHeaders 参数
  complete(statusCode, responseData, error = null, submitSign = null, responseHeaders = null, requestHeaders = null) {
    this.endTime = Date.now();
    this.statusCode = statusCode;
    this.responseData = responseData;
    this.responseHeaders = responseHeaders;
    this.requestHeaders = requestHeaders; // 🆕 保存请求头
    this.error = error;
    this.submitSign = submitSign;
    
  }

  toDatabaseObject() {
    return {
      accountId: this.accountId,
      mobile: this.mobile,
      proxyInfo: this.proxyInfo,
      channelId: this.channelId,
      requestIndex: this.requestIndex,
      startTime: this.startTime,
      endTime: this.endTime,
      statusCode: this.statusCode,
      requestData: this.requestData,
      requestHeaders: this.requestHeaders, // 🆕 新增：请求头信息
      responseData: this.responseData,
      responseHeaders: this.responseHeaders,
      error: this.error,
      submitSign: this.submitSign
    };
  }
}

module.exports = RequestLog;
