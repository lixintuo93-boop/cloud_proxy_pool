// config/config.js - 主配置文件
// 任务相关配置已分离到 doctor.task.js 和 dept.task.js
// 账号配置已分离到 account.task.js

// 加载任务配置
const doctorTask = require('./doctor.task');
const deptTask = require('./dept.task');
const accountTask = require('./account.task');

module.exports = {
  // ==================== 查号模式 ====================
  // 'doctor' - 按医生查号（使用 doctor.task.js 配置）
  // 'dept'   - 按部门查号（使用 dept.task.js 配置）
  checkMode: 'doctor',

  // ==================== 任务配置（自动加载）====================
  // 按医生查号配置（来自 doctor.task.js）
  ...doctorTask,
  
  // 按部门查号配置（来自 dept.task.js）
  ...deptTask,

  // 账号配置（来自 account.task.js）
  ...accountTask,

  // ==================== 超时配置 ====================
  timeout: {
    // 通道建立超时(ms)：TLS握手未完成视为失败
    connectTimeout: 300000,
    // 查号/锁号请求超时(ms)：通道内请求未收到响应视为超时
    requestTimeout: 300000,
    // 心跳请求超时(ms)：心跳未收到响应视为超时
    heartbeatTimeout: 300000,
  },

  // ==================== 第一阶段：初始通道创建 ====================
  channelBuildPhase1: {
    startTime: "14:55:15.000",         // 开始创建时间
    windowTime: 270000,                  // 创建窗口(ms)
    attempts: 200,                       // 每个代理尝试创建通道的次数
    distribution: 'random',            // 时间分布方式: 'uniform'=均匀分布, 'random'=随机分布
    
    // 🆕 早停策略配置
    earlyStop: {
      enabled: true,                    // 是否启用早停策略
      algorithm: 'dynamic',             // 静默时间阈值算法: 'fixed'=固定值, 'dynamic'=动态计算
      fixedThreshold: 5000,            // 固定阈值(ms)，algorithm='fixed'时使用
      multiplier: 15,                   // 动态计算乘数，algorithm='dynamic'时使用
      // 动态计算公式: windowTime / attempts * multiplier
      // 例如: 140000 / 100 * 10 = 14000ms = 14秒
      // 逻辑：当代理超过静默时间没有成功创建通道时，停止该代理的后续创建尝试
    },
    
    // 🆕 自动关闭多余通道配置
    autoCloseExcess: {
      enabled: false,                    // 是否启用自动关闭多余通道

      // 最大成功通道数：当成功通道数 > 此值时，关闭过期时间最早的多余通道
      // 'auto'  - 自动：使用 checkRequest.windowTime / minInterval + reservedChannels
      // 数字    - 固定值，如 20 表示最多保留20个通道
      maxSuccessChannels: 'auto',
      // 动态计算公式: checkRequest.windowTime / checkRequest.minInterval + lockRequest.global.reservedChannels
      // 例如: 10000 / 250 + 0 = 40 个通道

      // 定时轮询监控间隔(ms)：在通道创建期间定时检查并关闭多余通道
      // 0 或不填 = 仅在新通道建立时触发一次检查（事件驱动）
      // 正整数   = 每隔 N ms 额外轮询一次（定时轮询），推荐 3000~10000
      monitorInterval: 0,
    },
  },

  // ==================== 查票请求配置 ====================
  checkRequest: {
    startTime: "14:59:50.000",          // 查票开始时间（绝对时间）
    windowTime: 10000,                  // 查票窗口时长(ms)，窗口终点 = startTime + windowTime
    minInterval: 250,                   // 最小请求间隔(ms)，约束最大查票次数，防风控
    distribution: 'random',            // 时间槽分布方式: 'uniform'=均匀分布, 'random'=随机分布
    
    // 🆕 通道复用配置
    reuseChannel: {
      enabled: false,                    // 是否启用通道复用
      minInterval: 10000,                // 同一通道的最小请求间隔(ms)
      reuseOnTimeout: false,            // 超时后是否复用（建议false，防止数据错乱）
      reuseOnError: true,               // 收到错误响应后是否复用
    },

    // 累计查到几次票后停止发送查号请求
    // 0 - 永不因查到票而停止（等同旧 continueCheckAfterFound: true）
    // 1 - 查到1次立即停止（等同旧 continueCheckAfterFound: false）
    // N - 累计查到N次后停止，期间持续刷新 SubmitSign 提高锁号成功率（推荐默认值 3）
    stopAfterFoundCount: 3,
  },

  // ==================== 锁号请求配置 ====================
  lockRequest: {
    // ========== global 模式配置 ==========
    global: {
      reservedChannels: 0,               // 为锁号预留的空闲通道数
      firstLockDelayMs: 0,               // 查到票后首次锁号的延迟(ms)，0=立即；窗口期从延迟结束后开始计算
      windowTime: 20000,                  // 锁号请求窗口(ms)
      minInterval: 250,                   // 最小请求间隔(ms)
      directRequestOnNoChannel: false,     // 无可用通道时是否直接发送请求（不通过通道）
      // SubmitSign 策略
      // 'first'  - 使用第一次查到号的请求响应头中的 SubmitSign（默认）
      // 'latest' - 使用该代理最新的有票查号请求响应头中的 SubmitSign
      //            即使已停止发新查号请求，已发出的请求仍可能返回有票结果并持续更新此值
      // 'rotate' - 轮询：每轮选池中最久未使用的 SubmitSign（LRU）
      //            高峰期高延迟场景下避免在响应回来前重复使用已消耗的值
      submitSignStrategy: 'rotate',
    },
  },

  // ==================== 通道保活配置（应用层心跳）====================
  keepAlive: {
    // 是否启用心跳保活
    enabled: true,
    // 心跳间隔(ms)
    interval: 55000,
    // 心跳请求配置
    request: {
      // 心跳类型：
      // 'head'         - HEAD / 请求（默认，轻量）
      // 'systemConfig' - POST /mobile-web/gam.sys.systemConfig.hsr（模拟真实业务请求）
      type: 'head',
    },

  },

  // ==================== 代理分类停止配置 ====================
  proxyClassifier: {
    // 是否启用代理分类停止功能
    enabled: true,

    // 触发方式：
    // 'timer' - 仅定时轮询（早停开或关均适用）
    // 'event' - 仅早停事件驱动（需 channelBuildPhase1.earlyStop.enabled = true）
    // 'both'  - 两种方式同时启用（推荐）
    triggerMode: 'both',

    // 定时轮询间隔(ms)，triggerMode 为 'timer' 或 'both' 时有效
    monitorInterval: 20000,

    // 最少参与分类的代理数量（数据点不足时不执行分类）
    minProxies: 5,

    // 显著间隔判断方式（用于决定最大间隔是否"足够大"可作为分界）：
    // 'stddev' - 均值 + 标准差（默认，适合大多数情况）
    // 'iqr'    - 四分位距上界：Q3 + 1.5 * IQR（更稳健，抗异常值）
    thresholdMethod: 'stddev',

    // 最小有效间隔(ms)：即使统计上显著，时间差小于此值也不作为分界
    // 防止因代理最后成功时间极为接近而误分类，建议 10000~30000
    minGapMs: 15000,

  },

  // ==================== 连接池配置 ====================
  connectionPool: {
    // 目标主机列表（hlwyl.gamyy.cn 的DNS解析IP）
    // sni: TLS握手时的Server Name Indication，当host为IP时需要配置为域名
    targetHosts: [
      // { host: '60.205.110.227', port: 443, sni: 'hlwyl.gamyy.cn' },
      // { host: 'hlwyl.gamyy.cn', port: 443 },
      // { host: '123.114.40.188', port: 443, sni: 'hlwyl.gamyy.cn' },
      { host: '123.114.40.188', port: 443, sni: 'hlwyl.gamyy.cn' },
      { host: '123.114.40.189', port: 443, sni: 'hlwyl.gamyy.cn' }
    ],
    
    // 🆕 通道寿命配置
  }
};
