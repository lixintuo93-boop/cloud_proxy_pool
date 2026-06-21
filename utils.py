# utils.py
"""
工具函数模块 - 不依赖外部库（如requests）
使用纯socket实现SOCKS5代理测试
"""
import re
import socket
import struct
import sys
import threading


def check_port(port, timeout=1):
    """
    检查端口是否在监听
    原理：尝试TCP连接到本地端口，如果连接成功说明端口在监听
    """
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex(('127.0.0.1', port))

        if result == 0:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except:
                pass

        return result == 0
    except Exception:
        return False
    finally:
        if sock:
            try:
                sock.close()
            except:
                pass


def can_bind_local_port(port, host='127.0.0.1'):
    """
    尝试 bind 一下本地端口，能 bind 即代表"对我们可用"。

    比 check_port (connect) 严格：能识别 Windows 系统保留段（5040 这种没人监听
    但也不能 bind 的端口），用于代理端口分配阶段判断"这个端口能不能给 SSH 隧道"。
    """
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # 不设 SO_REUSEADDR：要的就是"真能独占 bind"的语义
        sock.bind((host, port))
        return True
    except OSError:
        return False
    except Exception:
        return False
    finally:
        if sock:
            try:
                sock.close()
            except Exception:
                pass


# Windows 保留端口段缓存
_excluded_ranges_cache = None
_excluded_ranges_lock = threading.Lock()


def get_excluded_port_ranges(force_refresh=False):
    """
    获取 Windows 保留端口段列表（如 Hyper-V/HNS 保留区）。

    返回 list[(start, end)]，已按 start 排序；非 Windows 平台返回空列表。
    缓存到进程级，force_refresh=True 时重新查询（建议每次批量加代理时刷新一次）。
    """
    global _excluded_ranges_cache
    with _excluded_ranges_lock:
        if not force_refresh and _excluded_ranges_cache is not None:
            return _excluded_ranges_cache

        ranges = []
        if sys.platform.startswith('win'):
            try:
                import subprocess
                result = subprocess.run(
                    ['netsh', 'interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
                    capture_output=True, text=True, encoding='gbk', errors='ignore', timeout=5
                )
                # 输出形如：  起始端口  结束端口
                #            ----------    --------
                #               5040        5139
                for line in (result.stdout or '').splitlines():
                    m = re.search(r'^\s*(\d+)\s+(\d+)\s*$', line)
                    if m:
                        s, e = int(m.group(1)), int(m.group(2))
                        if 0 < s <= e <= 65535:
                            ranges.append((s, e))
                ranges.sort(key=lambda x: x[0])
            except Exception:
                ranges = []

        _excluded_ranges_cache = ranges
        return ranges


def is_in_excluded_ranges(port, ranges):
    """端口是否落在某个保留段内（O(K) 线性扫即可，K 通常 <10）"""
    for s, e in ranges:
        if s <= port <= e:
            return True
    return False


def check_server_connectivity(host, port=22, timeout=2):
    """
    检查服务器是否可达
    原理：尝试TCP连接到服务器的SSH端口
    """
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((host, port))
        sock.close()
        return result == 0
    except:
        return False


def test_proxy(port, test_url=None, timeout=None, verbose=True):
    """
    测试SOCKS5代理是否正常工作
    原理：
    1. 连接到本地SOCKS5代理端口
    2. 发送SOCKS5握手请求
    3. 发送SOCKS5 CONNECT请求连接到目标网站
    4. 发送HTTP GET请求
    5. 检查是否收到HTTP响应
    
    不依赖requests库，纯socket实现
    verbose: 是否打印详细日志
    """
    from config import PROXY_TEST_URL, PROXY_TEST_TIMEOUT, PROXY_TEST_URLS_BACKUP
    
    # 日志函数
    def log_detail(msg):
        if verbose:
            try:
                from logger import info
                info(f"    [详情] {msg}")
            except:
                print(f"    [详情] {msg}")
    
    if test_url is None:
        test_url = PROXY_TEST_URL
    if timeout is None:
        timeout = PROXY_TEST_TIMEOUT
    
    # 解析URL
    if test_url.startswith('http://'):
        host = test_url[7:].split('/')[0]
        target_port = 80
    elif test_url.startswith('https://'):
        host = test_url[8:].split('/')[0]
        target_port = 443
    else:
        host = test_url.split('/')[0]
        target_port = 80
    
    # 尝试主URL和备用URL
    urls_to_try = [(host, target_port, test_url)]
    for backup_url in PROXY_TEST_URLS_BACKUP:
        if backup_url.startswith('http://'):
            backup_host = backup_url[7:].split('/')[0]
            urls_to_try.append((backup_host, 80, backup_url))
        elif backup_url.startswith('https://'):
            backup_host = backup_url[8:].split('/')[0]
            urls_to_try.append((backup_host, 443, backup_url))
    
    last_error = "未知错误"
    
    for target_host, target_port, url in urls_to_try:
        sock = None
        try:
            log_detail(f"连接代理 127.0.0.1:{port}")
            
            # 1. 连接到本地SOCKS5代理
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            sock.connect(('127.0.0.1', port))
            
            log_detail("发送SOCKS5握手: 05 01 00")
            
            # 2. SOCKS5握手 - 发送版本和认证方法
            # VER: 0x05 (SOCKS5)
            # NMETHODS: 0x01 (1个认证方法)
            # METHODS: 0x00 (无认证)
            sock.sendall(b'\x05\x01\x00')
            
            # 接收服务器响应
            response = sock.recv(2)
            log_detail(f"握手响应: {response.hex() if response else 'empty'}")
            
            if len(response) < 2:
                last_error = "SOCKS5握手失败：响应过短"
                continue
            if response[0] != 0x05:
                last_error = f"SOCKS5握手失败：版本错误 {response[0]}"
                continue
            if response[1] != 0x00:
                last_error = f"SOCKS5握手失败：认证方法不支持 {response[1]}"
                continue
            
            log_detail(f"握手成功，发送CONNECT请求到 {target_host}:{target_port}")
            
            # 3. SOCKS5 CONNECT请求
            # VER: 0x05
            # CMD: 0x01 (CONNECT)
            # RSV: 0x00
            # ATYP: 0x03 (域名)
            # DST.ADDR: 域名长度 + 域名
            # DST.PORT: 目标端口
            connect_request = b'\x05\x01\x00\x03'
            connect_request += bytes([len(target_host)])
            connect_request += target_host.encode('utf-8')
            connect_request += struct.pack('>H', target_port)
            
            sock.sendall(connect_request)
            
            # 接收CONNECT响应
            response = sock.recv(10)
            log_detail(f"CONNECT响应: {response.hex() if response else 'empty'}")
            
            if len(response) < 2:
                last_error = "SOCKS5 CONNECT失败：响应过短"
                continue
            if response[0] != 0x05:
                last_error = f"SOCKS5 CONNECT失败：版本错误"
                continue
            if response[1] != 0x00:
                error_codes = {
                    0x01: "一般性失败",
                    0x02: "规则不允许",
                    0x03: "网络不可达",
                    0x04: "主机不可达",
                    0x05: "连接被拒绝",
                    0x06: "TTL超时",
                    0x07: "命令不支持",
                    0x08: "地址类型不支持"
                }
                last_error = f"SOCKS5 CONNECT失败：{error_codes.get(response[1], f'错误码{response[1]}')}"
                continue
            
            # 读取剩余的响应（绑定地址）
            if len(response) >= 4:
                atyp = response[3]
                if atyp == 0x01:  # IPv4
                    remaining = 4 + 2 - (len(response) - 4)
                    if remaining > 0:
                        sock.recv(remaining)
                elif atyp == 0x03:  # 域名
                    domain_len = response[4] if len(response) > 4 else sock.recv(1)[0]
                    remaining = domain_len + 2 - (len(response) - 5)
                    if remaining > 0:
                        sock.recv(remaining)
                elif atyp == 0x04:  # IPv6
                    remaining = 16 + 2 - (len(response) - 4)
                    if remaining > 0:
                        sock.recv(remaining)
            
            log_detail("CONNECT成功，发送HTTP请求")
            
            # 4. 发送HTTP GET请求
            http_request = f"GET / HTTP/1.1\r\nHost: {target_host}\r\nConnection: close\r\n\r\n"
            log_detail(f"HTTP请求: GET / HTTP/1.1, Host: {target_host}")
            sock.sendall(http_request.encode('utf-8'))
            
            # 5. 接收HTTP响应
            response_data = b''
            try:
                while True:
                    chunk = sock.recv(1024)
                    if not chunk:
                        break
                    response_data += chunk
                    # 只需要读取头部就够了
                    if len(response_data) > 500:
                        break
            except socket.timeout:
                pass
            
            # 检查是否收到HTTP响应
            if response_data:
                response_text = response_data.decode('utf-8', errors='ignore')
                if 'HTTP/' in response_text:
                    # 提取状态码
                    lines = response_text.split('\r\n')
                    first_line = lines[0]
                    log_detail(f"HTTP响应: {first_line}")
                    
                    # 显示部分响应头
                    for line in lines[1:5]:
                        if line.strip():
                            log_detail(f"  {line[:60]}")
                    
                    if '200' in first_line or '301' in first_line or '302' in first_line:
                        return True, f"通过 {target_host} 测试成功"
                    else:
                        return True, f"连接成功 (状态: {first_line[:50]})"
            
            last_error = f"HTTP请求失败：未收到有效响应"
            log_detail(f"响应数据长度: {len(response_data)} bytes")
            
        except socket.timeout:
            last_error = f"连接超时 ({target_host})"
            log_detail(f"超时: {timeout}秒")
        except ConnectionRefusedError:
            last_error = "代理端口连接被拒绝"
            log_detail("端口未开放或代理未运行")
        except Exception as e:
            last_error = f"测试异常: {str(e)}"
            log_detail(f"异常: {e}")
        finally:
            if sock:
                try:
                    sock.close()
                except:
                    pass
    
    return False, last_error


def test_proxy_simple(port, timeout=5):
    """
    简单测试代理端口是否响应SOCKS5握手
    不进行实际的网络连接，只检查SOCKS5协议是否正常
    """
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(('127.0.0.1', port))
        
        # SOCKS5握手
        sock.sendall(b'\x05\x01\x00')
        response = sock.recv(2)
        
        if len(response) >= 2 and response[0] == 0x05 and response[1] == 0x00:
            return True, "SOCKS5握手成功"
        else:
            return False, f"SOCKS5握手失败：响应 {response.hex()}"
            
    except socket.timeout:
        return False, "连接超时"
    except ConnectionRefusedError:
        return False, "连接被拒绝"
    except Exception as e:
        return False, f"测试错误: {str(e)}"
    finally:
        if sock:
            try:
                sock.close()
            except:
                pass


def run_command_with_timeout(cmd, timeout=10):
    """运行命令并设置超时"""
    import subprocess
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='ignore',
            timeout=timeout
        )
        return result
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


def is_within_time_range(start_time, end_time, current_time=None):
    """
    判断当前时间是否在指定时间范围内
    使用北京时间
    """
    from config import get_beijing_time_short
    
    if current_time is None:
        current_time = get_beijing_time_short()

    # 处理跨天的情况
    if start_time > end_time:
        return current_time >= start_time or current_time < end_time
    else:
        return start_time <= current_time < end_time
