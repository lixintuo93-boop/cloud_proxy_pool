'use strict';

const MobileWebAPI = require('../MobileWebAPI');
const C = require('../constants');

class PatientUnbind extends MobileWebAPI {
  constructor(session) {
    super(session, { timeout: 15000 });
    this.url = `${this.baseURL}/mobile-web/patient.unbind.hsr`;
  }

  async execute(patientId) {
    const params = { patientId, hospitalId: C.HOSPITAL_ID };
    const result = await this.executeEncrypted(params);
    if (result) {
      if (result.code === 0) this.session._log(`患者解绑成功: patientId=${patientId}`);
      else                   this.session._log(`患者解绑失败: ${result.msg}`);
    }
    return result;
  }
}

module.exports = PatientUnbind;
