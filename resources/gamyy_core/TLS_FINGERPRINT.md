# TLS 指纹（account 查号/锁号）

让查号/锁号/查票请求带上**可控的真实 TLS 指纹（JA3/JA4）**，用于探测服务器端对指纹的校验逻辑、
并在需要时精确冒充真机客户端。**两条请求路径都已接入**：

- **本地路径** `account/HttpClient`（Web 层账号操作，从本地 IP 发出）
- **云端路径** `services/connectionChannel`（agent/server.js 部署到云服务器，查票/锁号业务请求从云端 IP 发出——
  这是 IP 分布式抢号的主力路径，见 DEPLOY.md）

两条路径共用同一个 fp-sidecar 引擎与代理层指纹配置。

## 为什么需要

- `account/HttpClient` 原本走 Node 内置 TLS（OpenSSL），JA3/JA4 是固定的「Node 指纹」，且无法自由伪造
  （扩展顺序、GREASE 等不可控）。
- SOCKS5 代理层与 TLS 指纹正交：代理只转发 TCP，ClientHello 由本地 TLS 栈生成。要换指纹必须换 TLS 引擎。
- 方案：引入 Go uTLS 写的 **fp-sidecar**（终结 TLS 的本地 CONNECT 代理），指纹按「代理层」配置选取。

## 架构

```
account/HttpClient（本地）   ┐
                            ├─明文经CONNECT隧道─▶ fp-sidecar ─uTLS指纹握手─▶ (可选)上游SOCKS5 ─▶ 目标服务器
services/connectionChannel（云端）┘
```

- Node 侧隧道走明文，account 的加密/headers/body 逐字节原样进目标 TLS 会话；sidecar 负责施加指纹。
- 开关：环境变量 `FP_SIDECAR_ADDR`（如 `127.0.0.1:8788`）。**设了才走 sidecar；不设则保持原生 https.request（零变更）。**

## 组成

| 组件 | 文件 | 作用 |
|---|---|---|
| 指纹注册表 | `services/fingerprints.js` | 抓包提取的真实指纹（唯一真源）+ `resolveFingerprint(name→对象)` |
| 原始 ClientHello | `services/clienthellos/*.hex` | raw 模式精确重放用的真机 ClientHello 字节（放 services/ 下，随精简 agent 一起上传云端） |
| sidecar 客户端 | `services/sidecarClient.js` | 共享：建指纹头 / 上游 socks 串 / CONNECT 隧道（两条路径共用） |
| 本地请求路径 | `account/HttpClient.js` | `FP_SIDECAR_ADDR` 设了走 `_requestViaSidecar`（手动 HTTP/1.1 收发），否则原生 |
| 云端请求路径 | `services/connectionChannel.js` `_attemptConnectViaSidecar` | 设了 `FP_SIDECAR_ADDR` 则通道经 sidecar 隧道（明文多路复用），否则原生 `tls.connect` |
| 代理层配置 | `services/_proxyCfg.js` `fingerprint()`；`web/routes/tasks.js` 组装 `cfg.fingerprint` | 每代理一份指纹，默认回退 `android_app` |
| DB 列 | `proxy_templates.fingerprint_config` / `proxies.fingerprint_config` | 模板默认 `{"name":"android_app"}`，代理可覆盖 |
| 前端 | `frontend/src/views/Templates.vue`「TLS指纹」tab | 下拉选指纹 + 显示 JA3/JA4 |
| 列表接口 | `web/routes/fingerprints.js` `GET /api/fingerprints` | 给前端下拉用 |
| 引擎 | `fp-sidecar/`（Go, uTLS） | 见 `fp-sidecar/README.md` |

## 抓包的真实指纹（目标 hlwyl.gamyy.cn）

| name | 客户端 | 关键指标 | 模式 |
|---|---|---|---|
| `android_app`（默认） | Android App（小米/一加一致） | JA3 `f79b6bad…`，ALPN http/1.1，无 GREASE | raw 精确重放 |
| `wx_miniprogram` | 电脑版微信小程序（Chrome120） | JA4 `t13d1516h2_8daaf6152771_02713d6af862` | preset HelloChrome_120 |
| `legacy_h2` | h2 客户端（疑 iOS） | JA3 `cd08…`（含 GREASE） | raw 精确重放 |

account 走 HTTP/1.1 + Android UA → 默认用 `android_app`，三者自洽。验证：sidecar 重放打 tls.peet.ws，
android JA3 精确匹配、wx JA4 精确匹配、legacy JA3 精确匹配。

## 本地启用

```bash
# 1. 构建并启动 sidecar
go -C fp-sidecar build -o fp-sidecar.exe .
fp-sidecar.exe -addr 127.0.0.1:8788
# 2. 启动 gamyy-core 前设置环境变量
set FP_SIDECAR_ADDR=127.0.0.1:8788   # Windows；Linux 用 export
# 3. 在 Web「代理配置模板」的「TLS指纹」tab 选指纹（默认 android_app）
```

## 云端部署

由 `cloud_proxy_pool` 自动部署（见该项目 config.py 的 `FP_SIDECAR_*`）：
开 `fp_sidecar_enabled` 后，部署时自动上传 Linux 版 sidecar 二进制、PM2 拉起、并给 node 进程注入 `FP_SIDECAR_ADDR`。
需先交叉编译：`GOOS=linux GOARCH=amd64 go -C fp-sidecar build -o fp-sidecar .`

## 已知取舍

- **account 本地路径**目前强制 `Connection: close`（每请求一条隧道），稳但无复用、偏慢；本地账号操作量小，够用。
- **connectionChannel 云端路径**保持长连接多路复用：通道经 sidecar 隧道一次建连后反复发请求/心跳，
  sidecar 只做字节桥接，与原生 `tls.connect` 行为对齐，无额外开销。
- android 的 JA4 第三段与 tshark 计算略有出入（peet.ws vs tshark 实现差异），JA3 精确一致。
- 指纹理想应与账号设备信息（account_devices）一致；当前先按代理层配置，测试稳定后可把取值源改到按账号。
- 验证：sidecar 重放打 tls.peet.ws，account 与 connectionChannel 两条路径的 Android JA3 均精确匹配 `f79b6bad…`。
