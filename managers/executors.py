# managers/executors.py
"""
执行器抽象：让「SSH 到云服务器」与「本机直接执行」对上层部署流程透明可互换。

- Executor       接口（exec / detect_os / resolve_dir / mkdirs / put_file / close）
- SSHExecutor    包装一个已连接的 paramiko client（行为 = 原 AgentDeployManager 的 SSH 逻辑）
- LocalExecutor  用 subprocess + shutil 在本机执行（本地部署 = 完整部署跑在本机，无需 SSH）

设计要点：
- AgentDeployManager 的各 op 方法把原来的 `client`(paramiko) 换成 `ex`(Executor)，
  方法体里的 self._exec(ex,...) / self._detect_os(ex) 都委托到 ex 上，改动面最小。
- 进程级起停（启动 node / 按端口杀进程 / 端口监听检测）在本地与远端语义不同，
  由 Executor 暴露 start_node / stop_port / is_listening，本地用原生 subprocess。
"""
import os
import time
import shutil
import stat
import subprocess

def _rmtree_force(path):
    """shutil.rmtree 的 Windows 兼容版：遇只读文件先取消只读再删。"""
    if not os.path.isdir(path):
        return
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            try:
                os.chmod(os.path.join(root, name), stat.S_IWRITE)
            except Exception:
                pass
    def _onerror(func, p, _exc_info):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass
    shutil.rmtree(path, onerror=_onerror)

from config import (
    AGENT_REMOTE_DIR, AGENT_FULL_REMOTE_DIR, AGENT_FULL_PORT,
    LOCAL_DEPLOY_DIR, _app_root,
)

#  Windows 远程/本地部署路径（与 Linux /opt/... 区分）。使用正斜杠兼容 cmd.exe 与 SFTP。
AGENT_WINDOWS_REMOTE_DIR = "C:/opt/gamyy-agent"
AGENT_WINDOWS_FULL_REMOTE_DIR = "C:/opt/gamyy-core"

# 本地部署目录里写入的哨兵文件名：rmtree 前必须确认它存在，否则拒删（防误删非本程序目录）。
LOCAL_SENTINEL = '.gamyy_deploy'

# 本地部署清理时会备份的数据库文件（备份到 target 外部的兄弟目录）
_LOCAL_BACKUP_DBS = ['config.db', 'hospital.db', 'ticket_checker.db']


class Executor:
    """执行器接口。子类须实现下列方法；is_local 区分本地/远端分支。"""
    is_local = False

    def exec(self, cmd, timeout=120):
        """执行命令，返回 (stdout_str, stderr_str, exit_code)。超时抛 TimeoutError。"""
        raise NotImplementedError

    def detect_os(self):
        """返回 'windows' 或 'linux'（结果缓存）。"""
        raise NotImplementedError

    def resolve_dir(self, mode='agent'):
        """返回部署根目录。"""
        raise NotImplementedError

    def mkdirs(self, remote_dir):
        """递归创建目录。"""
        raise NotImplementedError

    def put_file(self, local_path, remote_path):
        """把单个文件放到目标位置。"""
        raise NotImplementedError

    def close(self):
        pass

    # —— 进程级起停（本地与远端语义不同）——
    def stop_port(self, port):
        """杀掉监听 port 的进程。"""
        raise NotImplementedError

    def is_listening(self, port):
        """port 是否处于 LISTENING。"""
        raise NotImplementedError


# ──────────────────────────────────────────────────────────────────────
# SSHExecutor —— 包装 paramiko client（行为等价于原 SSH 逻辑）
# ──────────────────────────────────────────────────────────────────────
class SSHExecutor(Executor):
    is_local = False

    def __init__(self, client):
        self.client = client
        self._sftp = None
        self._os = None

    # —— 命令执行（与原 AgentDeployManager._exec 一致）——
    def exec(self, cmd, timeout=120):
        stdin, stdout, stderr = self.client.exec_command(cmd)
        channel = stdout.channel
        deadline = time.monotonic() + timeout
        while not channel.exit_status_ready():
            if time.monotonic() > deadline:
                channel.close()
                raise TimeoutError(f"命令超时({timeout}s): {cmd[:80]}")
            time.sleep(0.5)
        exit_code = channel.recv_exit_status()
        out = stdout.read().decode('utf-8', errors='replace').strip()
        err = stderr.read().decode('utf-8', errors='replace').strip()
        return out, err, exit_code

    def detect_os(self):
        if self._os is not None:
            return self._os
        out, _, code = self.exec("ver", timeout=5)
        self._os = 'windows' if (code == 0 and 'Windows' in out) else 'linux'
        return self._os

    def resolve_dir(self, mode='agent'):
        if self.detect_os() == 'windows':
            return AGENT_WINDOWS_FULL_REMOTE_DIR if mode == 'full' else AGENT_WINDOWS_REMOTE_DIR
        return AGENT_FULL_REMOTE_DIR if mode == 'full' else AGENT_REMOTE_DIR

    # —— SFTP（懒开，复用单一会话）——
    def _get_sftp(self):
        if self._sftp is None:
            self._sftp = self.client.open_sftp()
        return self._sftp

    def mkdirs(self, remote_path):
        """递归创建远端目录（兼容 Linux /opt/... 和 Windows C:/opt/...）。"""
        sftp = self._get_sftp()
        # Windows 路径格式：C:/opt/gamyy-core → 跳过盘符，从 C:/opt 开始创建
        if len(remote_path) >= 2 and remote_path[1] == ':':
            parts = remote_path.replace('\\', '/').split('/')
            if not parts[-1]:
                parts.pop()
            for i in range(2, len(parts) + 1):
                current = '/'.join(parts[:i])
                try:
                    sftp.stat(current)
                except FileNotFoundError:
                    sftp.mkdir(current)
            return
        # Linux 路径格式：/opt/gamyy-core
        parts = remote_path.rstrip('/').split('/')
        current = ''
        for part in parts:
            if not part:
                current = '/'
                continue
            current = current.rstrip('/') + '/' + part
            try:
                sftp.stat(current)
            except FileNotFoundError:
                sftp.mkdir(current)

    def put_file(self, local_path, remote_path):
        self._get_sftp().put(local_path, remote_path)

    def get_file(self, remote_path, local_path):
        sftp = self._get_sftp()
        sftp.stat(remote_path)  # 不存在抛 FileNotFoundError
        sftp.get(remote_path, local_path)

    # —— 进程级起停：沿用原 SSH 内联命令逻辑，按 OS 区分 ——
    def stop_port(self, port):
        if self.detect_os() == 'windows':
            self.exec(
                f"for /f \"tokens=5\" %p in ('netstat -ano 2^>nul ^| findstr :{port} ^| findstr LISTENING') do "
                f"@taskkill /f /pid %p >nul 2>&1",
                timeout=15)
        else:
            self.exec(f"kill $(lsof -ti:{port}) 2>/dev/null || true", timeout=15)

    def is_listening(self, port):
        if self.detect_os() == 'windows':
            _, _, code = self.exec(
                f"netstat -ano 2>nul | findstr :{port} | findstr LISTENING >nul && echo Y || echo N",
                timeout=10)
            out, _, _ = self.exec(
                f"netstat -ano 2>nul | findstr :{port} | findstr LISTENING", timeout=10)
            return bool(out.strip())
        out, _, _ = self.exec(f"lsof -ti:{port} 2>/dev/null", timeout=10)
        return bool(out.strip())

    def close(self):
        if self._sftp is not None:
            try:
                self._sftp.close()
            except Exception:
                pass
        try:
            self.client.close()
        except Exception:
            pass


# ──────────────────────────────────────────────────────────────────────
# LocalExecutor —— 本机执行（subprocess + shutil）
# ──────────────────────────────────────────────────────────────────────
class LocalExecutor(Executor):
    is_local = True

    def __init__(self):
        self._os = 'windows' if os.name == 'nt' else 'linux'

    def exec(self, cmd, timeout=120):
        """本机执行（shell=True：Windows 走 cmd.exe，posix 走 /bin/sh）。"""
        try:
            r = subprocess.run(
                cmd, shell=True, capture_output=True,
                timeout=timeout, encoding='utf-8', errors='replace',
            )
        except subprocess.TimeoutExpired:
            raise TimeoutError(f"命令超时({timeout}s): {str(cmd)[:80]}")
        out = (r.stdout or '').strip()
        err = (r.stderr or '').strip()
        return out, err, r.returncode

    def detect_os(self):
        return self._os

    def resolve_dir(self, mode='agent'):
        # 本地只做完整部署；目录为用户选的父目录 + gamyy-core 子目录
        import config
        parent = config.LOCAL_DEPLOY_DIR
        if os.path.basename(os.path.normpath(parent)) == 'gamyy-core':
            return parent  # 兼容旧配置
        return os.path.join(parent, 'gamyy-core')

    def mkdirs(self, remote_path):
        os.makedirs(remote_path, exist_ok=True)

    def put_file(self, local_path, remote_path):
        os.makedirs(os.path.dirname(remote_path), exist_ok=True)
        shutil.copy2(local_path, remote_path)

    # —— 本地完整部署：安全清理 + 备份 + 整树拷贝（带排除规则）——
    def deploy_local_full(self, source_root, target_dir, skip_fn, log=None):
        """
        把 source_root 整树部署到 target_dir：
        1) 安全校验 target_dir（禁盘符根 / 禁 app 根）
        2) 若已存在：备份 data/*.db 到 target 外部，再按哨兵安全删除
        3) shutil.copytree（按 skip_fn 排除）
        4) 写入哨兵文件
        skip_fn(rel_path, is_dir) -> bool，rel_path 相对 source_root。
        """
        def _log(msg, level='INFO'):
            if log:
                log(msg, level)

        target_dir = os.path.normpath(os.path.abspath(target_dir))

        # 1) 硬安全校验
        self._assert_safe_target(target_dir)

        # 2) 清理旧部署
        if os.path.exists(target_dir):
            self._backup_dbs(target_dir, _log)
            self._safe_rmtree(target_dir, _log)

        # 3) 整树拷贝
        os.makedirs(os.path.dirname(target_dir), exist_ok=True)
        _log(f"复制部署源 → {target_dir}", 'INFO')
        shutil.copytree(source_root, target_dir, ignore=self._make_ignore(source_root, skip_fn))

        # 4) 写哨兵
        try:
            with open(os.path.join(target_dir, LOCAL_SENTINEL), 'w', encoding='utf-8') as f:
                f.write('gamyy local deploy marker\n')
        except Exception:
            pass
        os.makedirs(os.path.join(target_dir, 'data'), exist_ok=True)

    @staticmethod
    def _assert_safe_target(target_dir):
        """禁止把部署目录定位到危险路径，从根上杜绝整盘误删。"""
        norm = os.path.normpath(target_dir)
        # 盘符根（如 E:\、C:\）或文件系统根 /
        drive, tail = os.path.splitdrive(norm)
        if tail in ('', os.sep, '/', '\\'):
            raise RuntimeError(f"拒绝部署到盘符/文件系统根：{norm}")
        if os.path.abspath(norm) == os.path.abspath(_app_root()):
            raise RuntimeError(f"拒绝部署到程序根目录：{norm}")
        # 必须至少两层深，避免 C:\opt 这类太浅的目录被整删
        depth = len([p for p in norm.replace('\\', '/').split('/') if p and ':' not in p])
        if depth < 1:
            raise RuntimeError(f"部署目录层级过浅，拒绝：{norm}")

    @staticmethod
    def _safe_rmtree(target_dir, _log):
        """只有目标含哨兵文件才允许整删；否则拒绝（可能不是本程序创建的目录）。"""
        if not os.listdir(target_dir):
            return  # 空目录，直接复用
        sentinel = os.path.join(target_dir, LOCAL_SENTINEL)
        if not os.path.isfile(sentinel):
            raise RuntimeError(
                f"拒绝删除目标目录（缺少 {LOCAL_SENTINEL} 哨兵，可能不是本程序创建的目录）：{target_dir}\n"
                f"如确认要覆盖，请手动清空该目录后重试。"
            )
        _log(f"清理旧部署：{target_dir}", 'INFO')
        _rmtree_force(target_dir)

    @staticmethod
    def _backup_dbs(target_dir, _log):
        """把 target/data/*.db 备份到 target 外部的兄弟目录 backups/<ts>/。"""
        data_dir = os.path.join(target_dir, 'data')
        present = [db for db in _LOCAL_BACKUP_DBS if os.path.isfile(os.path.join(data_dir, db))]
        if not present:
            return
        ts = time.strftime('%Y%m%d_%H%M%S')
        # 备份根 = LOCAL_DEPLOY_DIR 的父目录/backups（在 target 之外）
        backup_root = os.path.join(os.path.dirname(target_dir), 'backups', ts)
        os.makedirs(backup_root, exist_ok=True)
        for db in present:
            try:
                shutil.copy2(os.path.join(data_dir, db), os.path.join(backup_root, db))
                _log(f"已备份 {db} → {backup_root}", 'INFO')
            except Exception as e:
                _log(f"备份 {db} 失败（忽略）: {e}", 'WARNING')

    @staticmethod
    def _make_ignore(source_root, skip_fn):
        """把 skip_fn(rel_path, is_dir) 适配成 shutil.copytree 的 ignore 回调。"""
        def _ignore(dir_path, names):
            skipped = set()
            for name in names:
                full = os.path.join(dir_path, name)
                rel = os.path.relpath(full, source_root)
                is_dir = os.path.isdir(full)
                try:
                    if skip_fn(rel, is_dir):
                        skipped.add(name)
                except Exception:
                    pass
            return skipped
        return _ignore

    # —— 进程级起停 ——
    @staticmethod
    def _node_exe():
        """返回 node 可执行文件路径。Windows 上用 MSI 默认安装路径（刚装完当前进程 PATH
        可能未刷新），避免 'node' not found；不存在时回退到 PATH 中的 'node'。"""
        if os.name == 'nt':
            msi = os.path.join(os.environ.get('ProgramFiles', 'C:\\Program Files'),
                               'nodejs', 'node.exe')
            if os.path.isfile(msi):
                return msi
        return 'node'

    def start_node(self, work_dir, entry_script, log_path):
        """后台启动 node <entry_script>（脱离当前进程），返回 pid。"""
        os.makedirs(os.path.dirname(log_path) or work_dir, exist_ok=True)
        logf = open(log_path, 'w')
        kwargs = {}
        if os.name == 'nt':
            # CREATE_NO_WINDOW | DETACHED_PROCESS：不弹窗、脱离父进程
            kwargs['creationflags'] = 0x08000000 | 0x00000008
        else:
            kwargs['start_new_session'] = True
        # 用列表形式，正确传 web/server.js（修掉历史 ['node','web','server.js'] 的 bug）
        proc = subprocess.Popen(
            [self._node_exe(), entry_script.replace('/', os.sep)],
            cwd=work_dir, stdout=logf, stderr=subprocess.STDOUT, **kwargs,
        )
        return proc.pid

    def stop_port(self, port):
        if self._os == 'windows':
            self.exec(
                f"for /f \"tokens=5\" %p in ('netstat -ano 2^>nul ^| findstr :{port} ^| findstr LISTENING') do "
                f"@taskkill /f /pid %p >nul 2>&1",
                timeout=15)
        else:
            self.exec(f"kill $(lsof -ti:{port}) 2>/dev/null || true", timeout=15)

    def is_listening(self, port):
        if self._os == 'windows':
            out, _, _ = self.exec(
                f"netstat -ano 2>nul | findstr :{port} | findstr LISTENING", timeout=10)
            return bool(out.strip())
        out, _, _ = self.exec(f"lsof -ti:{port} 2>/dev/null", timeout=10)
        return bool(out.strip())

    def read_log_tail(self, lines=100):
        """读取本地 server.log 末尾若干行。"""
        log_path = os.path.join(LOCAL_DEPLOY_DIR, 'server.log')
        if not os.path.isfile(log_path):
            return '(无本地日志)'
        try:
            with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
                return ''.join(f.readlines()[-lines:]) or '(空)'
        except Exception as e:
            return f'读取本地日志失败: {e}'

    def close(self):
        pass
