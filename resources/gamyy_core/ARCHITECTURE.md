# gamyy-core 项目设计思路

> 本文回答的不是"怎么部署",而是"**为什么这么设计**"。部署细节见 [DEPLOY.md](./DEPLOY.md)。

---

## 一、整体架构的演进与动机

### 1. 最初:纯本地执行
查号 / 锁号请求从本地机器发出,所有任务跑在同一台机器、同一个 IP。
缺点:
- IP 容易被目标系统限速或封禁
- 单机算力 / 网络带宽是硬上限
- 关掉本地程序任务就停

### 2. 中间方案:SSH 隧道代理(已废弃)
为了换 IP,买了若干阿里云服务器,用 `ssh -D` 在本地建 SOCKS5 动态转发端口(例如 `localhost:5002`),所有请求从本地出 → 隧道 → 云服务器 → 目标。
缺点:**多一跳**。所有业务流量都要经过本地→云端的 SSH 隧道,既增加延迟,也让本地带宽成为瓶颈,云端只是个"网络中继"。

### 3. 当前方案:云端部署精简 agent
把"查号 / 锁号"模块单独打包,通过 `cloud_proxy_pool` 批量部署到云服务器上。本地只把**任务配置**(账号凭证、医生 / 日期 / 患者目标、查号窗口、锁号参数)通过 HTTP 推到云端,云端独立执行业务请求,本地周期性轮询状态。
优势:
- 业务请求**直接从云端发出**,没有中转
- 本地→云端只走轻量的配置下发 + 状态查询(HTTP / JSON)
- 关掉本地管理端,云端任务继续跑
- 每台云端独立 IP,横向扩展只需多部署几台

---

## 二、三个项目的分工

| 项目 | 路径 | 语言 | 角色 |
|---|---|---|---|
| **gamyy-core**(本地端) | 本仓库 | Node.js + Vue | Web 管理界面 + 账号 / 任务 / 代理配置库 + 任务调度协调器 |
| **gamyy-agent**(云端) | 本仓库的 `agent/`+`services/`+`models/`+`crypto/`+`database/`+`utils/`,通过 [`deploy.sh`](./deploy.sh) 部署到云服务器 | Node.js | 接收本地推送的 config,独立驱动查号 / 锁号,本地不可见时也持续运行 |
| **cloud_proxy_pool** | `E:\gamyy_proxy\cloud_proxy_pool` | Python(tkinter GUI + 后台) | 维护 SSH 隧道池(`localhost:5002` SOCKS5)、批量部署 / 监控云端 agent、流量回收 |

**三者解耦的关键约定:**
- gamyy-core 通过 `localhost:5002` SOCKS5 出口连接云端的 SSH(22) 与 agent(7070),不直连云端 IP
- cloud_proxy_pool **被动**提供端口,不和 gamyy-core 共库;gamyy-core 在 `proxies.cloud_agent_url` 字段里手动登记云端 agent 地址(如 `http://101.200.241.73:7070`)
- 云端 agent 完全不知道本地 DB 的存在,所有需要的数据由本地 HTTP 推送,**账号凭证仅在内存中,不落盘**

---

## 三、核心数据模型

### 1. 三层实体
```
account (账号)
   │
   ├── 多个 task (任务,只承载"目标"语义:医生 / 日期 / 患者)
   │      └── task_proxies 快照(启动时定型)
   │
   ├── 多个 proxy (任务代理,proxies.account_id 关联,用于查号 / 锁号)
   │
   └── 1 个 ops_proxy (操作代理,accounts.ops_proxy_id 关联,用于登录 / 患者管理等账号侧请求)
```

### 2. proxies 表的双重角色
同一张 `proxies` 表,**同一行可能同时担任两种角色**:

| 角色 | 关联方式 | 开关字段 | 谁用 |
|---|---|---|---|
| 任务代理 | `proxies.account_id` → `accounts.id` | `enabled` | 任务运行时按 `task_proxies` 快照取 |
| 操作代理 | `accounts.ops_proxy_id` → `proxies.id` | `ops_enabled` | `AccountOperationService._getAssignedProxies` |

(详见 [`web/db/schema.js`](./web/db/schema.js))

### 3. proxies 表里"代理"的两种语义
`proxies` 表存的不只是网络代理,还包括"云服务器槽位"。靠 `cloud_agent_url` 区分:

| `cloud_agent_url` | 实际语义 | 业务请求出口 IP |
|---|---|---|
| **空** | 真·网络代理(本地 socks5 / SSH 隧道 / direct) | 本地机器走代理后的出口 |
| **非空** | 云服务器槽位(指向一台部署了 gamyy-agent 的云服务器) | **云服务器自己的 IP**,不经任何代理 |

⚠️ **重要**:云端 agent 内部**不挂任何代理**([`agent/server.js`](./agent/server.js) 全文无 socks/http-proxy 引入)。它收到本地推的 config 后,`SchedulerService` 直接出请求,云服务器自身 IP 就是业务出口。所以"云端代理"这个词容易误导——把它理解成"**云服务器**"更准确。

### 4. 任务 ↔ 代理的关系(关键约束)
**1 代理只能服务 1 任务**(同账号内)。在 [`web/routes/tasks.js:91-101`](./web/routes/tasks.js) 建任务时,SQL 用 `NOT IN (该账号已被占用的 proxy_id)` 强制只挑空闲代理,绑定后不会被第二个任务抢占。
- 这意味着实际部署中,**通常 1 任务对应 1 代理**(更准确:1 任务对应 1 个云服务器),`task_proxies` 表里每行就是这条 1:1 绑定的快照
- 框架仍按"任务可能挂多个代理"实现([`TaskRunner.js:128-136`](./web/services/TaskRunner.js) 按 `cloud_agent_url` 分组),向后兼容 1:N 场景,但当前规模下基本是 1:1

### 4. 任务级配置已下沉到代理级
查号窗口、锁号参数、通道构建、目标主机等差异化配置全部在 `proxies` / `proxy_templates` 上,任务表 `tasks` 只剩"目标"三字段。
**好处**:同一任务下不同代理可以有不同的查号节奏 / 锁号策略,云端按代理粒度调度。
**关键不变量**:`task_proxies` 是启动时拍下的快照,运行中即使代理表被改动也不会影响在跑的任务。

---

## 四、批量启动任务的完整生命周期

这是最复杂的路径,也是用户最关心的部分。下面按时间顺序拆解。

### 阶段 0:用户在 Web 界面点"批量启动"
- 入口:[`frontend/src/views/Accounts.vue:2006`](./frontend/src/views/Accounts.vue) 的 `runBatchStartTasks()`
- 选中 N 个账号,收集其下所有"已启用、未运行"的任务,组装 `taskTargets`
- 前端用**滚动 worker pool**(`CONCURRENCY = 100`,[`Accounts.vue:2029`](./frontend/src/views/Accounts.vue))并行调 `POST /api/tasks/:id/start`
- 注释明确写:**速率最终由后端 `_startSem(15)` + per-agentUrl 熔断接管,前端放开并发**
- 单条请求的 axios timeout:`startTask` 覆盖为 **300s**(适配最坏 4 次重试 + backoff),`stopTask` 覆盖为 60s,其余沿用全局默认 15s

> 这里的设计哲学:前端不做节流,前端只负责"尽快发完"+ UI 反馈;削峰是后端职责。前端 `Promise.all` 分批 会有"木桶效应"(慢任务拖整批),滚动窗口避免这个。

### 阶段 1:后端任务编排
路由:[`web/routes/taskControl.js`](./web/routes/taskControl.js) `POST /:id/start`
- 从 DB 读账号 / 系统配置 / `task_proxies` 快照
- 三层合并 per-proxy 配置(系统默认 → 代理模板 → 代理覆盖)
- **管理通信通道选择**:读 `system_config.cloud_dispatch_via_proxy`,若开启且任务含云端代理,把账号的 ops_proxy(host/port/user/pwd)注入 `config.cloudDispatch.opsProxy`,所有 cloudAgentClient 调用都会走该 SOCKS5 代理转发
  - **严格拒绝**:开关开但账号无 ops_proxy(或代理是 direct / 无本地端口)→ 直接 400 拒绝启动,不悄悄回退直连
- 组装 `config` 对象后委托给 `req.taskRunner.start(taskId, config)`

### 阶段 2:TaskRunner 启动流程([`web/services/TaskRunner.js`](./web/services/TaskRunner.js))

按 `cloud_agent_url` 把代理分组成 N 个云端组 + 1 个本地组,然后:

#### 阶段 2-A:**熔断检查**(替代原"探活")
> 原"探活阶段"已移除。理由:2000 任务规模下探活会带来等量 HTTP 请求,且 3s 探活窗口未必能识别瞬时抖动,反而把"偶发失败"的任务直接判到 fallback。改成直接进入启动 + 重试。
- 遍历所有云端组,只跳过当前在熔断窗口内的 `agentUrl`(历史已知坏 agent,避免浪费一次 60s 启动尝试)
- 非熔断的全部进入阶段 2-B

#### 阶段 2-B:**并行启动 + 3 次重试**(削峰点 1)
- 对每个 agent 调 `POST /run` 推送 config
- 受 `_startSem`(15 并发上限)限速([`TaskRunner.js`](./web/services/TaskRunner.js))
- **重试策略**(两套 backoff,根据是否走代理选择):
  - 总尝试次数 = 1 次初始 + 3 次重试 = **4 次**
  - **直连**:每次失败后 backoff `[4s, 8s, 16s]`;单次 /run timeout 60s;最坏 4 × 60 + 28 = **268s**
  - **走代理**:每次失败后 backoff `[8s, 16s, 32s]`;单次 /run timeout 120s;最坏 4 × 120 + 56 = **536s**
  - **backoff 期间不持有信号量**(释放后再 sleep,避免阻塞其他任务推进)
- 4 次都失败 → 累计 1 次"熔断失败",该 agent 对应代理走 fallback

#### 阶段 2-C:**本地降级**
- 把(4 次启动都失败 + 原本就是本地)的代理合并,跑一次本地 SchedulerService
- 这是降级路径,保证"哪怕全部云端挂了,任务仍能在本地继续"

### 阶段 3:稳态轮询(削峰点 2)
- 每个云端 handle 独立用 `setTimeout` 自重调度,**非 `setInterval`**(避免停止后僵尸定时器)
- 轮询间隔 `POLL_INTERVAL = 30s`
- **首次触发延迟 = `Math.random() * POLL_INTERVAL`**(在 [0, 30s) 内随机抖动)
- **效果**:N 个 handle 在 30s 窗口内伪均匀分布,无槽位边界突发。2000 个 handle → 平均 ~67 req/s(`/status` + `/stats` 两个请求,合计 ~134 req/s),无明显尖峰

### 阶段 4:HTTP 层削峰(削峰点 3)
[`web/services/cloudAgentClient.js`](./web/services/cloudAgentClient.js):
- **直连模式**:`http.Agent` keep-alive,`maxSockets: 3` —— 单云端 host 最多 3 条并发 TCP
- **走代理模式**:per-(host:port:user:pwd) 缓存 `SocksProxyAgent`,同一物理代理被多任务复用,共享 keepAlive 长连接池;`maxSockets: 30` —— 防止 2000 任务的轮询打爆单个代理
- 两种模式有**两套超时表**(direct / proxy),后者整体加倍以容忍代理路径的延迟与抖动

### 阶段 5:熔断保护([`TaskRunner.js`](./web/services/TaskRunner.js) `_breaker*` 方法)
- 每个 `agentUrl` 独立维护失败计数。**一次失败 = 4 次重试全部失败**(由 `_startCloudHandle` 内部重试吸收偶发抖动后才计数)
- 累计连续 ≥ 3 次"4-连败"→ 进入熔断,60s 内该 agent 直接走 fallback,不再尝试
- 设计目的:在"重试已经容忍偶发失败"的前提下,再为"持续坏掉的 agent"加一道保护墙

---

## 五、典型时序示例(2000 云服务器规模)

按当前实际部署:**2000 台云服务器,每台 1 个任务**(对应 2000 条 `cloud_agent_url` 非空的 proxy 记录,1:1 绑定 2000 个任务)。批量启动 2000 任务时:

**T0(用户点击)**:前端 100 worker 滚动调度,持续向后端发 `/api/tasks/:id/start`
**T0+0~Ns**:后端 2000 次 TaskRunner.start 排队

**阶段 A 启动 + 重试**(`_startSem = 15`,无探活):
- 2000 个 `POST /run` 排队,15 并发
- **正常情况**(每个 1~3s 成功):2000 / 15 × 2s = **约 4~5 分钟**完成全部启动
- **单 agent 抖动**:`_startCloudHandle` 内部重试 3 次(4s/8s/16s backoff),通常 1~2 次内恢复;最坏 4 次全失败 ≈ 268s 才放弃
- **绝大多数偶发失败被重试吸收**,真正掉到 fallback 的只剩"持续坏掉的 agent",规模缩到极小

**阶段 B 稳态轮询**:
- 2000 个 handle 各自每 30s 一轮 status + stats
- 首次延迟 `Math.random() * 30000`,handle 在窗口内均匀分布
- 平均 ~67 req/s × 2 = **~134 req/s**,真正均匀(无槽位边界突发)
- 单台云端:1 个任务 × (1/30s × 2) = **0.067 req/s**,云端单台零压力

> **本规模下削峰的重点不是"防雷击"** —— 2000 个独立目标 host,本地端口 / 套接字限制不构成瓶颈。**真正的关注点是"如何把更多任务送到云端,不让它们因为偶发失败就掉回本地"**,这正是当前重试设计要解决的核心问题。

---

## 六、关键调优参数

所有"魔数"集中在 [`web/services/TaskRunner.js`](./web/services/TaskRunner.js) 顶部:

| 常量 | 位置 | 当前值 | 意义 |
|---|---|---|---|
| `POLL_INTERVAL` | `TaskRunner.js` | 30000ms | 状态轮询间隔 |
| `_startSem` | `TaskRunner.js` | 15 | 启动并发上限,保护云端 |
| `STARTTASK_MAX_ATTEMPTS` | `TaskRunner.js` | 4(1 初始 + 3 重试) | /run 最多尝试次数 |
| `STARTTASK_BACKOFF_MS_DIRECT` | `TaskRunner.js` | `[4s, 8s, 16s]` | 直连重试 backoff |
| `STARTTASK_BACKOFF_MS_PROXY` | `TaskRunner.js` | `[8s, 16s, 32s]` | 走代理重试 backoff(更宽松) |
| `BREAKER_FAIL_THRESHOLD` | `TaskRunner.js` | 3 | 熔断触发的连续"4 连败"次数 |
| `BREAKER_COOLDOWN_MS` | `TaskRunner.js` | 60000 | 熔断冷却时长 |
| `TIMEOUTS.direct` | `cloudAgentClient.js` | startTask 60s / stop 10s / 其他 8s | 直连各端点超时 |
| `TIMEOUTS.proxy` | `cloudAgentClient.js` | startTask 120s / stop 30s / 其他 20s | 走代理各端点超时(整体加大) |
| `maxSockets` 直连 per host | `cloudAgentClient.js` | 3 | 单云端 TCP 并发 |
| `maxSockets` 代理 per agent | `cloudAgentClient.js` | 30 | 单 SOCKS5 代理的总连接数(防 2000 轮询打爆代理) |
| `startTask` 前端 timeout | `frontend/.../api/index.js` | 600000ms (10 min) | 前端等后端响应的上限 |
| `stopTask` 前端 timeout | `frontend/.../api/index.js` | 120000ms (2 min) | 停止请求超时 |
| `cloud_dispatch_via_proxy` | `system_config` 表 | 1(开启) | 全局开关,管理通信是否走 ops_proxy 转发 |

---

## 七、关键文件索引

| 关注点 | 文件 |
|---|---|
| 数据模型 | [`web/db/schema.js`](./web/db/schema.js),[`web/db/configDb.js`](./web/db/configDb.js) |
| 任务编排核心 | [`web/services/TaskRunner.js`](./web/services/TaskRunner.js) |
| 云端通信客户端 | [`web/services/cloudAgentClient.js`](./web/services/cloudAgentClient.js) |
| 启动路由 | [`web/routes/taskControl.js`](./web/routes/taskControl.js) |
| 云端 agent 入口 | [`agent/server.js`](./agent/server.js) |
| 查号 / 锁号业务 | [`services/SchedulerService.js`](./services/) |
| 账号操作(登录 / 患者 / 注册) | [`account/`](./account/) |
| 前端批量启动 | [`frontend/src/views/Accounts.vue`](./frontend/src/views/Accounts.vue) `runBatchStartTasks` |
| 部署运维 | [`DEPLOY.md`](./DEPLOY.md),[`deploy.sh`](./deploy.sh) |

---

## 八、设计原则总结

1. **本地是控制平面,云端是数据平面**。本地只持有配置 + 协调状态,不参与业务请求。
2. **代理是最小调度单位**,不是任务。任务只是"目标 + 代理集合"的元数据。
3. **快照优于实时引用**。`task_proxies` 在启动时拍快照,避免运行中代理表被改动导致漂移。
4. **多级削峰,分层防御**。前端不节流 → 后端信号量节流 → HTTP keep-alive 限连 → 熔断快速失败,每层各司其职。
5. **降级而非失败**。任何一层(探活 / 启动 / 单 agent)失败,都把对应代理推入 fallback 跑本地,不让单点故障阻断整个任务。
6. **不存敏感数据到云端磁盘**。账号 token、s456hr8、user_agent 仅在 HTTP body 中传到云端内存,云端不落盘。
7. **管理通信可选走 ops_proxy 转发**。系统开关 `cloud_dispatch_via_proxy` 开启时,本地→云端 agent 的所有 HTTP 通信(/run / /status / /stats / /stop)经该账号的操作代理转发,云端 agent 看到的请求来源 IP 不再是本地公网 IP,而是某个代理 IP —— 与该账号"业务请求从操作代理出"的语义一致。开关关闭则本地公网 IP 直连(原行为)。该开关**只影响本地→云端的链路**,云端 agent 的业务请求出口仍是云端自身 IP,云端无感无需重新部署。
