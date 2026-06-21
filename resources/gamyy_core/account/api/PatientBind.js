'use strict';

const MobileWebAPI = require('../MobileWebAPI');
const C = require('../constants');

class PatientBind extends MobileWebAPI {
  constructor(session) {
    super(session, { timeout: 15000 });
    this.url = `${this.baseURL}/mobile-web/patient.bind.hsr`;
  }

  async execute(data) {
    const params = {
      param: {
        accountId:  data.accountId,
        mobileNo:   data.mobileNo,
        idNo:       data.idNo,
        name:       data.name,
        birthday:   data.birthday,
        sex:        data.sex,
        parentName: '',
        parentIdNo: '',
        paperType:  'IDENTITY_CARD'
      },
      hospitalId: C.HOSPITAL_ID
    };
    const result = await this.executeEncrypted(params);
    if (result) {
      if (result.code === 0)
        this.session._log(`患者添加成功: ${data.name}`);
      else
        this.session._log(`患者添加失败: ${result.msg}`);
    }
    return result;
  }
}

module.exports = PatientBind;
