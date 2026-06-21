'use strict';

const CREATE_TABLES = `

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 系统配置（单行）
CREATE TABLE IF NOT EXISTS system_config (
  id                      INTEGER PRIMARY KEY DEFAULT 1,
  target_hosts            TEXT    NOT NULL DEFAULT '[]',
  connect_timeout         INTEGER NOT NULL DEFAULT 300000,
  request_timeout         INTEGER NOT NULL DEFAULT 300000,
  -- 心跳/keepAlive 配置已下沉到代理层（proxy_templates / proxies），系统层不再持有
  cloud_unreachable_action     TEXT    NOT NULL DEFAULT 'fallback',
  cloud_dispatch_via_proxy     INTEGER NOT NULL DEFAULT 1,
  proxy_classifier        TEXT    NOT NULL DEFAULT '{}',
  default_proxy_max_count INTEGER NOT NULL DEFAULT 10,
  app_client_config       TEXT    NOT NULL DEFAULT '{}',
  android_client_config   TEXT    NOT NULL DEFAULT '{}',
  wechat_client_config    TEXT    NOT NULL DEFAULT '{}',
  -- UA 池（按端独立，JSON 数组）；建账号时随机抽 1 条 snapshot 到 account_devices
  app_ua_pool             TEXT    NOT NULL DEFAULT '[]',
  android_ua_pool         TEXT    NOT NULL DEFAULT '[]',
  wechat_ua_pool          TEXT    NOT NULL DEFAULT '[]',
  updated_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_config (id) VALUES (1);

-- 账号（顶级实体，一个账号可对应多个任务）
CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled          INTEGER NOT NULL DEFAULT 0,
  mobile           TEXT    NOT NULL,
  account_type     TEXT    NOT NULL DEFAULT 'wechat',
  account_platform TEXT    NOT NULL DEFAULT 'android',
  proxy_max_count  INTEGER NOT NULL DEFAULT 10,
  open_id          TEXT,
  password         TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending',
  ext_db_path      TEXT,
  is_risk_flagged  INTEGER NOT NULL DEFAULT 0,
  is_banned        INTEGER NOT NULL DEFAULT 0,
  ops_proxy_id     INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  remark           TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mobile)
);

-- 账号设备信息（每账号一条）
-- user_agent / referer / client_version 是该账号的"客户端身份快照"：
--   user_agent     建账号时从 system_config.*_ua_pool 随机抽取一条，永不重抽
--   client_version 建账号时取 system_config 的最新基线；登录成功后若与最新不一致则刷新
--   referer        仅微信端有值，与 client_version 配对，登录刷新时一并更新
CREATE TABLE IF NOT EXISTS account_devices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  device_id      TEXT    NOT NULL,
  uuid           TEXT,
  s456hr8        TEXT,
  user_agent     TEXT,
  referer        TEXT,
  client_version TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 账号会话（每账号一条）
CREATE TABLE IF NOT EXISTS account_sessions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id           INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  auth_token           TEXT,
  submit_sign          TEXT,
  cookie_yizhu4_gam    TEXT,
  cookie_mobile_manage TEXT,
  last_activity        TEXT,
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 账号扩展信息（医院侧账号详情，每账号一条）
CREATE TABLE IF NOT EXISTS account_details_ext (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  hospital_account_id INTEGER,
  token               TEXT,
  open_id             TEXT,
  union_id            TEXT,
  family_id           TEXT,
  last_login_ip       TEXT,
  last_login_time     TEXT,
  login_times         INTEGER NOT NULL DEFAULT 0,
  platform            TEXT,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 就诊人（每账号可多条）
CREATE TABLE IF NOT EXISTS account_patients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  patient_id TEXT,
  name       TEXT,
  id_card    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_patients_account_id ON account_patients(account_id);

-- 挂号记录
CREATE TABLE IF NOT EXISTS account_source_records (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  record_id          TEXT,
  patient_id         TEXT,
  patient_name       TEXT,
  doctor_code        TEXT,
  doctor_name        TEXT,
  dept_code          TEXT,
  dept_name          TEXT,
  hosp_name          TEXT,
  reg_date           TEXT,
  visit_time         TEXT,
  visit_no           TEXT,
  order_fee          TEXT,
  source_trade_id    TEXT    UNIQUE,
  source_status      TEXT,
  source_status_name TEXT,
  status             TEXT,
  pay_status         TEXT,
  clinic_place       TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_source_records_account_id ON account_source_records(account_id);

-- 消息
CREATE TABLE IF NOT EXISTS account_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id          TEXT    UNIQUE,
  hospital_account_id INTEGER,
  title               TEXT,
  title_str           TEXT,
  content             TEXT,
  type                TEXT,
  read_or_not         INTEGER NOT NULL DEFAULT 0,
  effect_time         TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_messages_account_id ON account_messages(account_id);

-- 账号请求日志（仅记录账号操作类请求，不含任务请求）
CREATE TABLE IF NOT EXISTS account_request_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  request_url         TEXT,
  request_method      TEXT,
  request_headers     TEXT,
  request_body_plain  TEXT,
  response_data_plain TEXT,
  response_headers    TEXT,
  duration_ms         INTEGER,
  proxy_host          TEXT,
  proxy_port          INTEGER,
  is_success          INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,
  request_time        TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_request_logs_account_id ON account_request_logs(account_id);

-- 任务（仅承载"目标"语义：医生 / 时间 / 患者）
-- 抢号策略、查号窗口、锁号参数、通道构建等差异化配置全部下沉到代理（proxies / proxy_templates）
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL UNIQUE,
  enabled         INTEGER NOT NULL DEFAULT 1,
  account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  doctor_code     TEXT,
  lock_plan_date  TEXT,
  patient_id      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);

-- 代理配置模板（默认值层；代理本身的非空字段会覆盖模板对应字段）
CREATE TABLE IF NOT EXISTS proxy_templates (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  name                         TEXT    NOT NULL UNIQUE,
  description                  TEXT,
  check_mode                   TEXT    NOT NULL DEFAULT 'doctor',
  check_start_time             TEXT,
  check_window_time            INTEGER,
  check_min_interval           INTEGER,
  check_distribution           TEXT    NOT NULL DEFAULT 'uniform',
  check_stop_after_found_count INTEGER NOT NULL DEFAULT 3,
  check_reuse_channel          TEXT    NOT NULL DEFAULT '{}',
  lock_config                  TEXT    NOT NULL DEFAULT '{}',
  channel_build_overrides      TEXT    NOT NULL DEFAULT '{}',
  doctor_source                TEXT    NOT NULL DEFAULT 'config',
  doctor_select_mode           TEXT    NOT NULL DEFAULT 'random',
  doctor_codes                 TEXT    NOT NULL DEFAULT '[]',
  doctor_plan_date_start       TEXT,
  dept_code                    TEXT,
  dept_plan_date_start         TEXT,
  dept_plan_date_end           TEXT,
  target_hosts                 TEXT    DEFAULT NULL,
  -- 心跳/keepAlive（模板层 = 兜底默认；代理列非空时覆盖）
  keepalive_enabled            INTEGER NOT NULL DEFAULT 1,
  keepalive_interval_min       INTEGER NOT NULL DEFAULT 40000,
  keepalive_interval_max       INTEGER NOT NULL DEFAULT 70000,
  keepalive_request_type       TEXT    NOT NULL DEFAULT 'head',
  keepalive_business_endpoints TEXT    NOT NULL DEFAULT '[]',
  direct_keepalive_enabled     INTEGER NOT NULL DEFAULT 0,
  heartbeat_timeout            INTEGER NOT NULL DEFAULT 300000,
  created_at                   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 代理池（标准 HTTP/SOCKS 代理）
-- 字段优先级：proxies 列（非空）→ proxy_templates 列 → 系统默认
CREATE TABLE IF NOT EXISTS proxies (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id                    TEXT    NOT NULL,
  proxy_type                   TEXT    NOT NULL DEFAULT 'standard',
  host                         TEXT,
  port                         INTEGER,
  group_name                   TEXT,
  platform                     TEXT,
  extra_info                   TEXT    NOT NULL DEFAULT '{}',
  account_id                   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  enabled                      INTEGER NOT NULL DEFAULT 1,
  ops_enabled                  INTEGER NOT NULL DEFAULT 0,
  template_id                  INTEGER REFERENCES proxy_templates(id) ON DELETE SET NULL,
  -- 代理级覆盖字段（null 表示不覆盖，使用模板/系统默认）
  check_mode                   TEXT,
  check_start_time             TEXT,
  check_window_time            INTEGER,
  check_min_interval           INTEGER,
  check_distribution           TEXT,
  check_stop_after_found_count INTEGER,
  check_reuse_channel          TEXT,
  lock_config                  TEXT,
  channel_build_overrides      TEXT    NOT NULL DEFAULT '{}',
  doctor_source                TEXT,
  doctor_select_mode           TEXT,
  doctor_codes                 TEXT,
  doctor_plan_date_start       TEXT,
  dept_code                    TEXT,
  dept_plan_date_start         TEXT,
  dept_plan_date_end           TEXT,
  target_hosts                 TEXT    DEFAULT NULL,
  -- 心跳/keepAlive 代理级覆盖（NULL = 跟随模板）
  keepalive_enabled            INTEGER,
  keepalive_interval_min       INTEGER,
  keepalive_interval_max       INTEGER,
  keepalive_request_type       TEXT,
  keepalive_business_endpoints TEXT,
  direct_keepalive_enabled     INTEGER,
  heartbeat_timeout            INTEGER,
  cloud_agent_url              TEXT    DEFAULT NULL,
  synced_at                    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, proxy_type)
);

CREATE INDEX IF NOT EXISTS idx_proxies_enabled  ON proxies(enabled);

-- 风控 IP 黑名单（从消息中提取的异常登录 IP）
CREATE TABLE IF NOT EXISTS risk_flagged_ips (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  ip  TEXT NOT NULL UNIQUE
);

-- 任务代理快照（建任务时写入，runtime 直接读这里；不再动态切片）
-- 增加代理给账号时不会自动写入 → 已有任务的代理不变
-- 删代理 / 取消代理分配 → 需要手动清理 task_proxies（unassign 路径都会做）
CREATE TABLE IF NOT EXISTS task_proxies (
  task_id    INTEGER NOT NULL REFERENCES tasks(id)   ON DELETE CASCADE,
  proxy_id   INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, proxy_id)
);

CREATE INDEX IF NOT EXISTS idx_task_proxies_task_id  ON task_proxies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_proxies_proxy_id ON task_proxies(proxy_id);

-- 系统配置版本历史（append-only，每次修改系统配置时追加一条，旧记录永不删除）
CREATE TABLE IF NOT EXISTS system_config_versions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  target_hosts            TEXT,
  connect_timeout         INTEGER,
  request_timeout         INTEGER,
  proxy_classifier             TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

`;

module.exports = CREATE_TABLES;
