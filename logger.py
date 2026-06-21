# logger.py
"""
统一日志管理模块
- 使用北京时间
- 支持GUI日志回调
- 区分日志级别
"""
import datetime
import threading
from enum import Enum


class LogLevel(Enum):
    DEBUG = 0    # 调试信息，一般不显示
    INFO = 1     # 普通信息
    SUCCESS = 2  # 成功信息
    WARNING = 3  # 警告信息
    ERROR = 4    # 错误信息
    CRITICAL = 5 # 关键信息，始终显示


# 全局日志级别
_current_level = LogLevel.INFO
_log_lock = threading.Lock()

# GUI日志回调函数
_gui_callback = None

# 日志前缀映射
_level_prefix = {
    LogLevel.DEBUG: "[DEBUG]",
    LogLevel.INFO: "[INFO]",
    LogLevel.SUCCESS: "[OK]",
    LogLevel.WARNING: "[WARN]",
    LogLevel.ERROR: "[ERROR]",
    LogLevel.CRITICAL: "[CRITICAL]",
}


def set_log_level(level: LogLevel):
    """设置全局日志级别"""
    global _current_level
    _current_level = level


def set_gui_callback(callback):
    """设置GUI日志回调函数"""
    global _gui_callback
    _gui_callback = callback


def get_timestamp():
    """获取当前时间戳（北京时间 UTC+8）"""
    utc_now = datetime.datetime.utcnow()
    beijing_time = utc_now + datetime.timedelta(hours=8)
    return beijing_time.strftime("%H:%M:%S")


def _safe_print(message: str):
    """安全打印（处理编码问题）"""
    try:
        print(message)
    except UnicodeEncodeError:
        print(message.encode('ascii', errors='replace').decode('ascii'))


def _format_message(level: LogLevel, message: str, include_prefix: bool = True) -> str:
    """格式化日志消息"""
    timestamp = get_timestamp()
    prefix = _level_prefix.get(level, "")
    if include_prefix and prefix:
        return f"[{timestamp}] {prefix} {message}"
    else:
        return f"[{timestamp}] {message}"


def log(level: LogLevel, message: str, include_prefix: bool = True):
    """通用日志函数"""
    if level.value >= _current_level.value:
        formatted_msg = _format_message(level, message, include_prefix)
        with _log_lock:
            _safe_print(formatted_msg)
            # 调用GUI回调
            if _gui_callback:
                try:
                    _gui_callback(formatted_msg, level)
                except:
                    pass


def debug(message: str):
    """调试日志"""
    log(LogLevel.DEBUG, message)


def info(message: str):
    """普通信息日志"""
    log(LogLevel.INFO, message)


def success(message: str):
    """成功信息日志"""
    log(LogLevel.SUCCESS, message)


def warning(message: str):
    """警告日志"""
    log(LogLevel.WARNING, message)


def error(message: str):
    """错误日志"""
    log(LogLevel.ERROR, message)


def critical(message: str):
    """关键信息日志"""
    log(LogLevel.CRITICAL, message)


def status(message: str):
    """状态日志（无前缀）"""
    formatted_msg = f"[{get_timestamp()}] {message}"
    with _log_lock:
        _safe_print(formatted_msg)
        if _gui_callback:
            try:
                _gui_callback(formatted_msg, LogLevel.INFO)
            except:
                pass


def raw(message: str):
    """原始输出（无时间戳）"""
    with _log_lock:
        _safe_print(message)
        if _gui_callback:
            try:
                _gui_callback(message, LogLevel.INFO)
            except:
                pass


def proxy_log(proxy_name: str, message: str, level: LogLevel = LogLevel.INFO):
    """代理相关日志"""
    log(level, f"[{proxy_name}] {message}")


def server_log(server_host: str, message: str, level: LogLevel = LogLevel.INFO):
    """服务器相关日志"""
    log(level, f"[{server_host}] {message}")
