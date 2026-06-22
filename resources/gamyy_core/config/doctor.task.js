// config/doctor.task.js - 按医生查号任务配置
// 当 config.js 中 checkMode: 'doctor' 时使用此配置

module.exports = {
  // ========== 医生数据来源 ==========
  // 'config'   - 使用下方 queryParams.doctorCodes 配置的医生
  // 'database' - 从数据库动态读取当天出诊医生
  doctorSource: 'config',

  // ========== 医生选择模式 ==========
  // 'random'     - 每个请求随机选择一个当天有排班的医生
  // 'perProxy'   - 同一个代理IP查询同一个医生（根据医生权重轮询分配）
  // 'perAccount' - 同一个账号查询同一个医生（根据医生权重轮询分配）
  doctorSelectMode: 'random',

  // ========== 查询参数 ==========
  queryParams: {
    // 当 doctorSource: 'config' 时，指定要查询的医生代码列表
    // 注意：若账号配置了 doctorCode，该账号将只查询自己的目标医生，此列表对其无效
    // doctorCodes: ["ZPY"],

    // 查询日期
    // - 填写日期（如 "2026-04-21"）：所有账号统一使用该日期查号（优先级最高）
    // - 留空 null 或 ""：每个账号自动使用自己的 lockPlanDate 作为查号日期
    // 注意：若此处日期与账号 lockPlanDate 不一致，查到的号将因日期不匹配无法抢票
    // planDateStart: "2026-04-03",

    // 医院ID
    hospitalId: "10097"
  },
};
