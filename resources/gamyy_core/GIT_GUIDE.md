# gamyy-core Git 版本管理操作指南

> 仓库地址：https://github.com/lixintuo93-boop/gamyy-core
>
> 远程别名：`origin`
>
> 认证方式：SSH Key（`~/.ssh/id_ed25519_github`）

---

## 目录

- [一、基础概念](#一基础概念)
- [二、日常开发工作流](#二日常开发工作流)
- [三、数据库文件的管理](#三数据库文件的管理)
- [四、分支策略](#四分支策略)
- [五、部署与版本控制整合](#五部署与版本控制整合)
- [六、换电脑 / 新环境部署](#六换电脑--新环境部署)
- [七、commit message 规范](#七commit-message-规范)
- [八、标签（Tag）管理](#八标签tag-管理)
- [九、回退与撤销](#九回退与撤销)
- [十、SSH 密钥管理](#十ssh-密钥管理)
- [十一、常见问题排查](#十一常见问题排查)
- [十二、Git 配置参考](#十二git-配置参考)

---

## 一、基础概念

### 1.1 三个"区域"

```
工作区（Working Directory）         暂存区（Staging Area）          本地仓库（Local Repo）           远程仓库（GitHub）
    │                                    │                             │                              │
    │    git add                          │    git commit               │    git push                  │
    │  ──────────────────▶                │  ──────────────▶            │  ──────────────▶              │
    │                                     │                             │                              │
    │          你修改的文件                │      准备提交的文件           │      已提交的历史              │     GitHub 上的备份
```

### 1.2 文件状态

| 状态 | 含义 | 怎么查看 |
|------|------|----------|
| `Untracked` | 新文件，git 还没管 | `git status` 红色 |
| `Modified` | 已跟踪的文件被改了 | `git status` 红色 |
| `Staged` | 已加到暂存区，等 commit | `git status` 绿色 |
| `Committed` | 已提交到本地仓库 | `git log` |
| `Pushed` | 已推送到 GitHub | GitHub 网页可见 |

### 1.3 本项目的 .gitignore

以下内容**不会**进入版本控制：

```
node_modules/          # 依赖包（npm install 即可恢复）
frontend/node_modules/ # 前端依赖
*.log                  # 日志文件
*.txt                  # 临时文本（README/DEPLOY 除外）
*.pcapng               # 抓包文件
data/*.bak             # 数据库备份
dist/                  # 构建产物
.idea/ .vscode/        # IDE 配置
```

以下内容**会**进入版本控制：

```
*.js *.vue *.html      # 全部源码
*.json                 # 包配置、lock 文件
*.sh *.bat             # 脚本
*.md                   # 文档
data/*.db              # SQLite 数据库（账号/配置）
```

---

## 二、日常开发工作流

### 2.1 最常用流程（改代码 → 提交 → 推送）

```bash
# 1. 确保在项目目录
cd E:/gamyy_base_info/gamyy-core-20260420-1

# 2. 查看改了什么
git status

# 3. 查看具体改动内容
git diff

# 4. 将所有修改加入暂存区
git add .

# 5. 提交（写好备注）
git commit -m "修改了什么，为什么这么改"

# 6. 推送到 GitHub
git push
```

### 2.2 只提交部分文件

```bash
# 只提交某几个文件
git add config/config.js services/TicketService.js
git commit -m "修改查号配置和票务服务"
git push
```

### 2.3 查看历史

```bash
# 查看提交历史（简洁版）
git log --oneline -20

# 查看提交历史（详细信息）
git log --graph --oneline --all

# 查看某个文件的修改历史
git log --oneline config/config.js

# 查看某次提交改了什么
git show fd06b7e

# 查看某次提交改了哪些文件
git show --stat fd06b7e
```

### 2.4 查看当前修改的详细内容

```bash
# 查看尚未暂存的修改（工作区 vs 暂存区）
git diff

# 查看已暂存的修改（暂存区 vs 最后一次 commit）
git diff --staged

# 只看某两个文件的变化
git diff config/config.js services/TicketService.js
```

---

## 三、数据库文件的管理

### 3.1 为什么 db 文件在 git 里

本项目 `data/` 目录下的 SQLite 数据库直接纳入版本控制，原因：

- **config.db** — 包含账号、任务、代理、系统配置等核心数据
- **hospital.db** — 医院映射数据
- **ticket_checker.db** — 票务检查日志

这样 `git clone` 后项目即可直接运行，不需要手动建库、导数据、改配置。

### 3.2 数据库文件的操作注意事项

⚠️ **重要：SQLite 文件是二进制格式，git 无法 diff。**

这意味着：
- `git diff` 只会显示 `Binary files differ`
- 两个人同时改了数据库 → 合并冲突时只能二选一

#### 推荐的数据库修改流程

**场景 A：在 Web 管理界面修改了配置（代理/账号/任务）**

```bash
# 1. 确保数据已保存（Web 界面操作会自动写入 config.db）

# 2. 提交
git add data/config.db
git commit -m "config: 更新代理池配置，新增3台云服务器"

# 3. 推送
git push
```

**场景 B：修改了数据库结构（加字段/加表）**

```bash
# 1. 先备份
copy data\config.db data\config.db.$(date +%Y%m%d_%H%M).bak

# 2. 执行结构变更（通过代码或手动 SQLite）
# ...

# 3. VACUUM 清理空间
sqlite3 data/config.db "VACUUM;"

# 4. 提交
git add data/config.db
git commit -m "schema: config表新增xxx字段，支持xxx功能"

# 5. 推送
git push
```

**场景 C：在另一台电脑上产生了新数据，需要合并回来**

```bash
# 1. 在那台电脑上提交
git add data/config.db
git commit -m "config: 同步服务器A上的最新账号数据"
git push

# 2. 回到本机，拉取
git pull

# 注意：如果两边的 config.db 都改了，git 会报冲突
# 此时需要手动决定用哪个版本：
#   git checkout --theirs data/config.db   ← 用远程版本
#   git checkout --ours data/config.db     ← 用本地版本
```

### 3.3 VACUUM — 定期清理数据库膨胀

```bash
# 如果 data 目录变得很大，执行清理
sqlite3 data/config.db "VACUUM;"
sqlite3 data/hospital.db "VACUUM;"
sqlite3 data/ticket_checker.db "VACUUM;"

# 然后提交清理后的文件
git add data/*.db
git commit -m "maintenance: VACUUM 数据库文件"
git push
```

> 本项目 2026-06-21 发现 config.db 膨胀到 125MB，VACUUM 后降至 0.6MB。
> 建议每次大规模删除日志任务后执行一次。

---

## 四、分支策略

### 4.1 项目分支结构

```
master (main)          ← 稳定版本，随时可部署
  │
  ├── dev              ← 开发分支（日常开发在这里）
  │     │
  │     ├── feature/xxx    ← 功能分支（开发新功能）
  │     └── fix/xxx        ← 修复分支（修 bug）
  │
  └── release/v1.0     ← 发布分支（准备上线）
```

### 4.2 创建开发分支

```bash
# 创建 dev 分支并切换过去
git checkout -b dev

# 推送到 GitHub
git push -u origin dev
```

### 4.3 功能分支开发流程

```bash
# 1. 从 dev 切出功能分支
git checkout dev
git pull origin dev
git checkout -b feature/new-scheduler

# 2. 开发... 多次提交
git add .
git commit -m "feat: 新增调度器并发控制"
git add .
git commit -m "feat: 调度器支持优先级排队"
git push -u origin feature/new-scheduler

# 3. 开发完成，合并回 dev
git checkout dev
git pull origin dev
git merge feature/new-scheduler

# 4. 推送 dev
git push origin dev

# 5. 删除已完成的功能分支
git branch -d feature/new-scheduler
git push origin --delete feature/new-scheduler
```

### 4.4 合并到 master

```bash
# dev 稳定后合并到 master
git checkout master
git pull origin master
git merge dev
git push origin master

# 打一个版本标签
git tag -a v2.1.0 -m "Release v2.1.0: 调度器优化"
git push origin v2.1.0
```

### 4.5 单人开发时的简化方案

如果你一个人开发，可以简化：

```bash
# 直接在 master 上工作（简单粗暴）
git add .
git commit -m "修改xxx"
git push

# 或者只用两个分支：master（稳定）+ dev（开发）
git checkout -b dev
# ... 在 dev 上开发 ...
git checkout master
git merge dev
git push
```

---

## 五、部署与版本控制整合

### 5.1 部署云端的配合流程

本项目云端部署使用 `deploy.sh`，其与 git 的配合：

```bash
# 1. 确认本地代码已提交
git status
# 应该显示 nothing to commit

# 2. 打版本标签
git tag -a deploy-$(date +%Y%m%d-%H%M) -m "云端部署前快照"
git push origin --tags

# 3. 执行部署
bash deploy.sh

# 4. 部署后如果修改了配置（比如新增代理、修改任务）
git add data/*.db
git commit -m "config: 部署后配置更新 - 新增5台云服务器"
git push
```

### 5.2 查看两次部署之间改了什么

```bash
# 查看两次部署标签之间的变化
git log deploy-20260621-1400..deploy-20260622-0900 --oneline

# 查看具体哪些文件变了
git diff deploy-20260621-1400..deploy-20260622-0900 --stat

# 只看某个目录的变化
git diff deploy-20260621-1400..deploy-20260622-0900 -- services/
```

### 5.3 部署历史的版本追溯

```bash
# 查看所有部署标签
git tag -l 'deploy-*'

# 如果某次部署出了问题，回退到上一个版本
git checkout deploy-20260621-1400
bash deploy.sh --restart-only
```

---

## 六、换电脑 / 新环境部署

### 6.1 全新的 Windows 电脑

```bash
# 1. 安装 Git（CMD 中执行，无需打开浏览器）
winget install --id Git.Git -e --source winget
# 安装完成后关闭当前 CMD，重新打开即可使用 git

# 2. 配置 Git 用户信息
git config --global user.name "lixintuo93-boop"
git config --global user.email "lixintuo93@gmail.com"

# 3. 生成 SSH Key
ssh-keygen -t ed25519 -C "lixintuo93@gmail.com"

# 4. 复制公钥，添加到 GitHub
type %USERPROFILE%\.ssh\id_ed25519.pub
# 打开 https://github.com/settings/ssh/new
# 粘贴 → Add SSH Key

# 5. 配置 SSH config（在 ~/.ssh/config 中添加）
# Host github.com
#     HostName github.com
#     User git
#     IdentityFile ~/.ssh/id_ed25519_github

# 6. 克隆项目
cd E:/gamyy_base_info
git clone git@github.com:lixintuo93-boop/gamyy-core.git

# 7. 安装依赖
cd gamyy-core
npm install
cd frontend
npm install
cd ..

# 8. 直接运行（config.db 已在仓库中，无需手动配置）
# 启动 Web 管理端...
```

### 6.2 服务器上部署云端 Agent

```bash
# 部署脚本 deploy.sh 已经包含了从 git clone 到 PM2 启动的全部流程
# 参见 DEPLOY.md
```

### 6.3 从已有备份恢复

```bash
# 如果 GitHub 上拉不到了，从本地备份恢复
git clone --bare E:/gamyy_base_info/gamyy-core-20260420-1 E:/backup/gamyy-core.git
# 然后可以推送到新的远程仓库
```

---

## 七、commit message 规范

### 7.1 提交信息格式

```
<类型>: <简短描述>

<详细说明（可选）>
```

### 7.2 类型前缀

| 前缀 | 含义 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat: 支持按部门查号` |
| `fix` | 修复 bug | `fix: 修复代理池连接泄漏问题` |
| `config` | 配置/数据库变更 | `config: 更新 ops_proxy 配置` |
| `schema` | 数据库结构变更 | `schema: accounts 表新增 ops_proxy_id 字段` |
| `refactor` | 重构（不改功能） | `refactor: 提取 TaskRunner 公共方法` |
| `perf` | 性能优化 | `perf: 批量启动改为滚动窗口并发` |
| `docs` | 文档 | `docs: 更新部署说明` |
| `deploy` | 部署相关 | `deploy: 更新 deploy.sh 重试策略` |
| `maintenance` | 维护操作 | `maintenance: VACUUM config.db` |
| `init` | 初始化 | `init: gamyy-core v2 首次提交` |

### 7.3 好的 commit message 示例

```bash
# ✅ 好
git commit -m "feat: 批量启动任务支持熔断保护
>
> 启动前检查 agentUrl 熔断状态，跳过已熔断的 agent
> 避免浪费 60s 超时等待。3次连续失败触发熔断，60s冷却。"

# ✅ 好
git commit -m "config: 新增医科院肿瘤医院代理池 10台云服务器"

# ✅ 好
git commit -m "fix: 修复 channels 表建表SQL缺少 hospital_id 字段"

# ❌ 不好
git commit -m "修改"
git commit -m "update"
git commit -m "."
```

---

## 八、标签（Tag）管理

### 8.1 什么时候打标签

| 场景 | 标签格式 | 示例 |
|------|----------|------|
| 部署前快照 | `deploy-YYYYMMDD-HHMM` | `deploy-20260621-1400` |
| 发布版本 | `vX.Y.Z` | `v2.1.0` |
| 重大变更前 | `pre-<描述>` | `pre-proxy-refactor` |

### 8.2 标签操作

```bash
# 创建轻量标签
git tag deploy-20260621-1400

# 创建附注标签（推荐，带说明）
git tag -a v2.1.0 -m "v2.1.0: 调度器重构，支持熔断保护"

# 查看所有标签
git tag -l

# 查看标签详细信息
git show v2.1.0

# 推送标签到远程
git push origin v2.1.0
git push origin --tags       # 推送所有标签

# 删除标签
git tag -d v2.0.0                          # 删本地
git push origin --delete v2.0.0            # 删远程

# 基于标签创建分支（查看历史版本）
git checkout -b hotfix-from-v2.0 v2.0.0
```

---

## 九、回退与撤销

### 9.1 撤销未提交的修改

```bash
# 撤销某个文件的修改（恢复到最后一次 commit 的状态）
git checkout -- config/config.js

# 撤销所有修改
git checkout -- .

# 撤销 git add（从暂存区移出，但保留修改）
git reset HEAD config/config.js
git reset HEAD .                    # 全部移出
```

### 9.2 撤销已提交但未推送的 commit

```bash
# 撤销最后一次 commit，修改回到工作区
git reset --soft HEAD~1

# 撤销最后一次 commit，修改回到暂存区
git reset HEAD~1

# 撤销最后一次 commit，修改全部丢弃 ⚠️ 危险
git reset --hard HEAD~1

# 修改最后一次 commit 的 message
git commit --amend -m "新的提交信息"
```

### 9.3 撤销已推送的 commit（慎用）

```bash
# 方法1：revert — 创建新 commit 来反向操作（安全，推荐）
git revert HEAD
git push

# 方法2：reset + force push（会改写历史，单人项目可以用）
git reset --hard HEAD~1
git push --force
```

### 9.4 恢复到历史某个版本

```bash
# 临时查看历史版本（不影响当前分支）
git checkout v2.0.0

# 回到最新版本
git checkout master

# 从历史版本创建一个新分支
git checkout -b old-version v2.0.0
```

---

## 十、SSH 密钥管理

### 10.1 当前配置说明

```
~/.ssh/
├── config                  ← SSH 配置文件（定义 Host 别名和密钥对应关系）
├── id_ed25519_github       ← GitHub 专用私钥
├── id_ed25519_github.pub   ← GitHub 专用公钥（已添加到 GitHub）
├── gamyy_agent / .pub      ← 云端 Agent 部署用密钥
├── hk_vpn / .pub           ← VPN 连接用密钥
└── id_rsa_vpn / .pub       ← VPN 备用密钥
```

### 10.2 SSH config 说明

```ssh-config
# ~/.ssh/config

# GitHub — 使用专用密钥
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_github

# Termux 远程终端
Host OP9-Termux
    HostName 127.0.0.1
    User u0_a332
    Port 8022
```

这样当你执行 `git push` 时，git 会自动：
1. 匹配 `Host github.com` 配置
2. 使用 `~/.ssh/id_ed25519_github` 私钥认证
3. 无需每次输入密码

### 10.3 更换电脑时迁移 SSH 密钥

```bash
# 从旧电脑复制整个 .ssh 目录
# 复制以下内容到新电脑的 C:\Users\<用户名>\.ssh\
# - config
# - id_ed25519_github
# - id_ed25519_github.pub

# 在新电脑上设置私钥权限（重要！）
chmod 600 ~/.ssh/id_ed25519_github
chmod 600 ~/.ssh/config
```

### 10.4 测试 SSH 连接

```bash
# 测试 GitHub 连接
ssh -T git@github.com
# 成功：Hi lixintuo93-boop! You've successfully authenticated...

# 测试详细信息
ssh -vT git@github.com
```

---

## 十一、常见问题排查

### 11.1 `git push` 失败

```bash
# 问题：Permission denied (publickey)
# 原因：SSH 密钥未配置或过期
# 解决：
ssh -T git@github.com          # 测试连接
cat ~/.ssh/id_ed25519_github.pub  # 确认公钥内容
# 重新添加到 https://github.com/settings/ssh/new

# 问题：failed to push some refs
# 原因：远程有新提交，本地落后
# 解决：
git pull origin master         # 先拉取
# 如果有冲突，解决后：
git add .
git commit -m "merge: 合并远程更新"
git push

# 问题：Repository not found
# 原因：远程 URL 配置错误或仓库不存在
# 解决：
git remote -v                  # 查看当前 URL
git remote set-url origin git@github.com:lixintuo93-boop/gamyy-core.git
```

### 11.2 数据库冲突

```bash
# 问题：git merge 时报 config.db 冲突
# 原因：两台电脑都改了数据库

# 解决方案 A：明确选一个版本
git checkout --theirs data/config.db    # 用远程的
git checkout --ours data/config.db      # 用本地的
git add data/config.db
git commit -m "merge: 数据库冲突 - 选择xxx版本"

# 解决方案 B：手动处理
# 1. 备份两个版本
cp data/config.db data/config.db.ours
cp data/config.db data/config.db.theirs
# 2. 在 Web 管理界面手动合并配置
# 3. 提交合并后的版本
git add data/config.db
git commit -m "merge: 手动合并数据库配置"
```

### 11.3 `git status` 显示一堆修改但你没改过

```bash
# 问题：文件权限或换行符变化
# 可能原因：Windows CRLF vs Unix LF

# 临时忽略文件模式变化
git config core.filemode false

# 项目的换行符策略（已在仓库初始化时自动设置）
# Windows: core.autocrlf = true
```

### 11.4 想忽略已经 tracked 的文件

```bash
# 比如之前不小心提交了某个日志文件
git rm --cached pm2日志.txt      # 从 git 追踪中移除，但保留本地文件
echo "pm2日志.txt" >> .gitignore  # 加入忽略列表
git add .gitignore
git commit -m "chore: 忽略 pm2 日志文件"
git push
```

### 11.5 查看某个文件的某行是谁改的

```bash
# 逐行查看每个 commit 是谁改的
git blame config/config.js

# 只看某几行
git blame -L 10,30 config/config.js

# 忽略空格变化
git blame -w config/config.js
```

---

## 十二、Git 配置参考

### 12.1 当前本机配置

```bash
# 查看当前配置
git config --global --list
```

当前配置项：

| 配置 | 值 |
|------|-----|
| `user.name` | `lixintuo93-boop` |
| `user.email` | `lixintuo93@gmail.com` |
| `core.autocrlf` | `true`（自动处理 Windows 换行符） |

### 12.2 推荐额外配置

```bash
# 彩色输出
git config --global color.ui auto

# 默认分支名为 main（GitHub 新标准）
git config --global init.defaultBranch main

# 设置默认编辑器（用于写长 commit message）
git config --global core.editor "code --wait"

# 别名（快捷命令）
git config --global alias.st status
git config --global alias.co checkout
git config --global alias.br branch
git config --global alias.ci commit
git config --global alias.lg "log --oneline --graph --all -20"
git config --global alias.lga "log --oneline --graph --all"
```

### 12.3 配置后常用快捷命令

```bash
git st        # = git status
git co dev    # = git checkout dev
git br        # = git branch
git ci -m "xxx"  # = git commit -m "xxx"
git lg        # = 图形化 log 最近 20 条
```

---

## 附录：快速参考卡片

### 每天用的

```bash
git status                    # 看状态
git add .                     # 暂存全部
git commit -m "xxx"           # 提交
git push                      # 推送

git log --oneline -10         # 看最近 10 条提交
git pull                      # 拉取远程更新
```

### 偶尔用的

```bash
git diff                      # 看改了啥
git checkout -- xxx.js        # 撤销某个文件
git reset HEAD~1              # 撤销最近一次 commit
git stash                     # 暂存当前修改（切分支用）
git stash pop                 # 恢复暂存
git tag -a v1.0 -m "xxx"      # 打标签
git branch -b new-branch      # 创建并切换分支
```

### 危险操作（确认后再执行）

```bash
git reset --hard HEAD~1       # 彻底丢弃最近一次 commit
git push --force              # 强制推送（覆盖远程历史）
git branch -D xxx             # 强制删除分支
```

---

> 文档生成日期：2026-06-21
>
> 仓库：https://github.com/lixintuo93-boop/gamyy-core
