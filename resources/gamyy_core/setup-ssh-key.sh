#!/bin/bash
# setup-ssh-key.sh — 一次性建立 SSH 免密登录（只需运行一次）
# 运行后 deploy.sh 就不再需要密码
#
# 网络拓扑：
#   本机 → SOCKS5 localhost:5002 → 云服务器 101.200.241.73:22
#   （5002 是 cloud_proxy_pool 建立的 SSH 动态转发代理）

SOCKS_PORT="5002"
SERVER_HOST="101.200.241.73"
SERVER_SSH_PORT="22"
SSH_USER="root"
KEY_FILE="$HOME/.ssh/gamyy_agent"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/scripts/ssh-proxy-wrapper.sh"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() {
  echo -e "${RED}[ERR]${NC}   $*"
  echo ""
  read -rp "按 Enter 键关闭..." _
  exit 1
}

trap 'echo ""; read -rp "完成，按 Enter 键关闭..." _' EXIT

# ── 前置检查 ──────────────────────────────────────────────────────
[[ ! -f "$WRAPPER" ]] && error "找不到 $WRAPPER"
chmod +x "$WRAPPER"

# ── 生成临时 SSH 配置（避免 ProxyCommand 引号展开问题）────────────
# SSH 配置文件中 ProxyCommand 整行作为命令，无需额外引号
TMPCONFIG=$(mktemp /tmp/gamyy-ssh-XXXXXX.conf)
trap 'rm -f "$TMPCONFIG"; echo ""; read -rp "完成，按 Enter 键关闭..." _' EXIT

export SOCKS_PORT
cat > "$TMPCONFIG" << EOF
Host $SERVER_HOST
  StrictHostKeyChecking no
  ProxyCommand $WRAPPER %h %p
EOF

info "SOCKS5 代理: localhost:${SOCKS_PORT}"
info "目标服务器: ${SSH_USER}@${SERVER_HOST}:${SERVER_SSH_PORT}"
info "ProxyCommand: $WRAPPER %h %p"

# ── 1. 生成密钥对（如果已存在则跳过）────────────────────────────
if [[ ! -f "$KEY_FILE" ]]; then
  info "生成 SSH 密钥对: $KEY_FILE"
  ssh-keygen -t ed25519 -f "$KEY_FILE" -N "" -C "gamyy-agent-deploy"
else
  info "密钥已存在，跳过生成: $KEY_FILE"
fi

# ── 2. 上传公钥（此步需要输入一次密码）──────────────────────────
info "正在上传公钥，请在下方提示中输入密码: 938241li."
echo ""

cat "$KEY_FILE.pub" | ssh -F "$TMPCONFIG" \
  -p "$SERVER_SSH_PORT" \
  "${SSH_USER}@${SERVER_HOST}" \
  "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh" \
  || error "公钥上传失败，请检查 SOCKS5 代理是否正常运行（localhost:${SOCKS_PORT}）"

echo ""

# ── 3. 测试免密登录 ───────────────────────────────────────────────
info "测试免密登录..."
RESULT=$(ssh -F "$TMPCONFIG" \
  -i "$KEY_FILE" \
  -o BatchMode=yes \
  -o PasswordAuthentication=no \
  -p "$SERVER_SSH_PORT" \
  "${SSH_USER}@${SERVER_HOST}" \
  "echo OK" 2>&1)

if [[ "$RESULT" == "OK" ]]; then
  echo ""
  echo -e "${GREEN}════════════════════════════════════${NC}"
  echo -e "${GREEN}  SSH 免密登录配置成功！${NC}"
  echo -e "${GREEN}════════════════════════════════════${NC}"
  echo ""
  info "现在可以直接运行部署脚本："
  echo "    bash deploy.sh"
else
  echo ""
  warn "免密登录测试失败，输出: $RESULT"
  warn "常见原因："
  warn "  1. cloud_proxy_pool 项目未运行或 SOCKS5 代理不通"
  warn "  2. 服务器 SSH 端口不是 22"
  warn "  3. 密码错误"
fi
