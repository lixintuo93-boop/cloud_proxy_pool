'use strict';

const C = require('./constants');

/**
 * 用一个账号的身份对象构造该账号会用到的 header 模板集合。
 *
 *   identity = {
 *     platform:    'ios' | 'android' | 'wechat',
 *     userAgent:   string,    // 来自 account_devices.user_agent（建账号时从 UA 池抽取并固化）
 *     referer:     string|null, // 仅微信端有值；其它端为 null
 *     from:        string,    // 平台固定参数，来自 system_config 的 *_client_config.FROM
 *     hospitalId?: string,    // 默认 C.HOSPITAL_ID
 *   }
 *
 * 返回值的 key shape 与历史版本保持兼容：每端 4 个接口模板。该账号只用得到自己
 * 平台对应那 4 个 key；非本平台的 key 不生成，session 端按 getPlatform() 分发时
 * 永远不会读到它们。
 */
function buildHeaderTemplates(identity = {}) {
  const platform = identity.platform || 'ios';
  const UA       = identity.userAgent || '';
  const REFERER  = identity.referer   || '';
  const FROM     = identity.from != null ? String(identity.from) : '0';
  const HID      = identity.hospitalId || C.HOSPITAL_ID;

  if (platform === 'wechat') {
    return {
      HU_WEB_WX: {
        'Host': 'hlwyl.gamyy.cn', 'Connection': 'keep-alive',
        'Content-Length': '', 's456hr8': '',
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        'SubmitSign': '', 'token': '', 'from': FROM,
        'Accept-Encoding': 'gzip,compress,br,deflate',
        'User-Agent': UA, 'Referer': REFERER
      },
      HLWYY_MANAGE_WX: {
        'Host': 'hlwyl.gamyy.cn', 'Connection': 'keep-alive',
        'Content-Length': '', 'hospitalId': HID, 's456hr8': '', 'content-type': 'application/json',
        'SubmitSign': '', 'from': FROM,
        'Accept-Encoding': 'gzip,compress,br,deflate',
        'User-Agent': UA, 'Referer': REFERER
      },
      MOBILE_WEB_WX: {
        'Host': 'hlwyl.gamyy.cn', 'Connection': 'keep-alive',
        'Content-Length': '', 'hospitalId': HID, 's456hr8': '', 'content-type': 'application/json',
        'SubmitSign': '', 'token': '', 'from': FROM,
        'Accept-Encoding': 'gzip,compress,br,deflate',
        'User-Agent': UA, 'Referer': REFERER
      },
      YIZHU4_GAM_WX: {
        'Host': 'hlwyl.gamyy.cn', 'Connection': 'keep-alive',
        'Content-Length': '', 'hospitalId': '0', 's456hr8': '',
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        'SubmitSign': '', 'token': '', 'from': FROM,
        'Accept-Encoding': 'gzip,compress,br,deflate',
        'User-Agent': UA, 'Referer': REFERER
      }
    };
  }

  if (platform === 'android') {
    return {
      MOBILE_WEB_ANDROID: {
        's456hr8': '', 'SubmitSign': '', 'hospitalId': HID, 'from': FROM,
        'token': '', 'user-agent': UA, 'Content-Type': 'application/json',
        'Content-Length': '', 'Host': 'hlwyl.gamyy.cn',
        'Connection': 'Keep-Alive', 'Accept-Encoding': 'gzip'
      },
      YIZHU4_GAM_ANDROID: {
        's456hr8': '', 'SubmitSign': '', 'hospitalId': '0', 'from': FROM,
        'token': '', 'user-agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Content-Length': '', 'Host': 'hlwyl.gamyy.cn',
        'Connection': 'Keep-Alive', 'Accept-Encoding': 'gzip'
      },
      HU_WEB_ANDROID: {
        's456hr8': '', 'SubmitSign': '', 'token': '', 'user-agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Content-Length': '', 'Host': 'hlwyl.gamyy.cn',
        'Connection': 'Keep-Alive', 'Accept-Encoding': 'gzip'
      },
      HLWYY_MANAGE_ANDROID: {
        's456hr8': '', 'SubmitSign': '', 'hospitalId': HID, 'from': FROM,
        'token': '', 'user-agent': UA, 'Content-Type': 'application/json',
        'Content-Length': '', 'Host': 'hlwyl.gamyy.cn',
        'Connection': 'Keep-Alive', 'Accept-Encoding': 'gzip'
      }
    };
  }

  // 默认：App iOS
  return {
    MOBILE_WEB: {
      'Host': 'hlwyl.gamyy.cn', 'Accept': '*/*', 'Connection': 'keep-alive',
      'Content-Length': '', 'hospitalId': HID, 's456hr8': '', 'content-type': 'application/json',
      'SubmitSign': '', 'token': '', 'from': FROM,
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': UA
    },
    YIZHU4_GAM: {
      'Host': 'hlwyl.gamyy.cn', 'Accept': '*/*', 'Connection': 'keep-alive',
      'Content-Length': '', 'hospitalId': '0', 's456hr8': '',
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'SubmitSign': '', 'token': '', 'from': FROM,
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': UA
    },
    HU_WEB: {
      'Host': 'hlwyl.gamyy.cn', 'Accept': '*/*', 'Connection': 'keep-alive',
      'Content-Length': '', 's456hr8': '',
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'SubmitSign': '', 'token': '',
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': UA
    },
    HLWYY_MANAGE: {
      'Host': 'hlwyl.gamyy.cn', 'Accept': '*/*', 'Connection': 'keep-alive',
      'Content-Length': '', 'hospitalId': HID, 's456hr8': '', 'content-type': 'application/json',
      'SubmitSign': '', 'from': FROM,
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': UA
    }
  };
}

// SessionManager 未初始化时的兜底（不应在正常路径上被读到，仅为旧代码 fallback 保留）
const DEFAULT_HEADERS = {
  ...buildHeaderTemplates({ platform: 'ios',     userAgent: C.DEFAULT_UA.app,     from: C.APP_CONFIG.FROM }),
  ...buildHeaderTemplates({ platform: 'android', userAgent: C.DEFAULT_UA.android, from: C.ANDROID_CONFIG.FROM }),
  ...buildHeaderTemplates({ platform: 'wechat',  userAgent: C.DEFAULT_UA.wechat,  from: C.WECHAT_CONFIG.FROM, referer: C.WECHAT_CONFIG.REFERER }),
};

module.exports = { buildHeaderTemplates, DEFAULT_HEADERS };
