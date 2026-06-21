# 云端 Agent 部署说明

## 一、背景与目的

### 整体架构

本项目分为两个独立的运行端：

```
┌─────────────────────────────────┐         ┌──────────────────────────────────┐
│         本地管理端               │         │         云端执行端                │
│                                 │  HTTP   │                                  │
│  Web 管理界面（浏览器）           │ ──────▶ │  agent/server.js                 │
│  web/server.js（Express）        │         │  监听 :7070                      │
│  config.db（账号/任务/代理配置）  │         │  接收任务配置，驱动查号锁号        │
│                                 │         │                                  │
└─────────────────────────────────┘         └──────────────────────────────────┘
         本地机器                                    云服务器 101.200.241.73
```

### 网络拓扑

本地与云服务器之间通过 **cloud_proxy_pool 项目**维护的 SSH 动态转发代理连接：

```
本地机器
  │
  ├─ localhost:5002  ←── cloud_proxy_pool 维护的 SOCKS5 代理出口
  │                       （SSH 动态转发，-D 模式）
  │
  └─── SOCKS5 隧道 ───▶ 云服务器 101.200.241.73:22（SSH）
                                    │
                                    └─▶ :7070（gamyy-agent 监听）
```

> **注意**：localhost:5002 是 SOCKS5 代理，不是 SSH 端口转发，不能直接 `ssh -p 5002`。

### 为什么要部署到云服务器

1. **IP 隔离**：查号/锁号请求从云服务器 IP 发出，规避本地 IP 被限速或封禁。
2. **稳定运行**：云服务器 24 小时在线，本地管理界面关闭后云端任务仍继续。
3. **分布式扩展**：每台云服务器部署一个 agent，通过不同的 `cloud_agent_url` 分发到多台服务器实现多 IP 并发。
4. **职责分离**：本地端管理配置，云端只负责执行，账号凭证仅在内存中传输，不落盘。

---

## 二、本地端与云端的交互流程

```
1. 用户在 Web 界面点击「启动任务」
         ↓
2. taskControl.js 从 config.db 读取账号凭证 + 该任务下每个代理的有效配置
   （系统 → 代理模板 → 代理覆盖 三层合并），组装 config 对象：
   - 顶层：账号信息、连接池/超时/keepAlive 等系统级字段
   - _accounts：账号凭证 + 任务目标（医生/日期/患者）
   - _proxies[i]：每个代理及其独立的 cfg
     （checkRequest / lockRequest.global / channelBuildPhase1 / queryParams 等
      均按代理粒度生效，云端在代理上下文中读取自己的 cfg，回退到顶层）
         ↓
3. 检测到代理的 cloud_agent_url 字段不为空
         ↓
4. cloudAgentClient.js 向云端 POST /run，推送 config
         ↓
5. 云端 agent 立即响应 200，后台启动 SchedulerService 执行查号
         ↓
6. 本地每 10 秒 GET /status/:taskId 轮询任务状态
         ↓
7. 任务完成后云端状态变为 completed/stopped，本地清除轮询定时器
```

账号 token、s456hr8、user_agent 等**仅在启动时通过 HTTP 传到云端内存，不写入磁盘**。

### 任务级配置已下沉到代理级

> 自 2026-05 重构：任务（tasks 表）只承载"目标"语义（doctor_code / lock_plan_date / patient_id）。
> 抢号策略、查号窗口、锁号参数、通道构建、目标主机等差异化配置全部下沉到 **proxies / proxy_templates**。
> "任务模板"已废弃，模板系统统一为"代理模板"。新建任务时可选代理模板，应用到该任务下所有代理。
> 同一任务下不同代理可拥有不同的查号开始时间、窗口、锁号参数等，云端 agent 按代理粒度调度。

---

## 三、需要部署到云端的文件

### 必须上传的文件/目录

```
项目根目录/
├── agent/
│   └── server.js              ← 云端入口，HTTP 服务器，监听 :7070
├── services/                  ← 查号/锁号全部业务逻辑
├── models/                    ← 日志数据模型（RequestLog、lockRequestLog、channelLog）
├── crypto/
│   └── cryptoUtils.js         ← 请求签名加密工具
├── database/
│   └── logDb.js               ← 日志写入（sqlite3 异步版，自动建表）
├── utils/
│   └── proxyManager.js
└── package-agent.json         ← 云端专用依赖清单（上传后重命名为 package.json）
```

### package-agent.json 说明

云端 agent **不需要** `better-sqlite3`（Web 管理层的同步 SQLite）、`express`、`cors`、`node-cron`、`ws` 等本地专用依赖。使用 `package-agent.json` 避免编译不必要的原生模块。

云端实际使用的依赖：

| 包 | 用途 |
|---|---|
| `axios` | HTTP 请求 |
| `brotli` | 响应解压 |
| `crypto-js` | 请求加密 |
| `iconv-lite` | 编码转换 |
| `moment` | 日期处理 |
| `socks` / `socks-proxy-agent` | 代理连接 |
| `sqlite3` | 日志持久化（原生模块，需编译） |
| `uuid` | 唯一 ID 生成 |

> **注意**：`sqlite3` 是原生模块，`deploy.sh` 会在 `npm install` 前自动安装 `build-essential`、`libsqlite3-dev`、`node-gyp` 等编译工具链，无需手动处理。`database/logDb.js` 在极端情况下 `sqlite3` 不可用时仍会自动降级为 console 日志，不影响查号/锁号功能。

### 不需要上传的内容

| 路径 | 原因 |
|---|---|
| `web/` | 本地管理后台，云端不需要 |
| `frontend/` | Vue 源码，云端不需要 |
| `data/config.db` | 本地配置库，账号/任务留在本地 |
| `node_modules/` | 云端重新 npm install 生成 |
| `account/` | 账号注册/操作模块，Web 层专用 |
| `package.json` | 含不必要的原生模块，用 package-agent.json 替代 |

> ⚠️ **云端模块隔离约束（添加 / 修改云端文件前必读）**
>
> 上传到云端的 6 个目录（`agent/`、`services/`、`models/`、`crypto/`、`database/`、`utils/`）里的任何 JS 文件，**禁止 `require` 跨进** `account/` / `web/` / `frontend/`——这 3 个目录不上传，Node 在云端启动时会立刻 `MODULE_NOT_FOUND` 崩溃，pm2 进程秒挂，`/health` 健康检查失败。
>
> 在本地开发时一切正常（因为本地有这些目录），坑只在部署后才暴露。
>
> **判别规则**：新增 / 修改云端目录里的文件时，确认它的 require 链全部落在
>
> 1. 这 6 个上传目录内
> 2. Node 内置模块（`fs` / `path` / `tls` / `crypto` / ...）
> 3. `package-agent.json` 列出的 npm 包
>
> 共享的常量（如 `HOSPITAL_ID = '10097'`、`DEPT_CODE = '110901'`）请**就地内联为字面量**，不要从 `account/constants` 拉。
>
> 自检命令：
> ```bash
> # 出现任何匹配都意味着部署会挂
> grep -rE "require\(['\"]\.\.?\/(account|web|frontend)" agent/ services/ models/ crypto/ database/ utils/
> ```

---

## 四、前置条件

| 条件 | 说明 |
|---|---|
| Node.js ≥ 18（云端） | 部署脚本会自动安装 |
| PM2（云端） | 部署脚本会自动安装 |
| build-essential / gcc（云端） | sqlite3 原生编译需要，脚本自动安装 |
| cloud_proxy_pool 运行中 | localhost:5002 SOCKS5 代理必须可用 |
| SSH 密钥已配置 | 首次部署前运行 `bash setup-ssh-key.sh` |

---

## 五、部署方式（脚本自动化）

项目提供两个脚本，在 **Git Bash 终端**中运行（不要双击）：

### 第一步（仅首次）：建立 SSH 免密登录

```bash
cd /e/gamyy_base_info/gamyy-core-20260420-1
bash setup-ssh-key.sh
```

脚本会通过 SOCKS5 代理连接服务器，上传公钥，此步需要输入一次密码 `938241li.`。

成功后显示：`SSH 免密登录配置成功！`

### 第二步：执行部署

```bash
bash deploy.sh
```

脚本自动完成：
1. 验证 SSH 连通性
2. 检查/安装 Node.js 20、PM2
3. 创建远端目录 `/opt/gamyy-agent`
4. 上传 agent/、services/、models/、crypto/、database/、utils/、package-agent.json
5. 安装编译工具链（build-essential、libsqlite3-dev、node-gyp）
6. npm install（含 sqlite3 原生编译，约 1~2 分钟）
7. PM2 启动/重启进程
8. 健康检查验证

### 代码更新后重新部署

```bash
bash deploy.sh
```

或仅重启（代码未变）：

```bash
bash deploy.sh --restart-only
```

---

## 六、手动部署（备用）

如果脚本无法运行，可手动操作。连接服务器需要通过 SOCKS5 代理：

```bash
# 连接服务器（通过 SOCKS5 代理）
ssh -o ProxyCommand="node /e/gamyy_base_info/gamyy-core-20260420-1/scripts/ssh-proxy-wrapper.sh %h %p" \
    root@101.200.241.73

# 上传文件（scp 同样通过 ProxyCommand）
scp -o ProxyCommand="node ..." -r agent services models crypto database utils \
    root@101.200.241.73:/opt/gamyy-agent/
scp -o ProxyCommand="..." package-agent.json \
    root@101.200.241.73:/opt/gamyy-agent/package.json

# 服务器上安装编译工具 + 依赖
cd /opt/gamyy-agent
apt-get install -y build-essential python3 python3-dev make gcc g++ libsqlite3-dev
npm install -g node-gyp
NODE_OPTIONS="--max-old-space-size=512" npm install --omit=dev --legacy-peer-deps
pm2 start agent/server.js --name gamyy-agent
pm2 save && pm2 startup
```

---

## 七、部署后配置

### 防火墙（保护 7070 端口）

Agent 监听 `0.0.0.0:7070`，**必须**限制访问来源：

```bash
# 只允许本地机器公网 IP 访问（把 YOUR_IP 替换为实际 IP）
iptables -A INPUT -p tcp --dport 7070 -s YOUR_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 7070 -j DROP
apt-get install -y iptables-persistent && netfilter-persistent save
```

### 在 Web 管理界面绑定 Agent URL

1. 打开本地 Web 管理界面 → **代理池** → **SSH** 标签页
2. 找到对应条目，点击编辑
3. 「云端 Agent URL」填入 `http://101.200.241.73:7070`
4. 点击「检测连接」确认 → 保存

### （可选）TLS 指纹 sidecar

若要让 account 查号/锁号请求带真实 TLS 指纹（见 [`TLS_FINGERPRINT.md`](./TLS_FINGERPRINT.md)）：
在 `cloud_proxy_pool` 的 `user_settings.json` 设 `fp_sidecar_enabled: true`，部署时会自动上传
Linux 版 `fp-sidecar` 二进制、PM2 拉起（名 `fp-sidecar`，监听 `127.0.0.1:8788`），并给 node 进程
注入 `FP_SIDECAR_ADDR`。需先交叉编译：`GOOS=linux GOARCH=amd64 go -C fp-sidecar build -o fp-sidecar .`。
不开则保持原生 TLS（零变更）。

---

## 八、目录结构（部署后服务器上）

```
/opt/gamyy-agent/
├── agent/server.js
├── services/*.js
├── models/*.js
├── crypto/cryptoUtils.js
├── database/logDb.js
├── utils/proxyManager.js
├── package.json            ← 由 package-agent.json 上传而来
├── node_modules/
└── data/
    └── ticket_checker.db   ← 运行时自动创建
```

---

## 九、常用运维命令

```bash
# 查看运行状态
pm2 status

# 查看实时日志
pm2 logs gamyy-agent --lines 100

# 重启 / 停止
pm2 restart gamyy-agent
pm2 stop gamyy-agent

# 健康检查（服务器上）
curl http://localhost:7070/health

# 手动停止某个任务
curl -X POST http://localhost:7070/stop/<taskId>
```
