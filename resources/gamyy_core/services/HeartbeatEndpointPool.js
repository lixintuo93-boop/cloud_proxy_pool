// services/HeartbeatEndpointPool.js
// 模拟业务心跳的 endpoint 抽样池。
//
// 心跳走在已建好的 TLS channel socket 上（不走 fetch / axios），所以每条 recipe 描述的是
// "原始 HTTP 文本要拼成什么样"——connectionChannel.js 的 buildBusinessHeartbeatRequest 按
// recipe 拼字符串后 socket.write。
//
// 候选 endpoint 都是从 account/api/UserBehaviorAPIs.js 里挑出来的"不需要真实 token"的
// 公开类接口；不需要 hospitalAccountId 等账号侧凭证；服务器只看 status code，body 不会
// 被解析（connectionChannel.js:1157 的 onData 也确认了这一点）。
//
// ⚠️ 本文件随 services/ 一起部署到云端 agent。云端不上传 account/ 目录（DEPLOY.md 明确
// 标记 Web 层专用），所以**禁止从这里 require '../account/...'**——否则 agent 启动直接
// MODULE_NOT_FOUND 崩溃，pm2 看到进程秒挂，健康检查失败。
// HOSPITAL_ID / DEPT_CODE 是配置常量，直接内联为字符串字面量。

const HOSPITAL_ID = '10097';
const DEPT_CODE   = '110901';

/**
 * Recipe 字段说明：
 *   id              内部稳定 id，UI 勾选与启用配置都用这个
 *   name            UI 展示名
 *   method          'POST'
 *   path            URL 路径
 *   contentType     Content-Type header 值
 *   hospitalIdHdr   header 里 hospitalId 的值（mobile-web/hlwyy-manage 用 '10097'，yizhu4 系列用 '0'）
 *   bodyTemplate    body 文本，占位符 {HOSPITAL_ID} / {DEPT_CODE} 在抽取时替换
 *   encrypted       true 则 body 走 cryptoUtils.encryptData
 */
const RECIPES = [
  // ── /mobile-web/ 加密 JSON ──────────────────────────────────────
  {
    id: 'mobile_web_sys_config',
    name: 'systemConfig（系统配置）',
    method: 'POST',
    path: '/mobile-web/gam.sys.systemConfig.hsr',
    contentType: 'application/json',
    hospitalIdHdr: HOSPITAL_ID,
    bodyTemplate: `{"configKey":"WebApplyTimeConfig","hospitalId":"${HOSPITAL_ID}"}`,
    encrypted: true,
  },
  {
    id: 'mobile_web_source_dept_list',
    name: '科室列表',
    method: 'POST',
    path: '/mobile-web/source.deptList.hsr',
    contentType: 'application/json',
    hospitalIdHdr: HOSPITAL_ID,
    bodyTemplate: `{"hospitalId":"${HOSPITAL_ID}","from":0}`,
    encrypted: true,
  },
  {
    id: 'mobile_web_source_doctor_list',
    name: '医生列表',
    method: 'POST',
    path: '/mobile-web/source.doctor.list.hsr',
    contentType: 'application/json',
    hospitalIdHdr: HOSPITAL_ID,
    bodyTemplate: `{"deptCode":"${DEPT_CODE}","hospitalId":"${HOSPITAL_ID}"}`,
    encrypted: true,
  },
  {
    id: 'mobile_web_source_dept_sch_state',
    name: '科室排班',
    method: 'POST',
    path: '/mobile-web/source.dept.sch.state.hsr',
    contentType: 'application/json',
    hospitalIdHdr: HOSPITAL_ID,
    bodyTemplate: `{"deptCode":"${DEPT_CODE}","hospitalId":"${HOSPITAL_ID}"}`,
    encrypted: true,
  },
  {
    id: 'mobile_web_expert_team',
    name: '专家团队',
    method: 'POST',
    path: '/mobile-web/expertTeam.getActiveList.hsr',
    contentType: 'application/json',
    hospitalIdHdr: HOSPITAL_ID,
    bodyTemplate: `{"hospitalId":"${HOSPITAL_ID}"}`,
    encrypted: true,
  },
  // ── /yizhu4_gam/ form-urlencoded（不加密）────────────────────────
  {
    id: 'yizhu4_carousel',
    name: '轮播图',
    method: 'POST',
    path: '/yizhu4_gam/carousel.getByHospitalId.hsr',
    contentType: 'application/x-www-form-urlencoded;charset=utf-8',
    hospitalIdHdr: '0',
    bodyTemplate: `groupName=%E8%87%AA%E5%8A%A9%E6%9C%8D%E5%8A%A1&hospitalId=${HOSPITAL_ID}`,
    encrypted: false,
  },
  {
    id: 'yizhu4_health_classification',
    name: '健康分类',
    method: 'POST',
    path: '/yizhu4_gam/healthInformation.findClassificationList.hsr',
    contentType: 'application/x-www-form-urlencoded;charset=utf-8',
    hospitalIdHdr: '0',
    bodyTemplate: `state=1&hospitalId=${HOSPITAL_ID}`,
    encrypted: false,
  },
  {
    id: 'yizhu4_health_news',
    name: '健康资讯',
    method: 'POST',
    path: '/yizhu4_gam/healthInformation.getNewsBySelectCondition.hsr',
    contentType: 'application/x-www-form-urlencoded;charset=utf-8',
    hospitalIdHdr: '0',
    bodyTemplate: `word=&current=1&pageSize=10&state=1&isOnHot=1&hospitalId=${HOSPITAL_ID}`,
    encrypted: false,
  },
  {
    id: 'yizhu4_output_protocol',
    name: '输出协议',
    method: 'POST',
    path: '/yizhu4_gam/output.protocol.getOne.hsr',
    contentType: 'application/x-www-form-urlencoded;charset=utf-8',
    hospitalIdHdr: '0',
    bodyTemplate: `type=YYXY&hospitalId=${HOSPITAL_ID}`,
    encrypted: false,
  },
  // ── /hlwyy-manage/ 普通 JSON（不加密）──────────────────────────
  {
    id: 'app_manage_menu_list',
    name: '菜单列表',
    method: 'POST',
    path: '/hlwyy-manage/appManage/getAllMenuList',
    contentType: 'application/json',
    hospitalIdHdr: HOSPITAL_ID,
    bodyTemplate: `{"hospitalId":"${HOSPITAL_ID}"}`,
    encrypted: false,
  },
  {
    id: 'app_manage_menu_class_list',
    name: '菜单分类',
    method: 'POST',
    path: '/hlwyy-manage/appManage/getAllMenuClassList',
    contentType: 'application/json',
    hospitalIdHdr: HOSPITAL_ID,
    bodyTemplate: `{"hospitalId":"${HOSPITAL_ID}"}`,
    encrypted: false,
  },
];

const RECIPE_BY_ID = new Map(RECIPES.map(r => [r.id, r]));
const ALL_IDS = RECIPES.map(r => r.id);

/**
 * 从启用集合中随机抽 1 条 recipe；启用集合为空或全部未命中时退回全集。
 * @param {string[]|null|undefined} enabledIds  启用的 recipe id 列表（空数组 / 未配置 = 全启用）
 * @returns {object}  recipe 对象
 */
function pickRandomRecipe(enabledIds) {
  let candidates;
  if (!Array.isArray(enabledIds) || enabledIds.length === 0) {
    candidates = RECIPES;
  } else {
    candidates = enabledIds.map(id => RECIPE_BY_ID.get(id)).filter(Boolean);
    if (candidates.length === 0) candidates = RECIPES;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** 从 [min, max] 均匀抽一个 int 毫秒数。max < min 时退回 min。 */
function pickInterval(min, max) {
  const lo = Math.max(0, parseInt(min, 10) || 0);
  const hi = Math.max(lo, parseInt(max, 10) || lo);
  if (hi === lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

module.exports = {
  RECIPES,
  ALL_IDS,
  pickRandomRecipe,
  pickInterval,
};
