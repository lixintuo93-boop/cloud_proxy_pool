'use strict';

const MobileWebAPI = require('../MobileWebAPI');
const C = require('../constants');

class SourceRecordList extends MobileWebAPI {
  constructor(session) {
    super(session);
    this.url = `${this.baseURL}/mobile-web/source.record.list.hsr`;
  }

  _fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  async execute(patientId) {
    const today = new Date();
    const ago   = new Date(); ago.setMonth(ago.getMonth() - 3);
    const params = {
      patientId,
      dateStart:  this._fmt(ago),
      dateEnd:    this._fmt(today),
      regType:    'RESERVATION',
      hospitalId: C.HOSPITAL_ID
    };
    return await this.executeEncrypted(params);
  }
}

module.exports = SourceRecordList;
