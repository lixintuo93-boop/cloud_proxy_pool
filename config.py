# config.py
"""
SOCKS5 代理管理器配置文件 v3.3
"""
import datetime
import json
import os
import shutil
import sys
import winreg


def _app_root():
    """应用根目录：
    - 开发态（直接 python 跑）：config.py 所在目录
    - PyInstaller 打包后：EXE 真实所在目录（用 sys.executable，避免 __file__ 在 onefile 模式下指向临时解压目录）
    """
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _resource_root():
    """PyInstaller --add-data 打进 EXE 的资源根目录。
    - 开发态：项目目录（= _app_root()）
    - PyInstaller 打包后：sys._MEIPASS（onefile 是临时解压目录；onedir 是 EXE 同目录的 _internal）
    """
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', _app_root())
    return _app_root()


# ==================== 用户偏好持久化 ====================
# GUI 系统配置 tab 可调项从这里读，缺文件/缺字段/类型非法时一律 fallback 到下方默认。
_SETTINGS_FILE = os.path.join(_app_root(), 'user_settings.json')


def _load_user_settings():
    try:
        with open(_SETTINGS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


_S = _load_user_settings()


def _coerce_int(key, default):
    v = _S.get(key, default)
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _coerce_str(key, default):
    v = _S.get(key, default)
    return v if isinstance(v, str) and v else default


# ==================== 数据库配置 ====================
DATABASE_FILE = "proxy_manager.db"

# ==================== SSH默认配置 ====================
DEFAULT_SSH_PORT = 22

# ==================== 服务器列表 ====================
DEFAULT_SERVERS = [
    # ("服务器名称", "服务器IP", SSH端口, "用户名", "密码")
]

# ==================== 保活配置 ====================
KEEPALIVE_ENABLED = True
KEEPALIVE_INTERVAL = _coerce_int('keepalive_interval', 120)   # 保活间隔（秒）。GUI 可调，存 user_settings.json
KEEPALIVE_TIMEOUT = 5          # 保活连接超时（秒）：SOCKS5 探测 socket 的 connect+sendall+recv 整体超时

# ==================== 状态检查配置 ====================
# 代理状态检查滚动窗口（秒）- 每个代理每 STATUS_CHECK_INTERVAL 秒被检查一次
# 均匀分散到每1秒tick中，1000个代理时每秒约50个并发检查
STATUS_CHECK_INTERVAL = 20    # 默认20秒滚动窗口

# ==================== 代理测试配置 ====================
# 测试代理时访问的URL（用于验证代理是否正常工作）
# 下面两项 GUI 可调，存 user_settings.json
PROXY_TEST_URL = _coerce_str('proxy_test_url', "http://www.baidu.com")
PROXY_TEST_TIMEOUT = _coerce_int('proxy_test_timeout', 10)       # 测试超时（秒）

# 备用测试URL列表
PROXY_TEST_URLS_BACKUP = [
    "http://www.qq.com",
    "http://www.taobao.com",
    "http://www.163.com",
]

# ==================== 多线程并发配置 ====================
MAX_WORKERS = _coerce_int('max_workers', 100)              # 最大并发线程数。GUI 可调，存 user_settings.json

# ==================== 流量监控配置 ====================
TRAFFIC_MONITOR_ENABLED = True

# 要监控的目标IP列表
TRAFFIC_TARGET_IPS = [
    "183.242.86.29",
    "183.242.86.30",
    "123.114.40.188",
    "123.114.40.189",
]

# 默认网卡接口
TRAFFIC_INTERFACE = "eth0"

# 流量日志本地保存目录。GUI 可调，存 user_settings.json。
# 默认派生自 _app_root()：开发态=项目目录；打包后=EXE 同目录。
TRAFFIC_LOG_SAVE_DIR = _coerce_str('traffic_log_save_dir', os.path.join(_app_root(), 'traffic_logs'))

# 是否自动配置服务器的sudo免密码（仅root用户有效）
AUTO_CONFIGURE_SUDO = True

# ==================== 日志配置 ====================
LOG_LEVEL = "INFO"            # DEBUG, INFO, WARNING, ERROR
LOG_SHOW_TIMESTAMP = True

# ==================== 时区配置 ====================
# 使用北京时间 (UTC+8)
TIMEZONE_OFFSET = 8           # 相对于UTC的小时偏移

# ==================== Agent 部署配置 ====================
# gamyy-agent 源码所在目录（本地）
AGENT_SOURCE_DIR = r"E:\gamyy_base_info\gamyy-core-20260420-1"

# 云端部署目录
AGENT_REMOTE_DIR = "/opt/gamyy-agent"

# Agent 监听端口
AGENT_PORT = 7070

# PM2 进程名
AGENT_PM2_NAME = "gamyy-agent"

# 本地需要上传的目录列表
AGENT_UPLOAD_DIRS = ["agent", "services", "models", "crypto", "database", "utils"]

# 上传时 package-agent.json → 云端 package.json
AGENT_PACKAGE_FILE = "package-agent.json"

# 批量部署并发数（每台服务器独立跑 npm install，可以放开）。GUI 可调，存 user_settings.json
AGENT_DEPLOY_WORKERS = _coerce_int('agent_deploy_workers', 1000)

# 批量启动/停止/状态查询并发数
AGENT_OP_WORKERS = 30

# ──────────── 完整项目部署模式（"完整部署"按钮） ─────────────
# 该模式部署整个 gamyy-core，云端跑 web/server.js（监听 3000，浏览器访问管理）
# 一般只在 1~几台服务器上跑，跟"精简 Agent 模式"（上千台）是不同的服务器群
AGENT_FULL_REMOTE_DIR = "/opt/gamyy-core"     # 远端目录（区别于 AGENT_REMOTE_DIR）
AGENT_FULL_PM2_NAME   = "gamyy-web"           # PM2 进程名（区别于 AGENT_PM2_NAME）
AGENT_FULL_PORT       = 3000                   # web/server.js 默认端口

# ──────────── 本地部署目录（"本地部署" / 本机伪服务器） ─────────────
# 本地部署 = 完整部署（full 模式）跑在本机，不走 SSH。
# 目录【固定】不让用户在 GUI 里选盘符（历史上选 E:\ 导致整盘被删）；
# 高级用户可在 user_settings.json 写 "local_deploy_dir" 覆盖。
# 默认派生自 _app_root()：开发态=项目目录/local_deploy/gamyy-core；打包后=EXE 同目录下。
LOCAL_DEPLOY_DIR = _coerce_str('local_deploy_dir', os.path.dirname(_app_root()))
# 本机伪服务器在 ssh_servers 中的固定标识
LOCAL_SERVER_HOST = '127.0.0.1'

# GitHub 仓库 URL（「从 GitHub 拉取」默认地址，可在系统配置修改）
GITHUB_REPO_URL = _coerce_str('github_repo_url', 'https://github.com/lixintuo93-boop/gamyy-core')

# 部署源解析使用的目录名（resources/ 下的子目录）
RESOURCE_DIR_NAME = 'gamyy_core'

# 下载的远端日志数据库路径
AGENT_REMOTE_DB = "/opt/gamyy-agent/data/ticket_checker.db"

# 本地日志数据库保存目录。GUI 可调，存 user_settings.json。
# 默认派生自 _app_root()：开发态=项目目录；打包后=EXE 同目录。
AGENT_LOG_SAVE_DIR = _coerce_str('agent_log_save_dir', os.path.join(_app_root(), 'agent_logs'))

# ==================== TLS 指纹 sidecar 部署配置 ====================
# 开启后：部署 gamyy-core 时一并上传 fp-sidecar Linux 二进制、用 PM2 拉起，
# 并给 node 进程注入 FP_SIDECAR_ADDR，使 account/HttpClient 走 sidecar 施加真实 TLS 指纹。
# 默认关闭（不影响既有部署流程）。GUI/user_settings.json 可改 fp_sidecar_enabled / fp_sidecar_addr。
FP_SIDECAR_ENABLED = bool(_S.get('fp_sidecar_enabled', False))
FP_SIDECAR_ADDR = _coerce_str('fp_sidecar_addr', '127.0.0.1:8788')
FP_SIDECAR_PM2_NAME = 'fp-sidecar'
# 源根下的 Linux 版二进制相对路径（由 GOOS=linux GOARCH=amd64 go build 产出）
FP_SIDECAR_BINARY_REL = os.path.join('fp-sidecar', 'fp-sidecar')
# 回退：部署源副本（resources/gamyy_core 等）通常不含编译产物，从稳定构建目录取 Linux 二进制。
# GUI/user_settings 可用 fp_sidecar_binary 覆盖为绝对路径。
FP_SIDECAR_BINARY = _coerce_str('fp_sidecar_binary', os.path.join(AGENT_SOURCE_DIR, 'fp-sidecar', 'fp-sidecar'))
# 云端 sidecar 子目录（置于各自 remote_dir 之下）
FP_SIDECAR_REMOTE_SUBDIR = 'fp-sidecar'
# 部署后健康检查用的隧道探测目标（host:port）。默认 = 真实业务目标，顺带验证云端可达性。
FP_SIDECAR_PROBE_TARGET = _coerce_str('fp_sidecar_probe_target', 'hlwyl.gamyy.cn:443')

def get_beijing_time():
    """获取北京时间"""
    utc_now = datetime.datetime.utcnow()
    beijing_time = utc_now + datetime.timedelta(hours=TIMEZONE_OFFSET)
    return beijing_time

def get_beijing_time_str(fmt="%Y-%m-%d %H:%M:%S"):
    """获取北京时间字符串"""
    return get_beijing_time().strftime(fmt)

def get_beijing_time_short():
    """获取北京时间短格式 HH:MM:SS"""
    return get_beijing_time().strftime("%H:%M:%S")


def find_tshark():
    """定位 tshark 可执行文件。

    查找优先级：
    1. Windows 注册表 — Wireshark 安装目录（覆盖非默认路径安装）
    2. 系统 PATH（shutil.which）
    3. 默认安装路径兜底

    Returns:
        str: tshark.exe 完整路径，找不到返回 None。
    """
    # 1. 注册表：Wireshark 安装目录
    for reg_path in (r"SOFTWARE\Wireshark",
                     r"SOFTWARE\WOW6432Node\Wireshark"):
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, reg_path)
            install_dir, _ = winreg.QueryValueEx(key, "InstallDir")
            winreg.CloseKey(key)
            if install_dir:
                exe = os.path.join(install_dir, "tshark.exe")
                if os.path.exists(exe):
                    return exe
        except OSError:
            pass

    # 2. 系统 PATH
    exe = shutil.which("tshark")
    if exe:
        return exe

    # 3. 默认安装路径兜底
    for c in (r"C:\Program Files\Wireshark\tshark.exe",
              r"C:\Program Files (x86)\Wireshark\tshark.exe"):
        if os.path.exists(c):
            return c

    return None
