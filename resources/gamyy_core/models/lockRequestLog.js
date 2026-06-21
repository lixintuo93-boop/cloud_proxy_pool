// models/LockRequestLog.js
class LockRequestLog {
  constructor(accountId, proxyInfo, mobile, requestData, channelId, requestIndex, planId, patientId) {
    this.id = Date.now() + Math.random().toString(36).substr(2, 9);
    this.accountId = accountId;
    this.mobile = mobile;
    this.proxyInfo = proxyInfo;
    this.channelId = channelId;
    this.requestIndex = requestIndex;
    this.planId = planId;
    this.patientId = patientId;
    this.startTime = Date.now();
    this.endTime = null;
    this.statusCode = null;
    this.requestData = requestData;
    this.requestHeaders = null;
    this.requestBody = null;
    this.responseData = null;
    this.responseHeaders = null; // 🆕 新增：返回头信息
    this.error = null;
    this.lockSuccess = false;
    this.lockDetails = null;
    this.submitSign = null;
    this.submitSignSource = null;
  }

complete(statusCode, responseData, error = null, requestHeaders = null, requestBody = null, submitSign = null, submitSignSource = null, responseHeaders = null) {
  this.endTime = Date.now();
  this.statusCode = statusCode; // 🆕 保存真实状态码
  this.responseData = responseData; // 🆕 无论状态码多少都保存响应数据
  this.responseHeaders = responseHeaders;
  this.error = error;
  this.requestHeaders = requestHeaders;
  this.requestBody = requestBody;
  this.submitSign = submitSign;
  this.submitSignSource = submitSignSource;
  
  // 🆕 修改：严格检查锁号是否成功
  // 必须同时满足：statusCode=200, code=0, msg包含"预约成功"
  const isRealLockSuccess = statusCode === 200 && 
                            responseData && 
                            responseData.code === 0 && 
                            responseData.msg && 
                            responseData.msg.includes('预约成功');
  
  if (isRealLockSuccess) {
    this.lockSuccess = true;
    this.lockDetails = responseData.value;
  } else {
    this.lockSuccess = false;
    this.lockDetails = null;
    
    // 如果code=0但msg不是"预约成功"，说明收到了查票响应，记录错误信息
    if (statusCode === 200 && responseData && responseData.code === 0 && !error) {
      this.error = `响应类型不匹配：收到 msg="${responseData.msg}" 而非锁号响应`;
    }
  }
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
      requestHeaders: this.requestHeaders,
      requestBody: this.requestBody,
      responseData: this.responseData,
      responseHeaders: this.responseHeaders, // 🆕 新增：返回头信息
      error: this.error,
      lockSuccess: this.lockSuccess,
      planId: this.planId,
      patientId: this.patientId,
      lockDetails: this.lockDetails,
      submitSign: this.submitSign,
      submitSignSource: this.submitSignSource
    };
  }
}

module.exports = LockRequestLog;