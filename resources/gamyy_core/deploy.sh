#!/bin/bash
# deploy.sh — 部署 gamyy-agent 到云端服务器
# 网络拓扑：本机 → SOCKS5 localhost:5002 → 云服务器 101.200.241.73:22
# 首次使用前请先运行：bash setup-ssh-key.sh
# 使用方式：bash deploy.sh [--restart-only]

set -e

# ═══════════════════════════════════════════════════════════════════
#  连接配置（来自 cloud_proxy_pool/proxy_manager_5001.db）
#  ssh_servers id=2: Server-1 → 101.200.241.73:22  root/938241li.
#  proxies id=2: SOCKS5 localhost:5002 → ssh_server_id=2
# ═══════════════════════════════════════════════════════════════════
SOCKS_PORT="5002"
SERVER_HOST="101.200.241.73"
SERVER_SSH_PORT="22"
SSH_USER="root"
KEY_FILE="$HOME/.ssh/gamyy_agent"
REMOTE_DIR="/opt/gamyy-agent"
AGENT_PORT="7070"
PM2_APP_NAME="gamyy-agent"

# ── 颜色输出 ────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() {
  echo -e "${RED}[ERR]${NC}   $*"
  echo ""
  read -rp "按 Enter 键关闭..." _
  exit 1
}
step()  { echo -e "\n${GREEN}══ $* ${NC}"; }

# 脚本结束时暂停（双击运行时窗口不会立刻关闭）
trap 'echo ""; read -rp "完成，按 Enter 键关闭..." _' EXIT

# ── 脚本所在目录（项目根目录）───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/scripts/ssh-proxy-wrapper.sh"
info "项目目录: $SCRIPT_DIR"

# ── 参数解析 ────────────────────────────────────────────────────────
RESTART_ONLY=false
for arg in "$@"; do
  [[ "$arg" == "--restart-only" ]] && RESTART_ONLY=true
done

# ── 前置检查 ──────────────────────────────────────────────────────
[[ ! -f "$KEY_FILE" ]]  && error "SSH 密钥不存在: $KEY_FILE\n  请先运行: bash setup-ssh-key.sh"
[[ ! -f "$WRAPPER" ]]   && error "找不到 $WRAPPER"
chmod +x "$WRAPPER"
info "SSH 密钥: $KEY_FILE"

# ── 生成临时 SSH 配置（避免 ProxyCommand 引号展开问题）────────────
export SOCKS_PORT
TMPCONFIG=$(mktemp /tmp/gamyy-deploy-XXXXXX.conf)
trap 'rm -f "$TMPCONFIG"; echo ""; read -rp "完成，按 Enter 键关闭..." _' EXIT

cat > "$TMPCONFIG" << EOF
Host $SERVER_HOST
  StrictHostKeyChecking no
  IdentityFile $KEY_FILE
  BatchMode yes
  ConnectTimeout 15
  ProxyCommand $WRAPPER %h %p
EOF

# SSH / SCP 命令封装
SSH="ssh -F $TMPCONFIG -p ${SERVER_SSH_PORT}"
SCP="scp -F $TMPCONFIG -P ${SERVER_SSH_PORT}"
SSH_TARGET="${SSH_USER}@${SERVER_HOST}"

# ═══════════════════════════════════════════════════════════════════
#  第一步：验证 SSH 连通性
# ═══════════════════════════════════════════════════════════════════
step "第一步：验证 SSH 连通性"
REMOTE_INFO=$($SSH $SSH_TARGET "uname -s && uname -m && cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | head -1" 2>&1) \
  || error "SSH 连接失败，请确认 cloud_proxy_pool 项目正在运行且端口 5002 已转发。\n  错误详情: $REMOTE_INFO"
info "连接成功: $REMOTE_INFO"

# ── 跳过上传，只重启 ────────────────────────────────────────────────
if $RESTART_ONLY; then
  step "--restart-only：仅重启 PM2 进程"
  $SSH $SSH_TARGET "pm2 restart ${PM2_APP_NAME} 2>/dev/null || pm2 start ${REMOTE_DIR}/agent/server.js --name ${PM2_APP_NAME}"
  info "重启完成"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  第二步：检查/安装 Node.js
# ═══════════════════════════════════════════════════════════════════
step "第二步：检查 Node.js 环境"
NODE_VER=$($SSH $SSH_TARGET "node -v 2>/dev/null || echo 'NOT_FOUND'")
if [[ "$NODE_VER" == "NOT_FOUND" ]] || [[ -z "$NODE_VER" ]]; then
  warn "Node.js 未安装，正在自动安装 Node.js 20 LTS..."
  $SSH $SSH_TARGET "
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
    elif command -v yum &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs
    else
      echo 'ERROR: 无法识别包管理器，请手动安装 Node.js 20' && exit 1
    fi
  " || error "Node.js 安装失败，请手动安装"
  NODE_VER=$($SSH $SSH_TARGET "node -v")
fi

NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  error "Node.js 版本 $NODE_VER 过低，需要 >= 18"
fi
info "Node.js: $NODE_VER ✓"

# ── 检查/安装 PM2 ──────────────────────────────────────────────────
PM2_VER=$($SSH $SSH_TARGET "pm2 -v 2>/dev/null || echo 'NOT_FOUND'")
if [[ "$PM2_VER" == "NOT_FOUND" ]] || [[ -z "$PM2_VER" ]]; then
  info "安装 PM2..."
  $SSH $SSH_TARGET "npm install -g pm2" || error "PM2 安装失败"
  PM2_VER=$($SSH $SSH_TARGET "pm2 -v")
fi
info "PM2: v$PM2_VER ✓"

# ═══════════════════════════════════════════════════════════════════
#  第三步：创建远端目录
# ═══════════════════════════════════════════════════════════════════
step "第三步：准备远端目录 ${REMOTE_DIR}"
$SSH $SSH_TARGET "mkdir -p ${REMOTE_DIR}/agent ${REMOTE_DIR}/services ${REMOTE_DIR}/database ${REMOTE_DIR}/utils ${REMOTE_DIR}/models ${REMOTE_DIR}/crypto ${REMOTE_DIR}/data"
info "目录已就绪"

# ═══════════════════════════════════════════════════════════════════
#  第四步：上传文件
# ═══════════════════════════════════════════════════════════════════
step "第四步：上传文件"

upload_dir() {
  local dir=$1
  info "上传 ${dir}/ ..."
  $SCP -r "${SCRIPT_DIR}/${dir}" "${SSH_USER}@${SERVER_HOST}:${REMOTE_DIR}/"
}

upload_file() {
  local file=$1
  info "上传 ${file} ..."
  $SCP "${SCRIPT_DIR}/${file}" "${SSH_USER}@${SERVER_HOST}:${REMOTE_DIR}/${file}"
}

upload_dir  "agent"
upload_dir  "services"
upload_dir  "database"
upload_dir  "utils"
upload_dir  "models"
upload_dir  "crypto"
# 使用精简版 package.json（不含 Web 层专用的 better-sqlite3/express 等）
$SCP "${SCRIPT_DIR}/package-agent.json" "${SSH_USER}@${SERVER_HOST}:${REMOTE_DIR}/package.json"
info "文件上传完成"

# ═══════════════════════════════════════════════════════════════════
#  第五步：安装 npm 依赖
# ═══════════════════════════════════════════════════════════════════
step "第五步：安装编译工具 + npm 依赖"
info "安装编译工具链（sqlite3 原生模块需要，约 30 秒）..."
$SSH $SSH_TARGET "
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && \
    apt-get install -y -qq build-essential python3 python3-dev make gcc g++ libsqlite3-dev
  elif command -v yum &>/dev/null; then
    yum groupinstall -y 'Development Tools' && yum install -y python3 sqlite-devel
  else
    echo 'WARNING: 未识别包管理器，跳过编译工具安装' >&2
  fi
  ln -sf /usr/bin/python3 /usr/bin/python 2>/dev/null || true
  npm install -g node-gyp 2>/dev/null || true
" || warn "编译工具安装出现警告，继续尝试 npm install..."

info "正在安装 npm 依赖（sqlite3 含原生编译，约 1~2 分钟）..."
$SSH $SSH_TARGET "
  cd ${REMOTE_DIR}
  rm -rf node_modules package-lock.json
  npm cache clean --force 2>/dev/null || true
  NODE_OPTIONS='--max-old-space-size=512' npm install --omit=dev --legacy-peer-deps 2>&1
" || error "npm install 失败，请检查服务器编译环境或网络"
info "依赖安装完成"

# ═══════════════════════════════════════════════════════════════════
#  第六步：启动 / 重启 PM2
# ═══════════════════════════════════════════════════════════════════
step "第六步：启动 PM2 进程"
$SSH $SSH_TARGET "
  cd ${REMOTE_DIR}

  # 如果已有同名进程则重启，否则新启动
  if pm2 show ${PM2_APP_NAME} &>/dev/null; then
    echo 'Agent 已存在，重启...'
    pm2 restart ${PM2_APP_NAME}
  else
    echo 'Agent 首次启动...'
    pm2 start agent/server.js --name ${PM2_APP_NAME}
  fi

  # 保存 PM2 进程列表（用于开机自启）
  pm2 save
"

# ═══════════════════════════════════════════════════════════════════
#  第七步：验证健康检查
# ═══════════════════════════════════════════════════════════════════
step "第七步：验证 Agent 运行状态"
sleep 2   # 等待进程完全启动

HEALTH=$($SSH $SSH_TARGET "curl -sf http://localhost:${AGENT_PORT}/health 2>/dev/null || echo 'FAIL'")
if [[ "$HEALTH" == *'"status":"ok"'* ]]; then
  info "健康检查通过: $HEALTH"
else
  warn "健康检查未通过: $HEALTH"
  warn "正在抓取 PM2 启动日志..."
  echo ""
  $SSH $SSH_TARGET "pm2 logs ${PM2_APP_NAME} --lines 40 --nostream 2>&1 || true"
  echo ""
  warn "如需继续排查，在服务器上执行: pm2 logs ${PM2_APP_NAME} --lines 100"
fi

# ═══════════════════════════════════════════════════════════════════
#  完成
# ═══════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
echo "  Agent 在服务器本地监听: http://localhost:${AGENT_PORT}"
echo ""
echo "  下一步 —— 在 Web 管理界面的代理池中，"
echo "  将对应 SSH 代理的「云端 Agent URL」设置为："
echo ""
echo "    方案A（直连公网）: http://$(
  $SSH $SSH_TARGET "curl -s --max-time 3 ifconfig.me 2>/dev/null || echo '<服务器公网IP>'"
):${AGENT_PORT}"
echo "    方案B（SSH隧道）:  先在本地执行："
echo "      ssh -N -L ${AGENT_PORT}:localhost:${AGENT_PORT} -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST}"
echo "      然后填写: http://localhost:${AGENT_PORT}"
echo ""
echo "  常用命令（在服务器上）："
echo "    pm2 logs ${PM2_APP_NAME}           # 实时日志"
echo "    pm2 restart ${PM2_APP_NAME}        # 重启"
echo "    curl localhost:${AGENT_PORT}/health  # 健康检查"
echo ""
