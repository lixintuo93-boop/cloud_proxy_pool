'use strict';

const MobileWebAPI = require('../MobileWebAPI');
const C = require('../constants');

class SourceApplyCancelLock extends MobileWebAPI {
  constructor(session) {
    super(session);
    this.url = `${this.baseURL}/mobile-web/source.apply.cancelLock.hsr`;
  }

  async execute(sourceTradeId) {
    const params = {
      sourceTradeId,
      hospitalId: C.HOSPITAL_ID,
    };
    return await this.executeEncrypted(params);
  }
}

module.exports = SourceApplyCancelLock;
