'use strict';

const AccountDatabase  = require('./AccountDatabase');
const SessionManager   = require('./SessionManager');
const AccountLogin     = require('./api/AccountLogin');
const PatientBind      = require('./api/PatientBind');
const PatientUnbind    = require('./api/PatientUnbind');
const CreatePatient    = require('./api/CreatePatient');
const SourceRecordList       = require('./api/SourceRecordList');
const SourceApplyCancelLock  = require('./api/SourceApplyCancelLock');
const MessageList            = require('./api/MessageList');
const { executeUserBehavior } = require('./api/UserBehaviorAPIs');
const { parseIdCard }  = require('./PatientGenerator');
const C                = require('./constants');

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENOTFOUND', 'EPIPE', 'EAI_AGAIN', 'ECONNABORTED',
]);

function isNetworkError(e) {
  if (!e) return false;
  if (e.message === 'SessionManager 初始化失败') return true;
  if (NETWORK_ERROR_CODES.has(e.code)) return true;
  const msg = (e.message || '').toLowerCase();
  return msg.includes('socks') || msg.includes('proxy') ||
         msg.includes('socket hang up') || msg.includes('connect timeout');
}

/**
 * 账号操作服务：读写 gamyy-core 的本地账号子表
 */
class AccountOperationService {
  constructor(configDb) {
    this.configDb = configDb;
    this.adb = new AccountDatabase(configDb);
  }

  // ── 内部：获取账号配置的操作代理（通过 accounts.ops_proxy_id）───
  _getAssignedProxies(accountId) {
    const row = this.configDb.prepare(`
      SELECT p.* FROM proxies p
      JOIN accounts a ON a.ops_proxy_id = p.id
      WHERE a.id = ?
    `).get(accountId);
    if (!row) return [];
    if (row.proxy_type === 'direct') return [{ type: 'direct' }];
    // 账号操作必须走本地 SOCKS5（云端 agent 不承载账号操作类逻辑）；
    // 仅云端 SSH 代理（无本地端口）不能作为操作代理。
    if (row.proxy_type === 'ssh' && !row.port) {
      throw new Error(`账号操作代理 #${row.id}（${row.real_ip || '?'}）为"仅云端"SSH 代理，无本地端口，不能作账号操作代理。请改绑带本地端口的代理。`);
    }
    return [{ host: row.host, port: row.port, username: row.username, password: row.password, type: 'socks5' }];
  }

  // ── 内部：获取 gamyy 账号行 ───────────────────────────────────
  _getGamyyAccount(accountId) {
    return this.configDb.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  }

  // ── 内部：从 system_config 读取每端的"最新版本基线 + 固定参数"────────
  // 注意：这里返回的对象里若残留有 USER_AGENT/REFERER 字段，SessionManager 不会
  // 用它们当 header 值——真正的 UA 走 account_devices.user_agent（按账号 snapshot）。
  // 只有 CLIENT_VERSION / PLATFORM / FROM / ORIGIN 会被消费。微信端的 REFERER 也
  // 仅作为"最新基线"用于登录后刷新对照，不直接用于本次请求。
  _getClientConfigs() {
    try {
      const row = this.configDb.prepare('SELECT app_client_config, android_client_config, wechat_client_config FROM system_config WHERE id = 1').get();
      if (!row) return { app: {}, android: {}, wechat: {} };
      const parse = (v) => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
      return {
        app:     parse(row.app_client_config),
        android: parse(row.android_client_config),
        wechat:  parse(row.wechat_client_config),
      };
    } catch { return { app: {}, android: {}, wechat: {} }; }
  }

  // ── 内部：用指定代理初始化会话上下文 ────────────────────────
  async _initContextWithProxy(account, proxy, logCallback) {
    const sm = new SessionManager(account, this.adb, account.account_type);
    sm.setLogCallback(logCallback);
    sm.onRequestLog = (data) => this.adb.createRequestLog(data);
    const cfg = this._getClientConfigs();
    sm.setClientConfig(cfg.app, cfg.android, cfg.wechat);
    sm._log(`初始化：使用代理 ${proxy.type === 'direct' ? '本机直连' : `${proxy.host}:${proxy.port}`}`);
    const ok = await sm.initialize(proxy);
    if (!ok) throw new Error('SessionManager 初始化失败');
    return { sm, adb: this.adb, account };
  }

  // ── 公共：执行操作（统一入口，网络错误自动切换代理重试）─────
  async execute(gamyyAccountId, operationType, options = {}, logCallback = () => {}) {
    const account = this._getGamyyAccount(gamyyAccountId);
    if (!account) throw new Error('账号不存在');

    const proxies = this._getAssignedProxies(gamyyAccountId);
    if (proxies.length === 0) throw new Error('该账号未配置操作代理，请先分配操作代理');

    let lastError;
    for (let i = 0; i < proxies.length; i++) {
      const proxy = proxies[i];
      let ctx;
      try {
        ctx = await this._initContextWithProxy(account, proxy, logCallback);
        if (i > 0) logCallback(`已切换到代理 ${proxy.type === 'direct' ? '本机直连' : `${proxy.host}:${proxy.port}`}`);
        logCallback(`开始执行: ${operationType}`);

        switch (operationType) {
          case 'login':                return await this._login(ctx, options);
          case 'add-patient':          return await this._addPatient(ctx, options);
          case 'remove-patient':       return await this._removePatient(ctx, options);
          case 'user-behavior':        return await this._userBehavior(ctx);
          case 'source-records':       return await this._getSourceRecords(ctx);
          case 'messages':             return await this._getMessages(ctx);
          case 'cancel-registration':  return await this._cancelRegistration(ctx, options);
          default: throw new Error(`未知操作类型: ${operationType}`);
        }
      } catch (e) {
        if (isNetworkError(e) && i < proxies.length - 1) {
          logCallback(`代理 ${proxy.type === 'direct' ? '本机直连' : `${proxy.host}:${proxy.port}`} 网络失败 (${e.message})，切换下一个代理`);
          lastError = e;
        } else {
          throw e;
        }
      } finally {
        if (ctx) ctx.sm.shutdown();
      }
    }

    throw lastError || new Error('所有代理都连接失败');
  }

  // ── 登录 ───────────────────────────────────────────────────
  async _login({ sm, account }, options) {
    const api = new AccountLogin(sm);
    let result;
    try {
      result = await api.execute({ ...options, forceRelogin: true });
    } catch (e) {
      // AccountLogin 登录失败时抛异常，需在此处检测封号关键词
      const errMsg = e.message || '';
      if (errMsg.includes('违规行为') || errMsg.includes('被限制使用')) {
        this.configDb.prepare('UPDATE accounts SET is_banned = 1 WHERE id = ?').run(account.id);
        sm._log('⛔ 账号已被封禁，已标记封号状态');
      }
      throw e;
    }
    sm._log(result.code === 0 ? '登录完成' : `登录失败: ${result.msg}`);
    return { code: result.code, msg: result.msg };
  }

  // ── 添加患者 ───────────────────────────────────────────────
  async _addPatient({ sm, adb, account }, options) {
    if (!sm.sessionData?.auth_token) throw new Error('账号未登录，请先登录');
    const hospitalAccountId = sm.getHospitalAccountId();
    if (!hospitalAccountId) throw new Error('未获取到医院账号 ID，请先登录');

    const { idNo, name, sex } = options;
    if (!idNo || !name || !sex) throw new Error('缺少患者信息：idNo/name/sex 均为必填');
    const parsed = parseIdCard(idNo);
    if (!parsed) throw new Error('身份证号格式不正确，无法解析出生日期');
    const birthday = parsed.birthday;

    const R = C.PATIENT_ADD_RETRY;
    let attempt = 0;

    while (attempt < R.MAX_ATTEMPTS) {
      attempt++;
      try {
        const sexForBind = sex === '1' ? 'MALE' : 'FEMALE';
        const bindApi = new PatientBind(sm);
        const bindResult = await bindApi.execute({
          accountId: hospitalAccountId,
          mobileNo:  account.mobile,
          idNo, name, birthday, sex: sexForBind
        });

        if (bindResult && bindResult.code === 0) {
          // 保存就诊人到本地
          const list = Array.isArray(bindResult.value) ? bindResult.value : [];
          const p = list.find(x => x.idNo === idNo || x.paperNo === idNo) || list[list.length - 1];
          if (p) {
            adb.createPatient({ accountId: account.id, patientId: p.id, name: p.name, idCard: p.idNo || p.paperNo });
            await sm.loadSession();
          }

          // 建档（不加密，plain JSON）
          try {
            const birthdayRaw = birthday.replace(/-/g, '');
            const genderCN    = sex === '1' ? '男' : '女';
            const createApi   = new CreatePatient(sm);
            await createApi.execute({ cardNo: idNo, patientName: name, sex: genderCN, birthday: birthdayRaw, mobile: account.mobile });
          } catch (e) {
            sm._log(`建档异常（不影响绑定结果）: ${e.message}`);
          }

          return { code: 0, msg: '患者添加成功' };

        } else if (bindResult?.msg?.includes('已经绑定')) {
          // 该身份证已绑定其他账号，不必重试
          return { code: bindResult.code, msg: bindResult.msg };
        } else {
          if (attempt < R.MAX_ATTEMPTS) {
            const delay = Math.min(R.BASE_DELAY * Math.pow(2, attempt - 1), R.MAX_DELAY);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      } catch (e) {
        if (attempt < R.MAX_ATTEMPTS) {
          const delay = Math.min(R.BASE_DELAY * Math.pow(2, attempt - 1), R.MAX_DELAY);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw e;
        }
      }
    }

    return { code: -1, msg: `添加患者失败（已重试 ${R.MAX_ATTEMPTS} 次）` };
  }

  // ── 删除患者 ───────────────────────────────────────────────
  async _removePatient({ sm, adb, account }, options) {
    if (!sm.sessionData?.auth_token) throw new Error('账号未登录，请先登录');
    const { patientId } = options;
    if (!patientId) throw new Error('缺少 patientId');

    const api = new PatientUnbind(sm);
    const result = await api.execute(patientId);

    if (result && result.code === 0) {
      const rows = adb.findPatientsByAccountId(account.id).filter(p => String(p.patient_id) === String(patientId));
      rows.forEach(p => adb.deletePatientById(p.id));
      await sm.loadSession();
    }
    return { code: result?.code, msg: result?.msg };
  }

  // ── 执行用户行为 ───────────────────────────────────────────
  async _userBehavior({ sm }) {
    if (!sm.sessionData?.auth_token) throw new Error('账号未登录，请先登录');
    return await executeUserBehavior(sm);
  }

  // ── 获取挂号记录 ───────────────────────────────────────────
  async _getSourceRecords({ sm, adb, account }) {
    if (!sm.sessionData?.auth_token) throw new Error('账号未登录，请先登录');
    const patients = adb.findPatientsByAccountId(account.id);
    if (patients.length === 0) throw new Error('该账号暂无就诊人，请先添加患者');

    let totalSaved = 0;
    for (const patient of patients) {
      sm._log(`查询患者 ${patient.name} 的挂号记录`);
      try {
        const api    = new SourceRecordList(sm);
        const result = await api.execute(patient.patient_id);
        if (result && result.code === 0 && Array.isArray(result.value)) {
          for (const rec of result.value) {
            const saved = adb.createOrUpdateSourceRecord({
              accountId:         account.id,
              recordId:          rec.id,
              patientId:         patient.patient_id,
              patientName:       patient.name,
              doctorCode:        rec.doctorCode,
              doctorName:        rec.doctorName,
              deptCode:          rec.deptCode,
              deptName:          rec.deptName,
              hospName:          rec.hospName,
              regDate:           rec.regDate,
              visitTime:         rec.visitTime,
              visitNo:           rec.visitNo,
              orderFee:          rec.orderFee,
              sourceTradeId:     rec.sourceTradeId,
              sourceStatus:      rec.sourceStatus,
              sourceStatusName:  rec.sourceStatusName,
              status:            rec.status,
              payStatus:         rec.payStatus,
              clinicPlace:       rec.clinicPlace
            });
            if (saved) totalSaved++;
          }
          sm._log(`患者 ${patient.name}: 获取 ${result.value.length} 条记录`);
        }
      } catch (e) {
        sm._log(`患者 ${patient.name} 查询失败: ${e.message}`);
      }
    }

    const records = adb.findSourceRecordsByAccountId(account.id);
    sm._log(`共保存/更新 ${totalSaved} 条记录，总计 ${records.length} 条`);
    return { savedCount: totalSaved, records };
  }

  // ── 获取消息 ───────────────────────────────────────────────
  async _getMessages({ sm, adb, account }) {
    if (!sm.sessionData?.auth_token) throw new Error('账号未登录，请先登录');
    const hospitalAccountId = sm.getHospitalAccountId();
    if (!hospitalAccountId) throw new Error('未获取到医院账号 ID，请先登录');

    sm._log(`查询消息 (hospitalAccountId=${hospitalAccountId})`);
    const api    = new MessageList(sm);
    const result = await api.execute(hospitalAccountId);

    let saved = 0;
    if (result && result.code === 0 && Array.isArray(result.value)) {
      for (const msg of result.value) {
        const ok = adb.createOrUpdateMessage({
          accountId:         account.id,
          messageId:         msg.id,
          hospitalAccountId,
          title:             msg.title,
          titleStr:          msg.titleStr,
          content:           msg.content,
          type:              msg.type,
          readOrNot:         msg.readOrNot,
          effectTime:        msg.effectTime
        });
        if (ok) saved++;
      }
      sm._log(`获取 ${result.value.length} 条消息，保存 ${saved} 条`);
      this._scanRiskMessages(account.id, result.value, sm);
    }

    const messages = adb.findMessagesByAccountId(account.id);
    return { savedCount: saved, messages };
  }

  // ── 风控扫描（从消息列表中提取异常登录 IP，写入风控库）────
  _scanRiskMessages(accountId, messages, sm) {
    const riskMsgs = messages.filter(msg =>
      msg.titleStr === '异常登录提醒' ||
      (msg.content && msg.content.includes('异常登录'))
    );
    if (riskMsgs.length === 0) return;

    const db        = this.configDb;
    const ipRegex   = /IP[：:]\s*(\d+\.\d+\.\d+\.\d+)/;
    const insertIp  = db.prepare('INSERT OR IGNORE INTO risk_flagged_ips (ip) VALUES (?)');
    db.transaction(() => {
      db.prepare('UPDATE accounts SET is_risk_flagged = 1 WHERE id = ?').run(accountId);
      for (const msg of riskMsgs) {
        const m = (msg.content || '').match(ipRegex);
        if (m) insertIp.run(m[1]);
      }
    })();

    if (sm) sm._log(`⚠️ 检测到 ${riskMsgs.length} 条异常登录提醒，账号及相关 IP 已标记为风控`);
  }

  // ── 取消挂号 ───────────────────────────────────────────────
  async _cancelRegistration({ sm, adb }, options) {
    if (!sm.sessionData?.auth_token) throw new Error('账号未登录，请先登录');
    const { sourceTradeId } = options;
    if (!sourceTradeId) throw new Error('缺少 sourceTradeId');

    sm._log(`取消挂号: sourceTradeId=${sourceTradeId}`);
    const api = new SourceApplyCancelLock(sm);
    const result = await api.execute(sourceTradeId);

    if (result && result.code === 0) {
      adb.updateSourceRecordByTradeId(sourceTradeId, {
        sourceStatus: 'CANCEL', sourceStatusName: '已取消', status: 'cancelled',
      });
      sm._log('取消挂号成功');
      return { code: 0, msg: '取消挂号成功' };
    }

    const msg = result?.msg || '取消失败';
    sm._log(`取消挂号失败: ${msg}`);
    return { code: result?.code ?? -1, msg };
  }

  // ── 读取已有挂号记录（不发请求）─────────────────────────────
  getStoredSourceRecords(gamyyAccountId) {
    return this.adb.findSourceRecordsByAccountId(gamyyAccountId);
  }

  // ── 读取已有消息（不发请求）──────────────────────────────────
  getStoredMessages(gamyyAccountId) {
    return this.adb.findMessagesByAccountId(gamyyAccountId);
  }
}

module.exports = AccountOperationService;
