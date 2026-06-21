'use strict';

/**
 * 账号数据库封装 —— 统一读写 gamyy-core 的 config.db
 * 接收 better-sqlite3 实例，操作本地子表（account_devices / account_sessions 等）
 */
class AccountDatabase {
  constructor(configDb) {
    this.db = configDb;
    this._prepareStatements();
  }

  _prepareStatements() {
    const db = this.db;
    this._stmts = {
      findAccountByMobile:          db.prepare('SELECT * FROM accounts WHERE mobile = ? LIMIT 1'),
      findDeviceByAccountId:        db.prepare('SELECT * FROM account_devices WHERE account_id = ? LIMIT 1'),
      findSessionByAccountId:       db.prepare('SELECT * FROM account_sessions WHERE account_id = ? LIMIT 1'),
      findPatientsByAccountId:      db.prepare('SELECT * FROM account_patients WHERE account_id = ? ORDER BY id'),
      findAccountDetailByAccountId: db.prepare('SELECT * FROM account_details_ext WHERE account_id = ? LIMIT 1'),
      updateAccountStatus:          db.prepare("UPDATE accounts SET status = ? WHERE id = ?"),
    };
  }

  // ── Account ──────────────────────────────────────────────────
  findAccountByMobile(mobile) {
    return this._stmts.findAccountByMobile.get(mobile);
  }

  // ── Device ───────────────────────────────────────────────────
  findDeviceByAccountId(accountId) {
    return this._stmts.findDeviceByAccountId.get(accountId);
  }

  /**
   * 更新账号的客户端身份字段：client_version 和/或 referer。
   * 仅传入想更新的字段；user_agent 由登录刷新逻辑明确决定不会改动，因此此处不接受。
   */
  updateDeviceIdentity(accountId, { client_version, referer } = {}) {
    const sets = [];
    const vals = [];
    if (client_version !== undefined) { sets.push('client_version = ?'); vals.push(client_version); }
    if (referer        !== undefined) { sets.push('referer = ?');        vals.push(referer);        }
    if (sets.length === 0) return false;
    vals.push(accountId);
    this.db.prepare(`UPDATE account_devices SET ${sets.join(', ')} WHERE account_id = ?`).run(...vals);
    return true;
  }

  // ── Session ──────────────────────────────────────────────────
  findSessionByAccountId(accountId) {
    return this._stmts.findSessionByAccountId.get(accountId);
  }

  createOrUpdateSession(data) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    this.db.prepare(`
      INSERT INTO account_sessions
        (account_id, auth_token, submit_sign, cookie_yizhu4_gam, cookie_mobile_manage, last_activity, updated_at)
      VALUES (@accountId, @authToken, @submitSign, @cookieYizhu4Gam, @cookieMobileManage, @now, @now)
      ON CONFLICT(account_id) DO UPDATE SET
        auth_token           = excluded.auth_token,
        submit_sign          = excluded.submit_sign,
        cookie_yizhu4_gam    = excluded.cookie_yizhu4_gam,
        cookie_mobile_manage = excluded.cookie_mobile_manage,
        last_activity        = excluded.last_activity,
        updated_at           = excluded.updated_at
    `).run({
      accountId:          data.accountId,
      authToken:          data.authToken          ?? null,
      submitSign:         data.submitSign         ?? null,
      cookieYizhu4Gam:    data.cookieYizhu4Gam    ?? null,
      cookieMobileManage: data.cookieMobileManage ?? null,
      now
    });
    return this.findSessionByAccountId(data.accountId);
  }

  updateSessionSubmitSign(accountId, submitSign) {
    const cur = this.findSessionByAccountId(accountId);
    if (!cur) return false;
    this.createOrUpdateSession({
      accountId,
      authToken:          cur.auth_token,
      submitSign,
      cookieYizhu4Gam:    cur.cookie_yizhu4_gam,
      cookieMobileManage: cur.cookie_mobile_manage
    });
    return true;
  }

  updateSessionCookie(accountId, interfaceType, cookie) {
    const cur = this.findSessionByAccountId(accountId);
    if (!cur) return false;
    const data = {
      accountId,
      authToken:  cur.auth_token,
      submitSign: cur.submit_sign,
      cookieYizhu4Gam:    cur.cookie_yizhu4_gam,
      cookieMobileManage: cur.cookie_mobile_manage
    };
    if (interfaceType === 'yizhu4_gam')       data.cookieYizhu4Gam    = cookie;
    else if (interfaceType === 'mobile_manage') data.cookieMobileManage = cookie;
    else return false;
    this.createOrUpdateSession(data);
    return true;
  }

  // ── Patients ─────────────────────────────────────────────────
  findPatientsByAccountId(accountId) {
    return this._stmts.findPatientsByAccountId.all(accountId);
  }

  deletePatientById(id) {
    this.db.prepare('DELETE FROM account_patients WHERE id = ?').run(id);
  }

  createPatient(data) {
    this.db.prepare(
      'INSERT INTO account_patients (account_id, patient_id, name, id_card) VALUES (?, ?, ?, ?)'
    ).run(data.accountId, data.patientId, data.name, data.idCard);
  }

  updatePatient(id, name, idCard) {
    this.db.prepare('UPDATE account_patients SET name = ?, id_card = ? WHERE id = ?').run(name, idCard, id);
  }

  // ── AccountDetails ───────────────────────────────────────────
  findAccountDetailByAccountId(accountId) {
    return this._stmts.findAccountDetailByAccountId.get(accountId);
  }

  saveAccountDetails(data) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    this.db.prepare(`
      INSERT INTO account_details_ext
        (account_id, hospital_account_id, token, open_id, union_id, family_id,
         last_login_ip, last_login_time, login_times, platform, updated_at)
      VALUES
        (@accountId, @hospitalAccountId, @token, @openId, @unionId, @familyId,
         @lastLoginIp, @lastLoginTime, @loginTimes, @platform, @now)
      ON CONFLICT(account_id) DO UPDATE SET
        hospital_account_id = excluded.hospital_account_id,
        token               = excluded.token,
        updated_at          = excluded.updated_at
    `).run({
      accountId:          data.accountId,
      hospitalAccountId:  data.hospitalAccountId  ?? 0,
      token:              data.token              ?? null,
      openId:             data.openId             ?? null,
      unionId:            data.unionId            ?? null,
      familyId:           data.familyId           ?? null,
      lastLoginIp:        data.lastLoginIp        ?? null,
      lastLoginTime:      data.lastLoginTime      ?? null,
      loginTimes:         data.loginTimes         ?? 0,
      platform:           data.platform           ?? null,
      now,
    });
  }

  // ── SourceRecords ────────────────────────────────────────────
  createOrUpdateSourceRecord(data) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    try {
      this.db.prepare(`
        INSERT INTO account_source_records
          (account_id, record_id, patient_id, patient_name, doctor_code, doctor_name,
           dept_code, dept_name, hosp_name, reg_date, visit_time, visit_no,
           order_fee, source_trade_id, source_status, source_status_name,
           status, pay_status, clinic_place, created_at, updated_at)
        VALUES
          (@accountId, @recordId, @patientId, @patientName, @doctorCode, @doctorName,
           @deptCode, @deptName, @hospName, @regDate, @visitTime, @visitNo,
           @orderFee, @sourceTradeId, @sourceStatus, @sourceStatusName,
           @status, @payStatus, @clinicPlace, @now, @now)
        ON CONFLICT(source_trade_id) DO UPDATE SET
          source_status      = excluded.source_status,
          source_status_name = excluded.source_status_name,
          status             = excluded.status,
          pay_status         = excluded.pay_status,
          updated_at         = excluded.updated_at
      `).run({ ...data, now });
      return true;
    } catch (_) { return false; }
  }

  findSourceRecordsByAccountId(accountId) {
    try {
      return this.db.prepare(
        'SELECT * FROM account_source_records WHERE account_id = ? ORDER BY visit_time DESC, id DESC'
      ).all(accountId);
    } catch (_) { return []; }
  }

  updateSourceRecordByTradeId(sourceTradeId, updates) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    try {
      this.db.prepare(`
        UPDATE account_source_records SET
          source_status      = COALESCE(@sourceStatus,     source_status),
          source_status_name = COALESCE(@sourceStatusName, source_status_name),
          status             = COALESCE(@status,            status),
          updated_at         = @now
        WHERE source_trade_id = @sourceTradeId
      `).run({
        sourceTradeId,
        sourceStatus:     updates.sourceStatus     ?? null,
        sourceStatusName: updates.sourceStatusName ?? null,
        status:           updates.status           ?? null,
        now,
      });
      return true;
    } catch (_) { return false; }
  }

  // ── Messages ─────────────────────────────────────────────────
  createOrUpdateMessage(data) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    try {
      this.db.prepare(`
        INSERT INTO account_messages
          (account_id, message_id, hospital_account_id, title, title_str,
           content, type, read_or_not, effect_time, created_at)
        VALUES
          (@accountId, @messageId, @hospitalAccountId, @title, @titleStr,
           @content, @type, @readOrNot, @effectTime, @now)
        ON CONFLICT(message_id) DO UPDATE SET
          read_or_not = excluded.read_or_not,
          content     = excluded.content
      `).run({ ...data, now });
      return true;
    } catch (_) { return false; }
  }

  findMessagesByAccountId(accountId) {
    try {
      return this.db.prepare(
        'SELECT * FROM account_messages WHERE account_id = ? ORDER BY effect_time DESC, id DESC'
      ).all(accountId);
    } catch (_) { return []; }
  }

  // ── RequestLogs ──────────────────────────────────────────
  createRequestLog(data) {
    try {
      this.db.prepare(`
        INSERT INTO account_request_logs
          (account_id, request_url, request_method, request_headers, request_body_plain,
           response_data_plain, response_headers,
           duration_ms, proxy_host, proxy_port, is_success, error_message, request_time)
        VALUES
          (@accountId, @requestUrl, @requestMethod, @requestHeaders, @requestBodyPlain,
           @responseDataPlain, @responseHeaders,
           @durationMs, @proxyHost, @proxyPort, @isSuccess, @errorMessage, @requestTime)
      `).run({
        accountId:          data.accountId                                              ?? null,
        requestUrl:         data.requestUrl                                             ?? null,
        requestMethod:      data.requestMethod                                          ?? null,
        requestHeaders:     data.requestHeaders ? JSON.stringify(data.requestHeaders)   : null,
        requestBodyPlain:   data.requestBodyPlain                                       ?? null,
        responseDataPlain:  data.responseDataPlain                                      ?? null,
        responseHeaders:    data.responseHeaders ? JSON.stringify(data.responseHeaders) : null,
        durationMs:         data.durationMs                                             ?? null,
        proxyHost:          data.proxyHost                                              ?? null,
        proxyPort:          data.proxyPort                                              ?? null,
        isSuccess:          data.isSuccess ? 1 : 0,
        errorMessage:       data.errorMessage                                           ?? null,
        requestTime:        data.requestTime                                            ?? null,
      });
    } catch (_) {}
  }

  findRequestLogsByAccountId(accountId, limit = 200) {
    try {
      return this.db.prepare(
        'SELECT * FROM account_request_logs WHERE account_id = ? ORDER BY id DESC LIMIT ?'
      ).all(accountId, limit);
    } catch (_) { return []; }
  }

  // ── Account status ───────────────────────────────────────────
  updateAccountStatus(id, status) {
    this._stmts.updateAccountStatus.run(status, id);
  }

  // close() 是空操作，configDb 由调用方管理生命周期
  close() {}
}

module.exports = AccountDatabase;
