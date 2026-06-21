'use strict';

// ─────────────────────────────────────────────────────────────
// 客户端身份模型
//   - APP_CONFIG / ANDROID_CONFIG / WECHAT_CONFIG：
//       仅"最新版本基线" + 固定参数（CLIENT_VERSION / PLATFORM / FROM / ORIGIN /
//       REFERER）。USER_AGENT 已迁出 → 按账号从 *_UA_POOL 抽取并 snapshot 到
//       account_devices。
//   - DEFAULT_UA：仅当 DB 未初始化时的兜底，不应在正常路径上被读到。
//   - *_UA_POOL：首次启动写入 system_config.{app,android,wechat}_ua_pool；之后
//       由 UI 维护，运行期不再读这里。
// ─────────────────────────────────────────────────────────────

const APP_UA_POOL = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/20) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/47) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/20) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/59) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/44) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/24) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/32) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/47) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/32) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/54) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/44) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/20) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/24) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/20) uni-app',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Html5Plus/1.0 (Immersed/47) uni-app',
];

const ANDROID_UA_POOL = [
  'Mozilla/5.0 (Linux; Android 14; LE2110 Build/UKQ1.230924.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/34.333332)',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/27.428572)',
  'Mozilla/5.0 (Linux; Android 14; SM-G998B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/26.666666)',
  'Mozilla/5.0 (Linux; Android 12; M2102J20SG Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.5938.140 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/24.0)',
  'Mozilla/5.0 (Linux; Android 13; 22021211RC Build/TKQ1.220829.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/40.0)',
  'Mozilla/5.0 (Linux; Android 14; PFTM20 Build/HONORPFTM20; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/33.0)',
  'Mozilla/5.0 (Linux; Android 11; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/28.0)',
  'Mozilla/5.0 (Linux; Android 13; V2218A Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/27.428572)',
  'Mozilla/5.0 (Linux; Android 14; 23049PCD8G Build/UKQ1.230917.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.92 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/34.333332)',
  'Mozilla/5.0 (Linux; Android 13; M2007J3SC Build/TKQ1.220807.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/26.666666)',
  'Mozilla/5.0 (Linux; Android 14; PJA110 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.99 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/40.0)',
  'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A.241105.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.86 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/33.333332)',
  'Mozilla/5.0 (Linux; Android 12; CPH2467 Build/SKQ1.220301.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/115.0.5790.166 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/27.428572)',
  'Mozilla/5.0 (Linux; Android 13; 2210132C Build/TKQ1.221013.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/24.0)',
  'Mozilla/5.0 (Linux; Android 14; NX729J Build/UKQ1.230917.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.103 Mobile Safari/537.36 uni-app Html5Plus/1.0 (Immersed/34.333332)',
];

const WECHAT_UA_POOL = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x18003231) NetType/WIFI Language/zh_CN',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.54(0x18003629) NetType/4G Language/zh_CN',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.58(0x18003a2c) NetType/WIFI Language/zh_CN',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.62(0x18003e2b) NetType/5G Language/zh_CN',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.63(0x18003f2d) NetType/WIFI Language/zh_CN',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.64(0x1800402d) NetType/WIFI Language/zh_CN',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.64(0x1800402d) NetType/4G Language/zh_CN',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.54(0x18003629) NetType/WIFI Language/zh_CN',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 MMWEBID/4488 MicroMessenger/8.0.62.2660(0x28003E36) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  'Mozilla/5.0 (Linux; Android 14; LE2110 Build/UKQ1.230924.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 MMWEBID/2851 MicroMessenger/8.0.64.2780(0x28004060) WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64',
  'Mozilla/5.0 (Linux; Android 13; M2102J20SG Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 MMWEBID/3621 MicroMessenger/8.0.58.2548(0x28003A40) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  'Mozilla/5.0 (Linux; Android 14; 23049PCD8G Build/UKQ1.230917.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 MMWEBID/7833 MicroMessenger/8.0.63.2733(0x28003F4D) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  'Mozilla/5.0 (Linux; Android 12; V2218A Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 MMWEBID/1924 MicroMessenger/8.0.54.2480(0x28003628) WeChat/arm64 Weixin NetType/4G Language/zh_CN ABI/arm64',
  'Mozilla/5.0 (Linux; Android 13; PJA110 Build/TP1A.230623.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 MMWEBID/4892 MicroMessenger/8.0.62.2660(0x28003E36) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  'Mozilla/5.0 (Linux; Android 14; PFTM20 Build/HONORPFTM20; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 MMWEBID/5621 MicroMessenger/8.0.64.2780(0x28004060) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
];

const ACCOUNT_CONSTANTS = {
  BASE_URL: 'https://hlwyl.gamyy.cn',
  HOSPITAL_ID: '10097',
  COMPANY_ID: '10097',

  // App 端 - iOS（最新基线 + 固定参数；UA 走池）
  APP_CONFIG: {
    CLIENT_VERSION: '4.3.2',
    PLATFORM: '2',
    FROM: '0',
  },

  // App 端 - Android（最新基线 + 固定参数；UA 走池）
  ANDROID_CONFIG: {
    CLIENT_VERSION: '4.3.0',
    PLATFORM: '1',
    FROM: '0',
  },

  // 微信端（最新基线 + 固定参数；UA 走池；REFERER 与版本号同步维护）
  WECHAT_CONFIG: {
    CLIENT_VERSION: '6.5.14',
    ORIGIN: 1,
    FROM: '8',
    REFERER: 'https://servicewechat.com/wx598296333b152b00/167/page-frame.html',
  },

  // UA 池种子（仅首次启动时写入 system_config.*_ua_pool；之后由 UI 维护）
  APP_UA_POOL,
  ANDROID_UA_POOL,
  WECHAT_UA_POOL,

  // 兜底 UA（仅当账号 device 无 UA 且池为空时使用；正常路径不应触发）
  DEFAULT_UA: {
    app:     APP_UA_POOL[0],
    android: ANDROID_UA_POOL[0],
    wechat:  WECHAT_UA_POOL[0],
  },

  // 部门/科室常量
  DEPT_CODE: '110901',
  DOCTOR_CODE: 'ZHZZ',

  // 加密
  S456HR8_SALT: 'Ewell@gam2021',

  // 请求超时
  TIMEOUT: 30000,

  // 会话失效错误码
  TOKEN_EXPIRED_CODE: 11006,
  OTHER_DEVICE_LOGIN_CODE: 11009,
  RELOGIN_REQUIRED_CODES: [11006, 11009],

  // 重试配置
  LOGIN_RETRY: { MAX_ATTEMPTS: 3, BASE_DELAY: 2000, MAX_DELAY: 5000 },
  PATIENT_ADD_RETRY: { MAX_ATTEMPTS: 3, BASE_DELAY: 2000, MAX_DELAY: 5000 }
};

module.exports = ACCOUNT_CONSTANTS;
