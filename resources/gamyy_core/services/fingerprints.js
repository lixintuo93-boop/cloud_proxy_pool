'use strict';

// ============================================================================
// TLS 指纹注册表（来源：真实抓包，目标 hlwyl.gamyy.cn 123.114.40.188/.189）
// ----------------------------------------------------------------------------
// 这些是用 Wireshark/tshark 从真实 App/小程序流量里提取的 ClientHello 指纹。
// 代理层配置 cfg.fingerprint 通过 name 引用本表中的某一项（见 _proxyCfg.fingerprint）。
// 引擎（Go uTLS sidecar）按 mode 消费：
//   - mode:'ja3'    → 由 ja3 串构造 ClientHelloSpec（无 GREASE 的指纹可精确重放）
//   - mode:'preset' → 直接用 uTLS 内置 clientHelloID（带 GREASE/扩展乱序的浏览器）
//   - mode:'raw'    → 由 rawClientHelloRef 指向的原始字节重放（最高保真）
// 注意：JA4 区分 h1/h2，指纹必须与 account 实际走的 HTTP/1.1 + UA 自洽。
//      account 走 HTTP/1.1 → 默认用 android_app（ALPN 仅 http/1.1，无 GREASE，可精确重放）。
// ============================================================================

const FINGERPRINTS = {
  // 主指纹：Android App。小米 + 一加两台手机抓包逐字节一致，稳定、无 GREASE、仅 http/1.1。
  android_app: {
    label: 'Android App（小米/一加抓包一致）',
    source: '小米.pcapng / 一加手机.pcapng',
    mode: 'raw',
    ja3: '771,4865-4866-4867-49195-49196-52393-49199-49200-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-51-45-43-21,29-23-24,0',
    ja3Hash: 'f79b6bad2ad0641e1921aef10262856b',
    ja4: 't13d1513h1_8daaf6152771_eca864cca44a',
    alpn: ['http/1.1'],
    grease: false,
    rawClientHelloRef: 'services/clienthellos/android_clienthello.hex',
  },

  // 微信小程序（电脑版）：Chromium（约 Chrome 120），含 GREASE + 扩展乱序，JA3 每连不同、JA4 稳定。
  // 走 uTLS 内置 HelloChrome_120 预设以复现其随机化行为。ALPN 含 h2。
  wx_miniprogram: {
    label: '微信小程序（电脑版, Chromium ~Chrome120）',
    source: '电脑版微信小程序.pcapng',
    mode: 'preset',
    clientHello: 'HelloChrome_120',
    ja4: 't13d1516h2_8daaf6152771_02713d6af862',
    alpn: ['h2', 'http/1.1'],
    grease: true,
  },

  // 原始抓包里的 h2 客户端（含 ALPS/ECH 风格扩展，无 GREASE，类型待定，疑 iOS/webview）。
  legacy_h2: {
    label: 'h2 客户端（wrieshark 原始包, 类型待定/疑 iOS）',
    source: 'wrieshark抓包信息.pcapng',
    mode: 'raw',
    ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0',
    ja3Hash: 'cd08e31494f9531f560d64c695473da9',
    ja4: 't13d1516h2_8daaf6152771_e5627efa2ab1',
    alpn: ['h2', 'http/1.1'],
    grease: true,
    rawClientHelloRef: 'services/clienthellos/legacy_h2_clienthello.hex',
  },
};

// account 走 HTTP/1.1，默认复刻 Android App 指纹。
const DEFAULT_FINGERPRINT = 'android_app';

// 把代理层存的 fingerprint 配置（通常是 { name } 或带内联覆盖）解析成完整指纹对象。
// name 指向注册表中的预设为底，cfg 内联的其他字段（mode/clientHello/ja3/alpn…）覆盖其上。
function resolveFingerprint(raw) {
  const cfg = (raw && typeof raw === 'object') ? raw : {};
  const name = cfg.name || DEFAULT_FINGERPRINT;
  const base = FINGERPRINTS[name] || FINGERPRINTS[DEFAULT_FINGERPRINT];
  const { name: _ignored, ...overrides } = cfg;
  return { name: FINGERPRINTS[name] ? name : DEFAULT_FINGERPRINT, ...base, ...overrides };
}

module.exports = { FINGERPRINTS, DEFAULT_FINGERPRINT, resolveFingerprint };
