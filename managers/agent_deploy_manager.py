# managers/agent_deploy_manager.py
"""
Gamyy Agent 部署管理器
- 并发部署/启动/停止/重启 gamyy-agent 到 ssh_servers 中的云服务器
- 智能跳过已安装的 Node.js / PM2 / 编译工具链（避免重复耗时操作）
- 支持下载云端 SQLite 日志数据库到本地
"""
import os
import io
import random
import sqlite3
import threading
import time
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# SSH 握手阶段（DH密钥交换 + 密码认证）是 CPU 密集操作。
# 该信号量限制同时进行握手的并发数，防止 1000 个 worker 瞬时全发导致本地 CPU 打满。
# 握手完成后信号量立即释放，后续 npm install 等 I/O 等待不受影响。
_SSH_CONNECT_CONCURRENCY = 50

# 镜像表（暂保留结构，所有云厂商都退回官方源——cloud_provider 字段仅用于显示标签）
# 历史上这里有阿里云/腾讯云镜像，因兼容性问题（路径差异、GPG key 不同步、codename 异常）已下线。
# 如果将来再要启用，给对应键填 URL 即可，下方 _ensure_nodejs/_ensure_pm2/_npm_install_project 会自动用上。
_MIRRORS = {
    'aliyun':  {'npm': None, 'nodesource_apt': None, 'nodesource_rpm': None, 'gpg_key': None},
    'tencent': {'npm': None, 'nodesource_apt': None, 'nodesource_rpm': None, 'gpg_key': None},
    'default': {'npm': None, 'nodesource_apt': None, 'nodesource_rpm': None, 'gpg_key': None},
}

import sys
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fnmatch
import paramiko
from config import (
    DATABASE_FILE, AGENT_SOURCE_DIR, AGENT_REMOTE_DIR, AGENT_PORT,
    AGENT_PM2_NAME, AGENT_UPLOAD_DIRS, AGENT_PACKAGE_FILE,
    AGENT_DEPLOY_WORKERS, AGENT_OP_WORKERS,
    AGENT_REMOTE_DB, AGENT_LOG_SAVE_DIR,
    AGENT_FULL_REMOTE_DIR, AGENT_FULL_PM2_NAME, AGENT_FULL_PORT,
    RESOURCE_DIR_NAME, LOCAL_DEPLOY_DIR,
    _app_root, _resource_root,
    get_beijing_time_str,
)
from managers.executors import (
    SSHExecutor, LocalExecutor,
    AGENT_WINDOWS_REMOTE_DIR, AGENT_WINDOWS_FULL_REMOTE_DIR,
)


# ──────────────────────────────────────────────────────────────────────
# 部署源解析（统一目标：resources/gamyy_core/ → 内置版回退）
# ──────────────────────────────────────────────────────────────────────
def _is_valid_source(path):
    """判断目录里是否有 agent/server.js，作为"合法 gamyy-core 源"的最简指标。"""
    if not path or not os.path.isdir(path):
        return False
    return os.path.isfile(os.path.join(path, 'agent', 'server.js'))


def get_deploy_source():
    """
    解析部署源目录，返回 (path, kind)。
    kind in: 'synced' / 'bundled' / 'missing'

    1. _app_root()/resources/<RESOURCE_DIR_NAME>/     ← 所有导入方式统一写入这里
    2. _resource_root()/resources/<RESOURCE_DIR_NAME>/ ← PyInstaller --add-data 内置版（仅 EXE 模式有意义）
    """
    synced = os.path.join(_app_root(), 'resources', RESOURCE_DIR_NAME)
    if _is_valid_source(synced):
        return synced, 'synced'
    bundled = os.path.join(_resource_root(), 'resources', RESOURCE_DIR_NAME)
    if bundled != synced and _is_valid_source(bundled):
        return bundled, 'bundled'
    return None, 'missing'


# ──────────────────────────────────────────────────────────────────────
# 完整模式上传排除规则
# ──────────────────────────────────────────────────────────────────────
# 子目录名（在任意层级出现则跳过整棵子树）
_FULL_EXCLUDE_DIRS = {
    'node_modules', '.git', '.idea', '.vscode', '__pycache__',
   
}
# 文件名 fnmatch 模式
_FULL_EXCLUDE_PATTERNS = [
    '*.pcapng', '*.7z', '*.zip', '*.pyc', '*.exe',
    'pm2日志.txt', '微信端登录返回结果.txt',
    'config.db-wal', 'config.db-shm',
]
# 相对源根的特定路径（精确匹配）
_FULL_EXCLUDE_SPECIFIC = {
    os.path.join('data', 'ticket_checker.db'),     # 远端运行时生成
}

# Windows 远程/本地部署路径常量已移到 managers/executors.py（AGENT_WINDOWS_REMOTE_DIR /
# AGENT_WINDOWS_FULL_REMOTE_DIR），此处通过 import 引入，避免重复定义。


def _should_skip_full(rel_path, is_dir):
    """完整模式 sftp 上传/sync 时的过滤器。
    rel_path: 相对源根的相对路径
    is_dir: 是否为目录
    """
    rel_path = os.path.normpath(rel_path)
    name = os.path.basename(rel_path) or rel_path
    if is_dir and name in _FULL_EXCLUDE_DIRS:
        return True
    if name.startswith('.'):
        return True  # 任何点开头隐藏项
    if not is_dir:
        for pat in _FULL_EXCLUDE_PATTERNS:
            if fnmatch.fnmatch(name, pat):
                return True
    if rel_path in _FULL_EXCLUDE_SPECIFIC:
        return True
    return False


class AgentDeployManager:
    def __init__(self, db_file=None, log_callback=None):
        self.db_file = db_file or DATABASE_FILE
        self.log_cb = log_callback  # callback(msg, level='INFO'|'SUCCESS'|'ERROR'|'WARNING')
        self._lock = threading.Lock()
        self._connect_sem = threading.Semaphore(_SSH_CONNECT_CONCURRENCY)
        # 正在部署中的 server_id 集合（per-server 锁）
        # 进入 deploy_server 时 add；finally remove。同台再被发起部署直接返回"已在部署中"
        # 防止同一台服务器被两批部署任务并发撞 SSH/SFTP/npm 导致状态损坏
        self._deploying_ids = set()
        self._deploying_lock = threading.Lock()
        # OS 检测缓存已下放到各 Executor 实例（替代原 id(client) 字典）

    def _make_executor(self, server):
        """根据 server['is_local'] 选执行器：本机用 LocalExecutor，否则 SSH 连接后包装。"""
        if server.get('is_local'):
            return LocalExecutor()
        return SSHExecutor(self._connect(server))

    # ──────────────────────────────────────────────────────────
    # 日志
    # ──────────────────────────────────────────────────────────
    def _log(self, msg, level='INFO'):
        ts = get_beijing_time_str('%H:%M:%S')
        line = f"[{ts}] {msg}"
        if self.log_cb:
            try:
                self.log_cb(line, level)
            except Exception:
                pass

    # ──────────────────────────────────────────────────────────
    # 数据库访问
    # ──────────────────────────────────────────────────────────
    def get_all_servers(self):
        """返回 ssh_servers 所有记录 list[dict]"""
        conn = sqlite3.connect(self.db_file)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute('SELECT id, name, server_host, server_port, username, password, cloud_provider, last_deploy_status, deploy_mode, is_local FROM ssh_servers ORDER BY id')
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

    def get_server(self, server_id):
        conn = sqlite3.connect(self.db_file)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute('SELECT id, name, server_host, server_port, username, password, cloud_provider, last_deploy_status, deploy_mode, is_local FROM ssh_servers WHERE id=?', (server_id,))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None

    def get_servers_by_ids(self, server_ids):
        """批量获取服务器信息，一次 SQL 替代 N 次单查，保持传入顺序。
        SELECT 字段与 get_all_servers / get_server 对齐，含 last_deploy_status，
        否则 _classify_for_deploy 会把所有服务器都当成 'never'。
        """
        if not server_ids:
            return []
        conn = sqlite3.connect(self.db_file)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        placeholders = ','.join('?' * len(server_ids))
        cur.execute(
            f'SELECT id, name, server_host, server_port, username, password, '
            f'cloud_provider, last_deploy_status, deploy_mode, is_local '
            f'FROM ssh_servers WHERE id IN ({placeholders})',
            list(server_ids)
        )
        rows = {r['id']: dict(r) for r in cur.fetchall()}
        conn.close()
        return [rows[sid] for sid in server_ids if sid in rows]

    # ──────────────────────────────────────────────────────────
    # SSH 工具
    # ──────────────────────────────────────────────────────────
    # SSH 建连重试参数（针对云厂商 SYN 限流 / 临时网络抖动 / 服务端 sshd 慢响应）
    # AuthenticationException 不重试（密码就是错的，重试无意义）
    _SSH_CONNECT_MAX_ATTEMPTS = 4              # 总尝试次数（含首次）
    _SSH_CONNECT_BACKOFFS = [3, 8, 15]         # 第 1..3 次重试前等待基数（秒）+ 0~50% 抖动

    def _connect(self, server, timeout=15):
        """
        建立 paramiko SSH 连接。
        握手阶段（DH密钥交换 + 认证）用 _connect_sem 限速，
        防止 1000 个 worker 同时握手把本地 CPU 打满。
        握手完成后信号量立即释放，不影响后续命令执行。

        失败重试策略：最多 4 次尝试，间隔 3/8/15s + 0~50% 抖动。
        - 认证失败（AuthenticationException）直接抛，不重试
        - 其他（socket.timeout / paramiko.SSHException / 各种网络异常）计入重试
        - 每次尝试都重新进 semaphore，让出名额给其他 worker，不会卡占名额
        """
        host = server['server_host']
        max_attempts = self._SSH_CONNECT_MAX_ATTEMPTS
        last_exc = None

        for attempt in range(1, max_attempts + 1):
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                with self._connect_sem:
                    client.connect(
                        hostname=host,
                        port=server['server_port'],
                        username=server['username'],
                        password=server['password'],
                        timeout=timeout,
                        allow_agent=False,
                        look_for_keys=False,
                        banner_timeout=20,
                        auth_timeout=20,
                    )
                return client
            except paramiko.AuthenticationException:
                # 密码错就是错，重试没用
                try:
                    client.close()
                except Exception:
                    pass
                raise
            except Exception as e:
                last_exc = e
                try:
                    client.close()
                except Exception:
                    pass
                if attempt < max_attempts:
                    base = self._SSH_CONNECT_BACKOFFS[attempt - 1]
                    wait = base + random.uniform(0, base * 0.5)
                    self._log(
                        f"[{host}] SSH 建连失败 ({type(e).__name__}: {str(e)[:80]})，"
                        f"{wait:.1f}s 后重试 ({attempt+1}/{max_attempts})...",
                        'WARNING',
                    )
                    time.sleep(wait)

        # 所有尝试用完，抛最后一次的异常
        if last_exc is not None:
            raise last_exc
        raise RuntimeError(f"[{host}] SSH 建连失败：未知原因")

    def _exec(self, ex, cmd, timeout=120):
        """委托给 Executor 执行命令，返回 (stdout, stderr, exit_code)。
        ex 可为 SSHExecutor 或 LocalExecutor —— 上层方法体保持不变。"""
        return ex.exec(cmd, timeout=timeout)

    def _detect_os(self, ex):
        """委托给 Executor 检测 OS，返回 'windows' 或 'linux'（按 executor 实例缓存）。"""
        return ex.detect_os()

    def _is_cmd_available(self, ex, cmd):
        """检查命令是否可用（exit 0）；兼容 Linux 与 Windows。"""
        if self._detect_os(ex) == 'windows':
            _, _, code = self._exec(ex, f"where {cmd} >nul 2>&1", timeout=10)
        else:
            _, _, code = self._exec(ex, f"command -v {cmd} >/dev/null 2>&1", timeout=10)
        return code == 0

    def _get_cmd_version(self, ex, cmd):
        """获取命令版本号字符串，不可用返回 None"""
        out, _, code = self._exec(ex, f"{cmd} --version 2>/dev/null || {cmd} -v 2>/dev/null", timeout=10)
        return out.strip() if code == 0 and out.strip() else None

    # ──────────────────────────────────────────────────────────
    # 文件上传（远端走 SFTP，本地走 shutil；统一经 Executor 原语）
    # ──────────────────────────────────────────────────────────
    def _upload_dir(self, ex, local_dir, remote_dir):
        """精简 Agent 模式：递归上传/拷贝目录（跳过 node_modules 与点开头项）。"""
        ex.mkdirs(remote_dir)
        for item in os.listdir(local_dir):
            if item == 'node_modules' or item.startswith('.'):
                continue
            local_path = os.path.join(local_dir, item)
            remote_path = remote_dir.rstrip('/') + '/' + item
            if os.path.isdir(local_path):
                self._upload_dir(ex, local_path, remote_path)
            else:
                ex.put_file(local_path, remote_path)

    def _upload_full_dir(self, ex, local_dir, remote_dir, source_root):
        """完整模式：按 _should_skip_full 过滤递归上传/拷贝。
        source_root 用于算 rel_path（fnmatch 用），同时供 specific 路径精确匹配。
        """
        ex.mkdirs(remote_dir)
        for item in os.listdir(local_dir):
            local_path = os.path.join(local_dir, item)
            rel = os.path.relpath(local_path, source_root)
            is_dir = os.path.isdir(local_path)
            if _should_skip_full(rel, is_dir):
                continue
            remote_path = remote_dir.rstrip('/') + '/' + item
            if is_dir:
                self._upload_full_dir(ex, local_path, remote_path, source_root)
            else:
                ex.put_file(local_path, remote_path)

    def _upload_agent_files(self, ex, server_host, source_root=None, mode='agent'):
        """上传/部署文件。
        source_root: 部署源根目录（由 get_deploy_source 解析）；None 时回退到 AGENT_SOURCE_DIR
        mode='agent': 精简模式，仅上传 AGENT_UPLOAD_DIRS + package-agent.json→package.json
        mode='full' : 完整模式，递归整个 source_root（按 _should_skip_full 排除）+ 完整 package.json
        本地（ex.is_local）只支持 full，走 deploy_local_full（安全清理 + 备份 + copytree）。
        """
        src = source_root or AGENT_SOURCE_DIR
        remote_dir = self._resolve_remote_dir(ex, mode)

        # —— 本地部署：整树拷贝（含安全删除 + DB 备份）——
        if ex.is_local:
            if not os.path.isfile(os.path.join(src, 'package.json')):
                self._log(f"[{server_host}] 警告：source 根缺 package.json", 'WARNING')
            ex.deploy_local_full(src, remote_dir, _should_skip_full, log=self._log)
            return

        # —— 远端 SFTP 上传 ——
        is_windows = self._detect_os(ex) == 'windows'
        # 建目录并授权（Linux 需要 sudo；Windows 不需要）
        if is_windows:
            self._exec(
                ex,
                f"mkdir {remote_dir}\\data 2>nul & mkdir {remote_dir} 2>nul",
                timeout=15
            )
        else:
            self._exec(
                ex,
                f"sudo mkdir -p {remote_dir}/data && "
                f"sudo chown -R $(whoami):$(whoami) {remote_dir}",
                timeout=30
            )
        ex.mkdirs(remote_dir)

        if mode == 'full':
            # 完整模式：递归整个源根
            self._upload_full_dir(ex, src, remote_dir, src)
            if not os.path.isfile(os.path.join(src, 'package.json')):
                self._log(f"[{server_host}] 警告：source 根缺 package.json", 'WARNING')
        else:
            # 精简 Agent 模式：保持原逻辑
            ex.mkdirs(remote_dir + '/data')
            for d in AGENT_UPLOAD_DIRS:
                local_d = os.path.join(src, d)
                if not os.path.isdir(local_d):
                    self._log(f"[{server_host}] 警告：本地目录不存在 {local_d}", 'WARNING')
                    continue
                remote_d = remote_dir + '/' + d
                self._upload_dir(ex, local_d, remote_d)

            # 上传 package-agent.json → package.json
            pkg_local = os.path.join(src, AGENT_PACKAGE_FILE)
            if os.path.isfile(pkg_local):
                ex.put_file(pkg_local, remote_dir + '/package.json')
            else:
                self._log(f"[{server_host}] 警告：找不到 {pkg_local}", 'WARNING')

    # ──────────────────────────────────────────────────────────
    # 环境检测与安装（跳过已安装）
    # ──────────────────────────────────────────────────────────
    # Node.js 安装重试参数
    _NODEJS_MAX_ATTEMPTS = 8              # 总尝试次数（含首次）
    _NODEJS_SINGLE_TIMEOUT = 90           # 单次超时（秒）—— 短超时早放弃换轮次
    _NODEJS_BACKOFFS = [3, 8, 15, 25, 40, 60, 90]  # 第 1..7 次重试前的等待基数（秒）

    # PM2 全局安装重试参数
    _PM2_MAX_ATTEMPTS = 7
    _PM2_SINGLE_TIMEOUT = 60
    _PM2_BACKOFFS = [3, 8, 15, 25, 40, 60]

    # 项目 npm install 重试参数（含原生模块编译）
    _NPM_MAX_ATTEMPTS = 7
    _NPM_SINGLE_TIMEOUT = 240
    _NPM_BACKOFFS = [5, 15, 30, 60, 90, 120]

    def _npm_registry_arg(self, cloud):
        """返回 npm 命令的 --registry= 参数（含等号），无镜像时返回空串"""
        url = _MIRRORS.get(cloud, _MIRRORS['default'])['npm']
        return f"--registry={url} " if url else ""

    def _resolve_remote_dir(self, ex, mode='agent'):
        """委托给 Executor：远端 Linux /opt/... 或 Windows C:/opt/...；本地 LOCAL_DEPLOY_DIR。"""
        return ex.resolve_dir(mode)

    def _ensure_nodejs(self, client, server_host, cloud='default'):
        """确保 Node.js >= 18，不满足则安装 Node.js 22。

        Linux: apt-get / yum + nodesource setup_20.x
        Windows: PowerShell 下载 MSI → msiexec 静默安装

        失败重试策略：单次 90s，最多 8 次尝试，间隔 3/8/15/25/40/60/90s + 0~50% 抖动。
        """
        is_windows = self._detect_os(client) == 'windows'

        # --- 版本检测（兼容 Windows cmd.exe 和 Linux bash）---
        # Windows: 同名会话 PATH 可能未刷新（刚装完 MSI），显式检查默认安装路径
        detect_cmd = (r'(node -v 2>nul) || ("%ProgramFiles%\nodejs\node" -v 2>nul) || echo NOT_FOUND') if is_windows else "node -v 2>/dev/null || echo NOT_FOUND"
        out, _, code = self._exec(client, detect_cmd, timeout=10)
        if code == 0 and out.startswith('v'):
            major = int(out.lstrip('v').split('.')[0])
            if major >= 18:
                self._log(f"[{server_host}] Node.js {out} 已安装，跳过", 'INFO')
                return True

        # --- 安装命令（Windows vs Linux）---
        if is_windows:
            msi_url = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
            install_cmd = (
                f"powershell -Command \""
                f"$msi=join-path $env:TEMP 'node-v22.14.0-x64.msi'; "
                f"Write-Host 'Downloading Node.js 22 LTS...'; "
                f"Invoke-WebRequest -Uri '{msi_url}' -OutFile $msi -UseBasicParsing; "
                f"Write-Host 'Installing...'; "
                f"Start-Process msiexec.exe -ArgumentList '/i',$msi,'/qn','/norestart' -Wait; "
                f"Remove-Item $msi -Force; "
                f"Write-Host 'Done'"
                f"\""
            )
            cleanup_cmd = None  # Windows 不需要 Linux 式清理
        else:
            install_cmd = (
                "if command -v apt-get &>/dev/null; then "
                "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs; "
                "elif command -v yum &>/dev/null; then "
                "  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs; "
                "fi"
            )
            cleanup_cmd = (
                "if command -v apt-get &>/dev/null; then "
                "  sudo pkill -9 apt-get apt dpkg 2>/dev/null || true; "
                "  sudo rm -f /var/lib/apt/lists/lock /var/lib/apt/lists/lock-frontend "
                "    /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/cache/apt/archives/lock 2>/dev/null || true; "
                "  sudo rm -f /etc/apt/sources.list.d/nodesource.list /usr/share/keyrings/nodesource.gpg 2>/dev/null || true; "
                "  sudo dpkg --configure -a 2>/dev/null || true; "
                "elif command -v yum &>/dev/null; then "
                "  sudo pkill -9 yum dnf 2>/dev/null || true; "
                "  sudo rm -f /var/run/yum.pid /etc/yum.repos.d/nodesource.repo 2>/dev/null || true; "
                "fi"
            )

        max_attempts = self._NODEJS_MAX_ATTEMPTS
        last_reason = ''
        for attempt in range(1, max_attempts + 1):
            self._log(f"[{server_host}] 安装 Node.js 22 LTS（尝试 {attempt}/{max_attempts}）...", 'INFO')
            try:
                _, err, code = self._exec(client, install_cmd, timeout=self._NODEJS_SINGLE_TIMEOUT)
                if code == 0:
                    self._log(f"[{server_host}] Node.js 安装完成（尝试 {attempt}/{max_attempts}）", 'SUCCESS')
                    return True
                last_reason = f"非零退出码({code}): {(err or '')[:160]}"
            except TimeoutError as e:
                last_reason = f"超时({self._NODEJS_SINGLE_TIMEOUT}s)"

            if attempt < max_attempts:
                if cleanup_cmd and not is_windows:
                    try:
                        self._exec(client, cleanup_cmd, timeout=15)
                    except Exception:
                        pass
                base = self._NODEJS_BACKOFFS[attempt - 1]
                wait = base + random.uniform(0, base * 0.5)
                self._log(
                    f"[{server_host}] Node.js 安装失败（{last_reason}），{wait:.1f}s 后重试 ({attempt+1}/{max_attempts})...",
                    'WARNING',
                )
                time.sleep(wait)

        raise RuntimeError(f"Node.js 安装失败（已尝试 {max_attempts} 次）：{last_reason}")

    def _ensure_pm2(self, client, server_host, cloud='default'):
        """确保 PM2 已安装（Windows 上 / 本地部署不使用 PM2，直接跳过）。"""
        if getattr(client, 'is_local', False):
            self._log(f"[{server_host}] 本地部署，跳过 PM2（用 node 直接后台启动）", 'INFO')
            return True
        if self._detect_os(client) == 'windows':
            self._log(f"[{server_host}] Windows 环境，跳过 PM2（使用 node 直接启动）", 'INFO')
            return True

        detect_cmd = "pm2 -v 2>/dev/null || echo NOT_FOUND"
        out, _, code = self._exec(client, detect_cmd, timeout=10)
        if code == 0 and out != 'NOT_FOUND' and out.strip():
            self._log(f"[{server_host}] PM2 {out} 已安装，跳过", 'INFO')
            return True

        registry = self._npm_registry_arg(cloud)
        install_cmd = f"sudo npm install -g {registry}pm2"

        max_attempts = self._PM2_MAX_ATTEMPTS
        last_reason = ''
        for attempt in range(1, max_attempts + 1):
            self._log(f"[{server_host}] 安装 PM2（尝试 {attempt}/{max_attempts}，cloud={cloud}）...", 'INFO')
            try:
                _, err, code = self._exec(client, install_cmd, timeout=self._PM2_SINGLE_TIMEOUT)
                if code == 0:
                    self._log(f"[{server_host}] PM2 安装完成（尝试 {attempt}/{max_attempts}）", 'SUCCESS')
                    return True
                last_reason = f"非零退出码({code}): {(err or '')[:160]}"
            except TimeoutError:
                last_reason = f"超时({self._PM2_SINGLE_TIMEOUT}s)"

            if attempt < max_attempts:
                base = self._PM2_BACKOFFS[attempt - 1]
                wait = base + random.uniform(0, base * 0.5)
                self._log(
                    f"[{server_host}] PM2 安装失败（{last_reason}），{wait:.1f}s 后重试 ({attempt+1}/{max_attempts})...",
                    'WARNING',
                )
                time.sleep(wait)

        raise RuntimeError(f"PM2 安装失败（已尝试 {max_attempts} 次）：{last_reason}")

    def _npm_install_project(self, client, server_host, cloud='default', mode='agent'):
        """项目目录跑 npm install。失败重试 7 次×240s，间隔 5/15/30/60/90/120s + 0~50% 抖动；按云走 npm 镜像。

        mode='agent': 在 AGENT_REMOTE_DIR 下用上传的精简 package.json 装
        mode='full' : 在 AGENT_FULL_REMOTE_DIR 下用完整 package.json 装（含 express/better-sqlite3 等，编译耗时）
        """
        is_windows = self._detect_os(client) == 'windows'
        registry = self._npm_registry_arg(cloud)
        remote_dir = self._resolve_remote_dir(client, mode)
        if is_windows:
            npm_cmd = (
                f"cd /d {remote_dir} && "
                "rmdir /s /q node_modules 2>nul & "
                "del package-lock.json 2>nul & "
                r'set "PATH=%ProgramFiles%\nodejs;%PATH%" && '
                f"set NODE_OPTIONS=--max-old-space-size=512 && "
                f"npm install {registry}--omit=dev --legacy-peer-deps 2>&1"
            )
        else:
            npm_cmd = (
                f"cd {remote_dir} && "
                "rm -rf node_modules package-lock.json 2>/dev/null; "
                "NODE_OPTIONS='--max-old-space-size=512' "
                f"npm install {registry}--omit=dev --legacy-peer-deps 2>&1"
            )

        max_attempts = self._NPM_MAX_ATTEMPTS
        last_reason = ''
        for attempt in range(1, max_attempts + 1):
            self._log(f"[{server_host}] npm install（尝试 {attempt}/{max_attempts}，cloud={cloud}）...", 'INFO')
            try:
                out, err, code = self._exec(client, npm_cmd, timeout=self._NPM_SINGLE_TIMEOUT)
                if code == 0:
                    self._log(f"[{server_host}] npm install 完成（尝试 {attempt}/{max_attempts}）", 'SUCCESS')
                    return True
                last_reason = f"非零退出码({code}): {(out + err)[:200]}"
            except TimeoutError:
                last_reason = f"超时({self._NPM_SINGLE_TIMEOUT}s)"

            if attempt < max_attempts:
                base = self._NPM_BACKOFFS[attempt - 1]
                wait = base + random.uniform(0, base * 0.5)
                self._log(
                    f"[{server_host}] npm install 失败（{last_reason[:120]}），{wait:.1f}s 后重试 ({attempt+1}/{max_attempts})...",
                    'WARNING',
                )
                time.sleep(wait)

        raise RuntimeError(f"npm install 失败（已尝试 {max_attempts} 次）：{last_reason[:300]}")

    def _ensure_build_tools(self, client, server_host):
        """确保编译工具链已安装（sqlite3 原生模块需要）。

        Linux: apt-get / yum 安装 build-essential + libsqlite3-dev。
        Windows: 跳过（better-sqlite3/sqlite3 有预编译二进制，无需编译工具）。
        本地部署：跳过（不在用户机上装系统编译链）。
        """
        if getattr(client, 'is_local', False):
            self._log(f"[{server_host}] 本地部署，跳过编译工具安装（用预编译原生模块）", 'INFO')
            return
        if self._detect_os(client) == 'windows':
            self._log(f"[{server_host}] Windows 环境，跳过编译工具安装（使用预编译原生模块）", 'INFO')
            return

        # 检测 gcc 是否可用作为编译工具存在的代理指标
        gcc_ok, _, _ = self._exec(client, "dpkg -l build-essential 2>/dev/null | grep -q '^ii' && echo OK || echo NO", timeout=10)
        if gcc_ok.strip() == 'OK':
            self._log(f"[{server_host}] 编译工具链已安装，跳过", 'INFO')
        else:
            self._log(f"[{server_host}] 安装编译工具链（build-essential + libsqlite3-dev）...", 'INFO')
            cmd = (
                "if command -v apt-get &>/dev/null; then "
                "  sudo apt-get update -qq && sudo apt-get install -y -qq "
                "  build-essential python3 python3-dev make gcc g++ libsqlite3-dev; "
                "elif command -v yum &>/dev/null; then "
                "  sudo yum groupinstall -y 'Development Tools' && sudo yum install -y python3 sqlite-devel; "
                "fi && sudo ln -sf /usr/bin/python3 /usr/bin/python 2>/dev/null || true"
            )
            _, err, code = self._exec(client, cmd, timeout=300)
            if code != 0:
                self._log(f"[{server_host}] 编译工具安装警告（继续）: {err[:100]}", 'WARNING')

        # node-gyp
        gyp_out, _, _ = self._exec(client, "node-gyp -v 2>/dev/null || echo NOT_FOUND", timeout=10)
        if 'NOT_FOUND' in gyp_out or not gyp_out.strip():
            self._log(f"[{server_host}] 安装 node-gyp...", 'INFO')
            self._exec(client, "sudo npm install -g node-gyp 2>/dev/null || true", timeout=60)

    # ──────────────────────────────────────────────────────────
    # 单台服务器操作
    # ──────────────────────────────────────────────────────────
    def _step(self, step_cb, msg):
        """调用步骤回调（step_cb 可为 None）"""
        if step_cb:
            try:
                step_cb(msg)
            except Exception:
                pass

    # ──────────────────────────────────────────────────────────
    # 云厂商探测（懒加载到 DB）
    # ──────────────────────────────────────────────────────────
    def _detect_cloud(self, client):
        """通过 metadata API 探测云厂商，返回 'aliyun' / 'tencent' / 'default'。
        阿里云: http://100.100.100.200/latest/meta-data/
        腾讯云: http://metadata.tencentyun.com/latest/meta-data/
        各 2s 超时，整体最多 ~5s。"""
        # 阿里云
        out, _, code = self._exec(
            client,
            "curl -m 2 -s -o /dev/null -w '%{http_code}' http://100.100.100.200/latest/meta-data/ 2>/dev/null",
            timeout=5,
        )
        if code == 0 and out.strip() == '200':
            return 'aliyun'
        # 腾讯云
        out, _, code = self._exec(
            client,
            "curl -m 2 -s -o /dev/null -w '%{http_code}' http://metadata.tencentyun.com/latest/meta-data/ 2>/dev/null",
            timeout=5,
        )
        if code == 0 and out.strip() == '200':
            return 'tencent'
        return 'default'

    def _resolve_cloud(self, server, client, host):
        """获取该服务器的云厂商：'auto' 时探测并写回 DB；其它直接返回。"""
        if getattr(client, 'is_local', False):
            return 'default'  # 本机无云厂商，直接 default（不走 metadata 探测）
        cp = (server.get('cloud_provider') or 'auto').strip().lower()
        if cp not in ('auto', 'aliyun', 'tencent', 'default'):
            cp = 'auto'
        if cp != 'auto':
            return cp
        # 懒加载探测
        try:
            detected = self._detect_cloud(client)
        except Exception as e:
            self._log(f"[{host}] 云厂商探测异常（回落 default）: {e}", 'WARNING')
            detected = 'default'
        # 缓存到 DB（即使是 'default' 也写回，避免每次都探）
        try:
            from database import ProxyDatabase
            ProxyDatabase(self.db_file).update_server_cloud_provider(server['id'], detected)
        except Exception as e:
            self._log(f"[{host}] 云厂商写回 DB 失败（已忽略）: {e}", 'WARNING')
        self._log(f"[{host}] 云厂商探测结果: {detected}", 'INFO')
        return detected

    def _health_check(self, client, mode='agent'):
        """执行 HTTP 健康检查，返回 (health:bool, uptime, running_tasks)"""
        import json
        is_windows = self._detect_os(client) == 'windows'

        if mode == 'full':
            if is_windows:
                curl_cmd = (
                    f"powershell -Command \"try {{ "
                    f"$r=Invoke-WebRequest -Uri 'http://localhost:{AGENT_FULL_PORT}/' "
                    f"-UseBasicParsing -TimeoutSec 3; "
                    f"Write-Host $r.StatusCode "
                    f"}} catch {{ Write-Host '000' }}\""
                )
            else:
                curl_cmd = (
                    f"curl -s -o /dev/null --max-time 3 -w '%{{http_code}}' "
                    f"http://localhost:{AGENT_FULL_PORT}/ 2>/dev/null || echo 000"
                )
            code_out, _, _ = self._exec(client, curl_cmd, timeout=8)
            try:
                hc = int(code_out.strip()[:3])
            except ValueError:
                hc = 0
            return 200 <= hc < 400, None, None

        if is_windows:
            health_cmd = (
                f"powershell -Command \"try {{ "
                f"$r=Invoke-WebRequest -Uri 'http://localhost:{AGENT_PORT}/health' "
                f"-UseBasicParsing -TimeoutSec 3; "
                f"Write-Host $r.Content "
                f"}} catch {{ Write-Host 'FAIL' }}\""
            )
        else:
            health_cmd = (
                f"curl -sf --max-time 3 http://localhost:{AGENT_PORT}/health 2>/dev/null || echo FAIL"
            )
        health_out, _, _ = self._exec(client, health_cmd, timeout=8)
        health = '"status":"ok"' in health_out
        uptime, running_tasks = None, None
        if health:
            try:
                data = json.loads(health_out)
                uptime = data.get('uptime')
                running_tasks = data.get('runningTasks')
            except Exception:
                pass
        return health, uptime, running_tasks

    # ──────────────────────────────────────────────────────────
    # 部署进行中状态查询（GUI 用，per-server 锁配套）
    # ──────────────────────────────────────────────────────────
    def get_deploying_ids(self):
        """快照：当前正在部署中的 server_id 集合。GUI 分类用。"""
        with self._deploying_lock:
            return set(self._deploying_ids)

    def deploy_server(self, server, step_cb=None, mode='agent'):
        """
        完整部署流程，step_cb(msg) 在每个步骤回调供 GUI 实时显示。
        mode='agent': 精简模式（6 子目录 + package-agent.json，PM2 跑 agent/server.js）
        mode='full' : 完整模式（整个 gamyy-core 按排除规则上传 + 完整 package.json，PM2 跑 web/server.js）
        返回 {'ok': bool, 'msg': str, 'status': dict}

        per-server 锁：同一 server_id 同时只允许一个 deploy 在跑。重复发起立即返回失败。
        """
        host = server['server_host']
        server_id = server['id']

        # 进入锁：占用 _deploying_ids[server_id]
        with self._deploying_lock:
            if server_id in self._deploying_ids:
                self._log(f"[{host}] 跳过：该服务器已有部署任务在运行", 'WARNING')
                return {'ok': False, 'msg': '该服务器已有部署任务在运行', 'status': None}
            self._deploying_ids.add(server_id)

        client = None
        try:
            # 解析部署源（imported > synced > bundled > external）
            source_root, source_kind = get_deploy_source()
            if source_root is None:
                self._log(f"[{host}] 找不到部署源（imported/synced/bundled/external 全部不可用）", 'ERROR')
                return {'ok': False, 'msg': '找不到部署源', 'status': None}
            self._log(f"[{host}] 使用部署源：{source_kind} ({source_root})", 'INFO')

            self._step(step_cb, '连接本机...' if server.get('is_local') else '连接SSH...')
            self._log(f"[{host}] 开始部署（mode={mode}）...", 'INFO')
            client = self._make_executor(server)

            self._step(step_cb, '探测云厂商...')
            cloud = self._resolve_cloud(server, client, host)

            self._step(step_cb, '检测Node.js...')
            self._ensure_nodejs(client, host, cloud)

            self._step(step_cb, '检测PM2...')
            self._ensure_pm2(client, host, cloud)

            self._step(step_cb, '检测编译工具...')
            self._ensure_build_tools(client, host)

            self._step(step_cb, '上传文件...')
            self._log(f"[{host}] 上传文件（mode={mode}）...", 'INFO')
            self._upload_agent_files(client, host, source_root=source_root, mode=mode)
            self._log(f"[{host}] 文件上传完成", 'SUCCESS')

            self._step(step_cb, 'npm install...')
            self._log(f"[{host}] npm install（{'完整模式 ~3-5 分钟' if mode == 'full' else '首次约1~2分钟'}）...", 'INFO')
            self._npm_install_project(client, host, cloud, mode=mode)

            self._step(step_cb, '启动服务...')
            self._pm2_start_or_restart(client, host, mode=mode)

            self._step(step_cb, '健康检查...')
            time.sleep(2)
            health, uptime, running_tasks = self._health_check(client, mode=mode)
            status = {
                'pm2': 'online' if health else 'started',
                'health': health,
                'uptime': uptime,
                'running_tasks': running_tasks,
            }
            if health:
                self._log(f"[{host}] 部署成功 ✅", 'SUCCESS')
                self._write_deploy_status(server, 'success', mode)
                return {'ok': True, 'msg': 'deployed', 'status': status}
            else:
                self._log(f"[{host}] 部署完成但健康检查未通过", 'WARNING')
                # 健康检查未通过仍记成功（PM2 已起、npm 已装），只是健康端点暂未就绪——
                # 真挂掉会在下一次 status 检查体现。这里写 'success' 让"选择失败"不挑出来。
                self._write_deploy_status(server, 'success', mode)
                return {'ok': True, 'msg': 'deployed_unhealthy', 'status': status}

        except Exception as e:
            self._log(f"[{host}] 部署失败: {e}", 'ERROR')
            self._write_deploy_status(server, 'failed', mode)
            return {'ok': False, 'msg': str(e), 'status': None}
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass
            # 释放 per-server 锁
            with self._deploying_lock:
                self._deploying_ids.discard(server_id)

    def _write_deploy_status(self, server, status, mode=None):
        """部署完成后把结果写回 ssh_servers。

        deploy_mode 只在部署成功时写入：
        - 如果该服务器之前从未成功部署过 → 直接设为当前 mode（避免被 DB 默认值 'agent' 污染）
        - 如果已有其他 mode 部署成功 → 追加当前 mode（逗号分隔去重，如 'agent,full'）
        status='failed' → 只写 status，不动 deploy_mode
        """
        try:
            from database import ProxyDatabase
            db = ProxyDatabase(self.db_file)
            db.update_server_deploy_status(server['id'], status)
            if mode and status == 'success':
                current = (server.get('deploy_mode') or '').strip()
                modes = set(m.strip() for m in current.split(',') if m.strip())
                # 如果之前从未部署成功过，说明 current 只是 DB 默认值（如 'agent'），应直接覆盖
                prev_status = server.get('last_deploy_status', 'never')
                if prev_status != 'success':
                    modes = set()
                modes.add(mode)
                new_mode = ','.join(sorted(modes))
                db.update_server_deploy_mode(server['id'], new_mode)
                server['deploy_mode'] = new_mode  # 同步内存
        except Exception as e:
            self._log(f"[{server.get('server_host','?')}] 状态写回失败: {e}", 'WARNING')

    @staticmethod
    def _get_modes(server):
        """解析 deploy_mode 为 mode 列表。空字符串返回空列表。"""
        raw = (server.get('deploy_mode') or '').strip()
        return [m.strip() for m in raw.split(',') if m.strip()]

    def start_server(self, server, step_cb=None):
        host = server['server_host']
        modes = self._get_modes(server)
        if not modes:
            return {'ok': True, 'msg': '未部署（无可启动模式）', 'status': {'pm2': '—', 'health': False, 'uptime': None, 'running_tasks': None}}
        client = None
        try:
            self._step(step_cb, '连接本机...' if server.get('is_local') else '连接SSH...')
            client = self._make_executor(server)
            for mode in modes:
                self._step(step_cb, f'启动 {mode}...')
                self._pm2_start_or_restart(client, host, mode=mode)
                time.sleep(1)
            self._step(step_cb, '健康检查...')
            time.sleep(1)
            health, uptime, running_tasks = self._health_check(client, mode=modes[0])
            status = {'pm2': 'online' if health else 'started', 'health': health,
                      'uptime': uptime, 'running_tasks': running_tasks}
            return {'ok': True, 'msg': 'started', 'status': status}
        except Exception as e:
            self._log(f"[{host}] 启动失败: {e}", 'ERROR')
            return {'ok': False, 'msg': str(e), 'status': None}
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def stop_server(self, server, step_cb=None):
        host = server['server_host']
        modes = self._get_modes(server)
        client = None
        try:
            self._step(step_cb, '连接本机...' if server.get('is_local') else '连接SSH...')
            client = self._make_executor(server)
            is_windows = self._detect_os(client) == 'windows'
            for mode in modes:
                port = AGENT_FULL_PORT if mode == 'full' else AGENT_PORT
                pm2_name = AGENT_FULL_PM2_NAME if mode == 'full' else AGENT_PM2_NAME
                if client.is_local:
                    # 本地：按端口杀进程（不走 pm2）
                    self._step(step_cb, f'停止 {mode} (端口 {port})...')
                    client.stop_port(port)
                    self._log(f"[{host}] 已停止端口 {port} ({mode})", 'INFO')
                elif is_windows:
                    self._step(step_cb, f'停止 {mode} (端口 {port})...')
                    self._exec(client,
                        f"for /f \"tokens=5\" %p in ('netstat -ano 2^>nul ^| findstr :{port} ^| findstr LISTENING') do @taskkill /f /pid %p >nul 2>&1",
                        timeout=15)
                    self._log(f"[{host}] 已停止端口 {port} ({mode})", 'INFO')
                else:
                    self._step(step_cb, f'停止PM2 ({pm2_name})...')
                    out, _, _ = self._exec(client, f"pm2 stop {pm2_name} 2>&1 || true", timeout=30)
                    self._log(f"[{host}] 停止 {pm2_name}: {out[:100]}", 'INFO')
                time.sleep(0.5)
            status = {'pm2': 'stopped', 'health': False, 'uptime': None, 'running_tasks': None}
            return {'ok': True, 'msg': 'stopped', 'status': status}
        except Exception as e:
            self._log(f"[{host}] 停止失败: {e}", 'ERROR')
            return {'ok': False, 'msg': str(e), 'status': None}
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def restart_server(self, server, step_cb=None):
        host = server['server_host']
        modes = self._get_modes(server)
        if not modes:
            return {'ok': True, 'msg': '未部署（无可重启模式）', 'status': {'pm2': '—', 'health': False, 'uptime': None, 'running_tasks': None}}
        client = None
        try:
            self._step(step_cb, '连接本机...' if server.get('is_local') else '连接SSH...')
            client = self._make_executor(server)
            is_windows = self._detect_os(client) == 'windows'
            for mode in modes:
                port = AGENT_FULL_PORT if mode == 'full' else AGENT_PORT
                if client.is_local:
                    self._step(step_cb, f'停止旧进程 {mode} (端口 {port})...')
                    client.stop_port(port)
                    time.sleep(1)
                elif is_windows:
                    self._step(step_cb, f'停止旧进程 {mode} (端口 {port})...')
                    self._exec(client,
                        f"for /f \"tokens=5\" %p in ('netstat -ano 2^>nul ^| findstr :{port} ^| findstr LISTENING') do @taskkill /f /pid %p >nul 2>&1",
                        timeout=15)
                    time.sleep(1)
                self._step(step_cb, f'重启 {mode}...')
                self._pm2_start_or_restart(client, host, mode=mode)
                time.sleep(0.5)
            self._step(step_cb, '健康检查...')
            time.sleep(1)
            health, uptime, running_tasks = self._health_check(client, mode=modes[0])
            status = {'pm2': 'online' if health else 'restarted', 'health': health,
                      'uptime': uptime, 'running_tasks': running_tasks}
            return {'ok': True, 'msg': 'restarted', 'status': status}
        except Exception as e:
            self._log(f"[{host}] 重启失败: {e}", 'ERROR')
            return {'ok': False, 'msg': str(e), 'status': None}
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def get_server_status(self, server):
        """返回 pm2/health/uptime/running_tasks，多 mode 时合并（任一 online/healthy 即算）。"""
        host = server['server_host']
        modes = self._get_modes(server)
        client = None
        try:
            client = self._make_executor(server)
            is_windows = self._detect_os(client) == 'windows'
            merged_pm2 = 'not_found'
            merged_health = False
            merged_uptime = None
            merged_tasks = None
            for mode in modes:
                port = AGENT_FULL_PORT if mode == 'full' else AGENT_PORT
                pm2_name = AGENT_FULL_PM2_NAME if mode == 'full' else AGENT_PM2_NAME
                if client.is_local:
                    # 本地：按端口判 online + HTTP 健康
                    listening = client.is_listening(port)
                    pm2_status = 'online' if listening else 'stopped'
                    if is_windows:
                        health_cmd = (
                            f"powershell -Command \"try {{ "
                            f"$r=Invoke-WebRequest -Uri 'http://localhost:{port}/health' "
                            f"-UseBasicParsing -TimeoutSec 3; Write-Host $r.Content "
                            f"}} catch {{ Write-Host 'FAIL' }}\""
                        )
                    else:
                        health_cmd = f"curl -sf --max-time 3 http://localhost:{port}/health 2>/dev/null || echo FAIL"
                elif is_windows:
                    out, _, code = self._exec(client,
                        f"netstat -ano 2>nul | findstr :{port} | findstr LISTENING >nul && echo online || echo stopped",
                        timeout=15)
                    pm2_status = 'online' if 'online' in out else 'stopped'
                    health_cmd = (
                        f"powershell -Command \"try {{ "
                        f"$r=Invoke-WebRequest -Uri 'http://localhost:{port}/health' "
                        f"-UseBasicParsing -TimeoutSec 3; Write-Host $r.Content "
                        f"}} catch {{ Write-Host 'FAIL' }}\""
                    )
                else:
                    out, _, code = self._exec(client,
                        f"pm2 show {pm2_name} 2>/dev/null | grep -E 'status|uptime' || echo NOT_FOUND",
                        timeout=30)
                    if 'NOT_FOUND' in out or code != 0:
                        pm2_status = 'not_found'
                    elif 'online' in out.lower():
                        pm2_status = 'online'
                    elif 'stopped' in out.lower() or 'errored' in out.lower():
                        pm2_status = 'stopped'
                    else:
                        pm2_status = 'unknown'
                    health_cmd = f"curl -sf --max-time 3 http://localhost:{port}/health 2>/dev/null || echo FAIL"
                health_out, _, _ = self._exec(client, health_cmd, timeout=8)
                health = '"status":"ok"' in health_out
                if pm2_status == 'online':
                    merged_pm2 = 'online'
                elif merged_pm2 == 'not_found' and pm2_status not in ('not_found', 'unknown'):
                    merged_pm2 = pm2_status
                if health:
                    merged_health = True
                    import json
                    try:
                        data = json.loads(health_out)
                        if merged_tasks is None:
                            merged_tasks = data.get('runningTasks')
                        if merged_uptime is None:
                            merged_uptime = data.get('uptime')
                    except Exception:
                        pass
            return {'pm2': merged_pm2, 'health': merged_health, 'uptime': merged_uptime, 'running_tasks': merged_tasks}
        except Exception:
            return {'pm2': 'error', 'health': False, 'uptime': None, 'running_tasks': None}
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass
    def get_server_logs(self, server, lines=100):
        """获取 PM2 日志最后 N 行，返回字符串"""
        host = server['server_host']
        client = None
        try:
            client = self._make_executor(server)
            if client.is_local:
                # 本地：读 server.log 末尾
                return client.read_log_tail(lines)
            out, err, _ = self._exec(
                client,
                f"pm2 logs {AGENT_PM2_NAME} --lines {lines} --nostream 2>&1",
                timeout=30,
            )
            return out or err or '(无日志)'
        except Exception as e:
            return f'获取日志失败: {e}'
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def download_db(self, server, local_dir=None):
        """
        通过 SFTP 下载云端 ticket_checker.db 到本地。
        返回 (ok, local_path_or_error_msg)
        """
        host = server['server_host']
        if server.get('is_local'):
            # 本机日志DB就在本地 LOCAL_DEPLOY_DIR/data 下，无需下载
            return False, '本机无需下载日志DB（数据就在本地部署目录 data/ 下）'
        save_dir = local_dir or AGENT_LOG_SAVE_DIR
        os.makedirs(save_dir, exist_ok=True)

        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"{host}_{ts}.db"
        local_path = os.path.join(save_dir, filename)

        client = None
        try:
            client = self._connect(server)
            sftp = client.open_sftp()
            try:
                sftp.stat(AGENT_REMOTE_DB)  # 确认文件存在
                sftp.get(AGENT_REMOTE_DB, local_path)
            finally:
                sftp.close()
            self._log(f"[{host}] 日志DB已保存: {local_path}", 'SUCCESS')
            return True, local_path
        except FileNotFoundError:
            msg = f"远端数据库不存在: {AGENT_REMOTE_DB}"
            self._log(f"[{host}] {msg}", 'WARNING')
            return False, msg
        except Exception as e:
            self._log(f"[{host}] 下载DB失败: {e}", 'ERROR')
            return False, str(e)
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    # ──────────────────────────────────────────────────────────
    # 批量并发操作
    # ──────────────────────────────────────────────────────────
    # 入场抖动：批量任务开局所有 worker 同一瞬间冲向 _connect_sem，会让 SSH 握手
    # SYN 在同一时刻爆发，触发云厂商 SYN 限流；给每个任务 0~JITTER 秒的随机入场延迟，
    # 把"齐刷刷一波 SYN"摊成"几秒内均匀分散"。
    _BATCH_JITTER_SECONDS = 3.0

    def _batch_run(self, server_ids, op_func, max_workers, progress_cb=None, step_factory=None):
        """
        对 server_ids 对应的服务器并发执行 op_func(server, step_cb=...)。
        progress_cb(done, total, server_id, host, result) 每完成一台调用一次。
        step_factory(server_id, host) -> step_cb(msg)，可为 None。
        返回 list[{'server_id', 'host', 'ok', 'msg', 'status'}]

        每个 worker 入场前会 sleep 0~_BATCH_JITTER_SECONDS 秒，避免首波 SSH 握手扎堆。
        """
        # 一次 SQL 批量查询，替代串行 N 次单查
        servers = self.get_servers_by_ids(server_ids)

        total = len(servers)
        results = []
        done_count = 0

        # I/O 密集型任务线程栈 512KB 足够，默认 8MB 会在高并发时浪费大量内存
        # (Linux 生效；Windows 忽略)
        try:
            threading.stack_size(512 * 1024)
        except Exception:
            pass

        # 抖动幅度：批量较小（<=10）时不抖；较大时按上限 _BATCH_JITTER_SECONDS
        jitter = self._BATCH_JITTER_SECONDS if total > 10 else 0.0

        def _with_jitter(server, step_cb):
            if jitter > 0:
                time.sleep(random.uniform(0, jitter))
            return op_func(server, step_cb)

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_to_server = {}
            for s in servers:
                step_cb = step_factory(s['id'], s['server_host']) if step_factory else None
                future = pool.submit(_with_jitter, s, step_cb)
                future_to_server[future] = s

            for future in as_completed(future_to_server):
                s = future_to_server[future]
                try:
                    res = future.result()
                except Exception as e:
                    res = {'ok': False, 'msg': str(e), 'status': None}

                done_count += 1
                entry = {
                    'server_id': s['id'],
                    'host':      s['server_host'],
                    'ok':        res.get('ok', False),
                    'msg':       res.get('msg', ''),
                    'status':    res.get('status'),
                }
                results.append(entry)

                if progress_cb:
                    try:
                        progress_cb(done_count, total, s['id'], s['server_host'], res)
                    except Exception:
                        pass

        return results

    def batch_deploy(self, server_ids, progress_cb=None, step_factory=None, mode='agent'):
        """批量部署。mode='agent'（精简）或 'full'（完整项目，跑 web/server.js）

        入口先按 _deploying_ids 过滤一遍：已在部署中的 ID 不再下发 worker。
        这是 GUI 弹窗"自动跳过"语义的真实落地——避免同台 SSH/SFTP/npm 撞车。
        （deploy_server 内部也有 per-server 锁兜底，是防御性双保险。）
        """
        with self._deploying_lock:
            filtered_ids = [i for i in server_ids if i not in self._deploying_ids]
        skipped = len(server_ids) - len(filtered_ids)
        if skipped > 0:
            self._log(f"批量部署：跳过 {skipped} 台正在部署中的服务器", 'INFO')

        def _do(server, step_cb):
            return self.deploy_server(server, step_cb, mode=mode)
        return self._batch_run(filtered_ids, _do, AGENT_DEPLOY_WORKERS, progress_cb, step_factory)

    def batch_start(self, server_ids, progress_cb=None, step_factory=None):
        return self._batch_run(server_ids, self.start_server, AGENT_OP_WORKERS, progress_cb, step_factory)

    def batch_stop(self, server_ids, progress_cb=None, step_factory=None):
        return self._batch_run(server_ids, self.stop_server, AGENT_OP_WORKERS, progress_cb, step_factory)

    def batch_restart(self, server_ids, progress_cb=None, step_factory=None):
        return self._batch_run(server_ids, self.restart_server, AGENT_OP_WORKERS, progress_cb, step_factory)

    def batch_status(self, server_ids, progress_cb=None):
        """返回 list[{'server_id','host','pm2','health','uptime','running_tasks'}]"""
        servers = self.get_servers_by_ids(server_ids)

        total = len(servers)
        results = []
        done_count = 0

        with ThreadPoolExecutor(max_workers=AGENT_OP_WORKERS) as pool:
            future_to_server = {pool.submit(self.get_server_status, s): s for s in servers}
            for future in as_completed(future_to_server):
                s = future_to_server[future]
                try:
                    status = future.result()
                except Exception as e:
                    status = {'pm2': 'error', 'health': False, 'uptime': None, 'running_tasks': None}

                done_count += 1
                entry = {
                    'server_id': s['id'],
                    'host': s['server_host'],
                    **status,
                }
                results.append(entry)

                if progress_cb:
                    try:
                        progress_cb(done_count, total, s['id'], s['server_host'], status)
                    except Exception:
                        pass

        return results

    def batch_download_db(self, server_ids, local_dir=None, progress_cb=None):
        """并发下载多台服务器的日志DB"""
        servers = self.get_servers_by_ids(server_ids)

        total = len(servers)
        results = []
        done_count = 0

        def _do(s):
            return self.download_db(s, local_dir)

        with ThreadPoolExecutor(max_workers=AGENT_OP_WORKERS) as pool:
            future_to_server = {pool.submit(_do, s): s for s in servers}
            for future in as_completed(future_to_server):
                s = future_to_server[future]
                try:
                    ok, path = future.result()
                except Exception as e:
                    ok, path = False, str(e)

                done_count += 1
                results.append({'server_id': s['id'], 'host': s['server_host'], 'ok': ok, 'path': path})

                if progress_cb:
                    try:
                        progress_cb(done_count, total, s['id'], s['server_host'], {'ok': ok, 'path': path})
                    except Exception:
                        pass

        return results

    def _pm2_start_or_restart(self, client, host, mode='agent'):
        """启动/重启服务进程。

        本地: subprocess.Popen 后台 node（脱离父进程）
        Linux: PM2 管理
        Windows: PowerShell Start-Process 后台启动（PM2 在 Windows 上不稳定）
        """
        is_windows = self._detect_os(client) == 'windows'

        if mode == 'full':
            proc_name = AGENT_FULL_PM2_NAME   # 复用 PM2 名作为进程标识
            entry_script = 'web/server.js'
            port = AGENT_FULL_PORT
        else:
            proc_name = AGENT_PM2_NAME
            entry_script = 'agent/server.js'
            port = AGENT_PORT
        remote_dir = self._resolve_remote_dir(client, mode)

        if client.is_local:
            # --- 本地：原生 subprocess 后台启动 node ---
            client.stop_port(port)          # 先杀旧进程（kill-before-start）
            time.sleep(1)
            log_path = os.path.join(remote_dir, 'server.log')
            pid = client.start_node(remote_dir, entry_script, log_path)
            self._log(f"[{host}] 本地后台启动 node {entry_script} (PID={pid})", 'INFO')
            time.sleep(3)
            if client.is_listening(port):
                self._log(f"[{host}] 服务启动成功 ✅（端口 {port} 已监听）", 'SUCCESS')
            else:
                self._log(f"[{host}] 端口 {port} 未监听，检查 {log_path}", 'WARNING')
            return

        if is_windows:
            # --- Windows: 直接 node 后台进程 ---
            # 1. 杀掉旧进程（按端口）
            kill_cmd = (
                f"for /f \"tokens=5\" %p in ('netstat -ano ^| findstr :{port} ^| findstr LISTENING') do "
                f"@taskkill /f /pid %p >nul 2>&1"
            )
            self._exec(client, kill_cmd, timeout=10)

            # 2. 后台启动（echo 写 bat → wmic 启动，完全脱离 SSH 会话）
            log_out = remote_dir + "\\server.log"
            bat_file = remote_dir + "\\start-server.bat"
            # 用 cmd echo 写启动脚本（^> ^& 转义避免过早重定向）
            # %ProgramFiles% 和 %PATH% 由远程 cmd 在 echo 前展开 → bat 里得到具体路径
            write_cmd = (
                f"echo @echo off > {bat_file} & "
                r'echo set "PATH=%ProgramFiles%\nodejs;%PATH%" >> ' + f"{bat_file} & "
                f"echo cd /d {remote_dir} >> {bat_file} & "
                f"echo node {entry_script} ^> {log_out} 2^>^&1 >> {bat_file}"
            )
            self._exec(client, write_cmd, timeout=10)
            # wmic 启动：进程归 SYSTEM，完全脱离 SSH 会话
            start_cmd = f'wmic process call create "cmd /c {bat_file}"'
            self._log(f"[{host}] Windows 后台启动 node {entry_script}...", 'INFO')
            out, err, code = self._exec(client, start_cmd, timeout=15)
            # 给 node 5 秒启动
            time.sleep(5)
            # 端口检测
            check = f"netstat -ano 2>nul | findstr :{port} | findstr LISTENING"
            check_out, _, check_code = self._exec(client, check, timeout=10)
            if check_code == 0:
                self._log(f"[{host}] 服务启动成功 ✅（端口 {port} 已监听）", 'SUCCESS')
            else:
                self._log(f"[{host}] 端口 {port} 未监听，检查 {log_out}", 'WARNING')
            return

        # --- Linux: PM2 ---
        detect_cmd = (
            f"pm2 jlist 2>/dev/null | grep -q '\"name\":\"{proc_name}\"' && echo EXISTS || echo NOTEXIST"
        )
        out, _, code = self._exec(client, detect_cmd, timeout=30)
        if 'EXISTS' in out:
            self._log(f"[{host}] PM2 重启 {proc_name}...", 'INFO')
            self._exec(client, f"pm2 restart {proc_name}", timeout=30)
        else:
            self._log(f"[{host}] PM2 首次启动 {proc_name}...", 'INFO')
            self._exec(
                client,
                f"cd {remote_dir} && pm2 start {entry_script} --name {proc_name}",
                timeout=30,
            )
        self._exec(client, "pm2 save", timeout=30)
        self._log(f"[{host}] PM2 启动完成", 'SUCCESS')
