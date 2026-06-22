// database/accountDb.js — 任务运行器账号数据库（读 gamyy-core 本地表）
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '../data/config.db');

class AccountDatabase {
  constructor(config) {
    this.config      = config;
    this.accountType = this.config.account?.type || 'wechat';
    console.log(`📱 账号类型: ${this.accountType === 'app' ? 'App端' : '微信小程序端'}`);
    this.db = new Database(DB_PATH, { readonly: true });
    this.db.pragma('foreign_keys = ON');
  }

  _parseAccountConfig() {
    const accounts = this.config.account?.accounts;
    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) return null;
    return accounts;
  }

  _extractCookieValue(full) {
    if (!full || typeof full !== 'string') return '';
    return full.split(';')[0].trim();
  }

  _getClientConfigs() {
    try {
      const row = this.db.prepare(
        'SELECT app_client_config, android_client_config, wechat_client_config FROM system_config WHERE id = 1'
      ).get();
      if (!row) return { app: {}, android: {}, wechat: {} };
      const parse = (v) => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
      return {
        app:     parse(row.app_client_config),
        android: parse(row.android_client_config),
        wechat:  parse(row.wechat_client_config),
      };
    } catch { return { app: {}, android: {}, wechat: {} }; }
  }

  async getAccounts() {
    const accountConfigs = this._parseAccountConfig();

    let query;
    if (this.accountType === 'app') {
      query = `
        SELECT
          a.id          AS account_id,
          a.mobile,
          a.account_platform AS platform,
          ade.token,
          ad.device_id,
          ad.s456hr8,
          ad.user_agent,
          ap.id         AS patient_db_id,
          ap.patient_id,
          ap.name       AS patient_name,
          ap.id_card    AS patient_id_card,
          s.cookie_mobile_manage
        FROM accounts a
        LEFT JOIN account_details_ext ade ON ade.account_id = a.id
        LEFT JOIN account_devices     ad  ON ad.account_id  = a.id
        LEFT JOIN account_patients    ap  ON ap.account_id  = a.id
        LEFT JOIN account_sessions    s   ON s.account_id   = a.id
        WHERE a.status != 'disabled'
          AND a.enabled = 1
          AND ade.token IS NOT NULL AND ade.token != ''
          AND ad.s456hr8 IS NOT NULL
      `;
    } else {
      query = `
        SELECT
          a.id          AS account_id,
          a.mobile,
          ade.token,
          ad.device_id,
          ad.s456hr8,
          ad.user_agent,
          ad.referer,
          ap.id         AS patient_db_id,
          ap.patient_id,
          ap.name       AS patient_name,
          ap.id_card    AS patient_id_card
        FROM accounts a
        LEFT JOIN account_details_ext ade ON ade.account_id = a.id
        LEFT JOIN account_devices     ad  ON ad.account_id  = a.id
        LEFT JOIN account_patients    ap  ON ap.account_id  = a.id
        WHERE a.status != 'disabled'
          AND a.enabled = 1
          AND ade.token IS NOT NULL AND ade.token != ''
          AND ad.s456hr8 IS NOT NULL
      `;
    }

    let params = [];
    if (accountConfigs && accountConfigs.length > 0) {
      const mobiles = accountConfigs.map(a => a.mobile);
      const ph = mobiles.map(() => '?').join(', ');
      query += ` AND a.mobile IN (${ph})`;
      params = mobiles;
    }

    query += ' ORDER BY a.id ASC, ap.id ASC';

    const rows = this.db.prepare(query).all(...params);

    if (!rows || rows.length === 0) {
      console.log('📦 账号加载: 0 个（检查 status=active、enabled=1 及 token/device 是否已填写）');
      return [];
    }

    const patientIdMap     = {};
    const doctorCodeMap    = {};
    const lockPlanDateMap  = {};
    if (accountConfigs) {
      for (const entry of accountConfigs) {
        if (entry.patientId)    patientIdMap[entry.mobile]    = String(entry.patientId);
        if (entry.doctorCode)   doctorCodeMap[entry.mobile]   = entry.doctorCode;
        if (entry.lockPlanDate) lockPlanDateMap[entry.mobile] = entry.lockPlanDate;
      }
    }

    // 按 account_id 分组
    const accountMap = new Map();
    for (const row of rows) {
      if (!accountMap.has(row.account_id)) accountMap.set(row.account_id, []);
      accountMap.get(row.account_id).push(row);
    }

    let result = [];
    for (const [, accountRows] of accountMap) {
      const mobile = accountRows[0].mobile;
      const configuredPatientId = patientIdMap[mobile];
      let selectedRow;

      if (configuredPatientId) {
        selectedRow = accountRows.find(r => String(r.patient_id) === String(configuredPatientId)) || accountRows[0];
      } else {
        selectedRow = accountRows[0];
      }

      result.push({
        ...selectedRow,
        doctorCode:   doctorCodeMap[mobile]   || null,
        lockPlanDate: lockPlanDateMap[mobile] || null,
      });
    }

    const clientCfgs = this._getClientConfigs();

    if (this.accountType === 'app') {
      result = result.map(row => {
        const isAndroid = (row.platform || 'ios') === 'android';
        const cfg = isAndroid ? clientCfgs.android : clientCfgs.app;
        return {
          ...row,
          user_agent: cfg.USER_AGENT || row.user_agent,
          cookie_mobile_manage_full: row.cookie_mobile_manage,
          cookie_mobile_manage: this._extractCookieValue(row.cookie_mobile_manage),
        };
      });
      const withCookie = result.filter(r => r.cookie_mobile_manage).length;
      console.log(`📦 App端账号加载: ${result.length} 个账号，Cookie: ${withCookie}/${result.length}`);
    } else {
      const wxCfg = clientCfgs.wechat;
      result = result.map(row => ({
        ...row,
        user_agent: wxCfg.USER_AGENT || row.user_agent,
        referer:    wxCfg.REFERER    || row.referer,
      }));
      console.log(`📦 微信端账号加载: ${result.length} 个账号`);
    }

    return result;
  }

  async validatePatientIds() {
    const accountConfigs = this._parseAccountConfig();
    if (!accountConfigs) return;
    const withPatient = accountConfigs.filter(a => a.patientId);
    if (withPatient.length === 0) return;

    console.log('\n🔍 校验就诊人配置...');
    let hasError = false;
    for (const entry of withPatient) {
      const account = this.db.prepare(
        "SELECT id FROM accounts WHERE mobile = ? AND status != 'disabled' AND enabled = 1"
      ).get(entry.mobile);
      if (!account) {
        console.error(`   ❌ 账号 ${entry.mobile} 不存在或已禁用`);
        hasError = true;
        continue;
      }
      const patient = this.db.prepare(
        'SELECT patient_id, name FROM account_patients WHERE account_id = ? AND CAST(patient_id AS TEXT) = ?'
      ).get(account.id, String(entry.patientId));
      if (!patient) {
        console.error(`   ❌ 账号 ${entry.mobile} 下找不到 patientId "${entry.patientId}"`);
        hasError = true;
      } else {
        console.log(`   ✅ 账号 ${entry.mobile} → 就诊人: 【${patient.name}】(${entry.patientId})`);
      }
    }
    if (hasError) {
      console.error('   ⚠️  存在就诊人配置错误，请检查 account.task.js\n');
    } else {
      console.log('   ✅ 就诊人配置校验通过\n');
    }
  }

  async validateAccountTargets() {
    const accountConfigs = this._parseAccountConfig();
    if (!accountConfigs || accountConfigs.length === 0) return [];

    console.log('\n🔍 校验账号目标配置...');
    const invalidMobiles = [];
    for (const entry of accountConfigs) {
      const missing = [];
      if (!entry.doctorCode)   missing.push('doctorCode');
      if (!entry.lockPlanDate) missing.push('lockPlanDate');
      if (missing.length > 0) {
        console.error(`   ❌ 账号 ${entry.mobile} 缺少: ${missing.join('、')}`);
        invalidMobiles.push(entry.mobile);
      } else {
        console.log(`   ✅ 账号 ${entry.mobile} → 医生: ${entry.doctorCode}，日期: ${entry.lockPlanDate}`);
      }
    }
    if (invalidMobiles.length > 0) {
      console.error('   ⚠️  配置不完整的账号将被跳过\n');
    } else {
      console.log('   ✅ 账号目标配置校验通过\n');
    }
    return invalidMobiles;
  }

  getAccountType() {
    return this.accountType;
  }

  async getRandomAccounts(count) {
    const all = await this.getAccounts();
    if (all.length === 0) return [];
    return [...all].sort(() => 0.5 - Math.random()).slice(0, Math.min(count, all.length));
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch (_) {}
      this.db = null;
    }
  }
}

module.exports = AccountDatabase;
