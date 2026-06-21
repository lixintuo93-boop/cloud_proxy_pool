'use strict';

const MobileWebAPI = require('../MobileWebAPI');
const C = require('../constants');

class MessageList extends MobileWebAPI {
  constructor(session) {
    super(session);
    this.url = `${this.baseURL}/mobile-web/message.list.hsr`;
  }

  async execute(hospitalAccountId) {
    const params = {
      accountId:                hospitalAccountId,
      notificationMessageType:  'USER_NOTIFICATION',
      pageSize:                 100,
      pageIndex:                1,
      hospitalId:               C.HOSPITAL_ID
    };
    return await this.executeEncrypted(params);
  }
}

module.exports = MessageList;
