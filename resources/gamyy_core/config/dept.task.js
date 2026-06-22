// config/dept.task.js - 按部门查号任务配置
// 当 config.js 中 checkMode: 'dept' 时使用此配置

module.exports = {
  // ========== 查询参数 ==========
  deptQueryParams: {
    // 部门代码（肿瘤门诊: 110901）
    // deptCode: "110901",

    // 查询日期范围
    // - 填写日期（如 "2026-04-21"）：所有账号统一使用该日期查号（优先级最高）
    // - 留空 null 或 ""：每个账号自动使用自己的 lockPlanDate 作为查号日期（planDateStart = planDateEnd = lockPlanDate）
    // 注意：若此处日期范围不包含账号的 lockPlanDate，查到的号将因日期不匹配无法抢票
    // planDateStart: "2026-03-03",
    // planDateEnd: "2026-03-03",

    // 医院ID
    hospitalId: "10097"
  },

};
