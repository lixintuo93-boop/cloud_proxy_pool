'use strict';

const MobileWebAPI  = require('../MobileWebAPI');
const Yizhu4GamAPI  = require('../Yizhu4GamAPI');
const HuWebAPI      = require('../HuWebAPI');
const AppManageAPI  = require('../AppManageAPI');
const C             = require('../constants');

// ── MobileWeb 接口 ────────────────────────────────────────────

class MedcardList extends MobileWebAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/mobile-web/medcard.list.hsr`; }
  async execute() {
    return this.executeEncrypted({ accountId: this.session.account.id, hospitalId: parseInt(C.HOSPITAL_ID) });
  }
}

class ExpertTeamGetActiveList extends MobileWebAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/mobile-web/expertTeam.getActiveList.hsr`; }
  async execute() { return this.executeEncrypted({ hospitalId: C.HOSPITAL_ID }); }
}

class SourceDeptList extends MobileWebAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/mobile-web/source.deptList.hsr`; }
  async execute() { return this.executeEncrypted({ hospitalId: C.HOSPITAL_ID, from: 0 }); }
}

class SourceDoctorList extends MobileWebAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/mobile-web/source.doctor.list.hsr`; }
  async execute(deptCode = C.DEPT_CODE) {
    return this.executeEncrypted({ deptCode, hospitalId: C.HOSPITAL_ID });
  }
}

class SourceDeptSchState extends MobileWebAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/mobile-web/source.dept.sch.state.hsr`; }
  async execute(deptCode = C.DEPT_CODE) {
    return this.executeEncrypted({ deptCode, hospitalId: C.HOSPITAL_ID });
  }
}

// ── Yizhu4Gam 接口 ────────────────────────────────────────────

class CarouselGetByHospitalId extends Yizhu4GamAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/yizhu4_gam/carousel.getByHospitalId.hsr`; }
  async execute() {
    const body = new URLSearchParams({ groupName: '自助服务', hospitalId: C.HOSPITAL_ID }).toString();
    return this.request(this.url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } });
  }
}

class HealthInformationFindClassificationList extends Yizhu4GamAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/yizhu4_gam/healthInformation.findClassificationList.hsr`; }
  async execute() {
    const body = new URLSearchParams({ state: 1, hospitalId: C.HOSPITAL_ID }).toString();
    return this.request(this.url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } });
  }
}

class HealthInformationGetNewsBySelectCondition extends Yizhu4GamAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/yizhu4_gam/healthInformation.getNewsBySelectCondition.hsr`; }
  async execute() {
    const body = new URLSearchParams({ word: '', current: 1, pageSize: 10, state: 1, isOnHot: 1, hospitalId: C.HOSPITAL_ID }).toString();
    return this.request(this.url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } });
  }
}

class OutputProtocolGetOne extends Yizhu4GamAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/yizhu4_gam/output.protocol.getOne.hsr`; }
  async execute() {
    const body = new URLSearchParams({ type: 'YYXY', hospitalId: C.HOSPITAL_ID }).toString();
    return this.request(this.url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } });
  }
}

// ── HuWeb 接口 ────────────────────────────────────────────────

class IMOrderUserList extends HuWebAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/hu-web/im/order/user/list`; }
  async execute() {
    const hospitalAccountId = this.session.getHospitalAccountId();
    if (!hospitalAccountId) throw new Error('未找到账号ID，请先登录');
    const body = new URLSearchParams({
      companyId: C.COMPANY_ID, userAccountNo: String(hospitalAccountId),
      userNo: '', orderStatus: '', pageIndex: '1', pageSize: '10',
      from: '0', hospitalId: C.HOSPITAL_ID
    }).toString();
    return this.request(this.url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } });
  }
}

// ── AppManage 接口 ────────────────────────────────────────────

class AppManageGetAllMenuList extends AppManageAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/hlwyy-manage/appManage/getAllMenuList`; }
  async execute() {
    return this.request(this.url, {
      method: 'POST',
      body: JSON.stringify({ hospitalId: C.HOSPITAL_ID }),
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

class AppManageGetAllMenuClassList extends AppManageAPI {
  constructor(s) { super(s); this.url = `${this.baseURL}/hlwyy-manage/appManage/getAllMenuClassList`; }
  async execute() {
    return this.request(this.url, {
      method: 'POST',
      body: JSON.stringify({ hospitalId: C.HOSPITAL_ID }),
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── 用户行为执行器 ────────────────────────────────────────────

async function executeUserBehavior(session) {
  session._log('开始执行用户行为');

  if (!session.sessionData?.auth_token) {
    session._log('账号未登录，跳过用户行为');
    return { success: true, skipped: true };
  }

  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const randDelay = (min, max) => delay(min + Math.floor(Math.random() * (max - min)));

  const safe = async (name, fn) => {
    try { await fn(); session._log(`✓ ${name}`); }
    catch (e) {
      if (e.message === 'SESSION_INVALID') throw e;
      session._log(`⚠ ${name}: ${e.message}`);
    }
  };

  // Step 1: 打开App并发请求
  session._log('Step 1: 打开App');
  await Promise.all([
    safe('轮播图',     () => new CarouselGetByHospitalId(session).execute()),
    safe('菜单列表',   () => new AppManageGetAllMenuList(session).execute()),
    safe('健康分类',   () => new HealthInformationFindClassificationList(session).execute()),
    safe('健康资讯',   () => new HealthInformationGetNewsBySelectCondition(session).execute()),
    safe('菜单分类',   () => new AppManageGetAllMenuClassList(session).execute())
  ]);
  await randDelay(2000, 3000);

  // Step 2: 登录后请求
  session._log('Step 2: 登录后操作');
  await Promise.all([
    safe('订单列表',   () => new IMOrderUserList(session).execute()),
    safe('就诊卡列表', () => new MedcardList(session).execute())
  ]);
  await Promise.all([
    safe('菜单列表2',  () => new AppManageGetAllMenuList(session).execute()),
    safe('菜单分类2',  () => new AppManageGetAllMenuClassList(session).execute()),
    safe('专家团队',   () => new ExpertTeamGetActiveList(session).execute())
  ]);
  await randDelay(2000, 3000);

  // Step 3: 预约挂号流程
  session._log('Step 3: 挂号流程');
  await safe('输出协议', () => new OutputProtocolGetOne(session).execute());
  await randDelay(2000, 3000);
  await safe('科室列表', () => new SourceDeptList(session).execute());
  await randDelay(2000, 3000);

  // Step 4: 医生列表 + 排班（并发）
  session._log('Step 4: 医生信息');
  await Promise.all([
    safe('医生列表',   () => new SourceDoctorList(session).execute()),
    safe('科室排班',   () => new SourceDeptSchState(session).execute())
  ]);

  session._log('用户行为执行完成');
  return { success: true };
}

module.exports = {
  executeUserBehavior,
  MedcardList, ExpertTeamGetActiveList, SourceDeptList, SourceDoctorList, SourceDeptSchState,
  CarouselGetByHospitalId, HealthInformationFindClassificationList,
  HealthInformationGetNewsBySelectCondition, OutputProtocolGetOne,
  IMOrderUserList, AppManageGetAllMenuList, AppManageGetAllMenuClassList
};
