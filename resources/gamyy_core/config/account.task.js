// config/account.task.js - 账号配置
// 当 config.js 中 checkMode: 'doctor' 或 'dept' 时均使用此配置

module.exports = {
  account: {
    // 账号类型：
    // 'wechat' - 微信小程序端账号
    // 'app'    - App端账号
    type: 'app',

    // App端平台（仅 type='app' 时生效）：
    // 'ios'     - iOS App端
    // 'android' - Android App端
    platform: 'android',

    // 账号列表（按手机号筛选，支持多个账号）
    // 每个账号支持的配置字段：
    //
    //   mobile       【必填】手机号，用于从数据库中匹配账号
    //   doctorCode   【必填】目标医生代码，该账号将只查询并抢该医生的号
    //                         按医生查号：直接查询该医生
    //                         按部门查号：自动推导所属部门后查询，并过滤出该医生的号
    //   lockPlanDate 【必填】目标日期（'YYYY-MM-DD'），只抢该日期的号
    //                         查号配置中日期为空时，同时作为该账号的查号日期
    //
    //   patientId    【可选】就诊人ID，不填则自动使用该账号下第一个就诊人
    //
    // 配置不完整的账号（缺少 doctorCode 或 lockPlanDate）将在启动时被跳过并给出提示
    accounts: [
      // { mobile: '18130094143', doctorCode: 'HOUDL', lockPlanDate: '2026-04-21'},  // 不指定，使用第一个就诊人
      { mobile: '18896068401', doctorCode: 'HW', lockPlanDate: '2026-04-27'},  // 不指定，使用第一个就诊人
      { mobile: '13020630932', doctorCode: 'LWP', lockPlanDate: '2026-04-27'},  // 不指定，使用第一个就诊人
      { mobile: '13062050610', doctorCode: 'HANF', lockPlanDate: '2026-04-27',patientId: '7277156'},  // 不指定，使用第一个就诊人
      // { mobile: '18326179454', doctorCode: 'HOUDL', lockPlanDate: '2026-04-21'},
    ],
  },
};
