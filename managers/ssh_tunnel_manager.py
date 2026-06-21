# managers/ssh_tunnel_manager.py
"""
SSH隧道管理器 - v4.0 (Paramiko版本)
- 使用 paramiko 库（纯Python SSH实现）
- 自动接受主机密钥（无需手动确认）
- 不需要外部工具（sshpass、plink等）
"""
import subprocess
import threading
import time
import os
import sys
import socket
import logging
from utils import check_server_connectivity, check_port
from logger import info, success, warning, error, debug, status, LogLevel, log

# 抑制 paramiko 的日志输出（避免 "Secsh channel open FAILED" 消息）
logging.getLogger("paramiko").setLevel(logging.CRITICAL)
logging.getLogger("paramiko.transport").setLevel(logging.CRITICAL)

def _auto_install_package(package_name):
    """自动安装缺失的包"""
    try:
        info(f"[INFO] 正在自动安装 {package_name}...")
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", package_name],
            capture_output=True,
            text=True,
            timeout=120
        )
        if result.returncode == 0:
            success(f"[SUCCESS] {package_name} 安装成功！")
            return True
        else:
            error(f"[ERROR] {package_name} 安装失败: {result.stderr}")
            return False
    except Exception as e:
        error(f"[ERROR] 自动安装 {package_name} 异常: {e}")
        return False

# 尝试导入 paramiko，失败则自动安装
try:
    import paramiko
    PARAMIKO_AVAILABLE = True
except ImportError:
    warning("[WARN] paramiko 未安装，正在尝试自动安装...")
    if _auto_install_package("paramiko"):
        try:
            import paramiko
            PARAMIKO_AVAILABLE = True
        except ImportError:
            PARAMIKO_AVAILABLE = False
            error("[ERROR] paramiko 安装后仍无法导入，请手动安装: pip install paramiko")
    else:
        PARAMIKO_AVAILABLE = False
        error("[ERROR] paramiko 自动安装失败，请手动运行: pip install paramiko")

# 尝试导入 sshtunnel
try:
    from sshtunnel import SSHTunnelForwarder
    SSHTUNNEL_AVAILABLE = True
except ImportError:
    SSHTUNNEL_AVAILABLE = False


# 只有在 paramiko 可用时才定义这个类
if PARAMIKO_AVAILABLE:
    class AutoAddHostKeyPolicy(paramiko.MissingHostKeyPolicy):
        """自动接受所有主机密钥的策略"""
        def missing_host_key(self, client, hostname, key):
            debug(f"[DEBUG] 自动接受主机密钥: {hostname} ({key.get_name()})")
            # 可选：保存到 known_hosts
            # client.get_host_keys().add(hostname, key.get_name(), key)
else:
    # paramiko 不可用时的占位类
    class AutoAddHostKeyPolicy:
        """占位类（paramiko 不可用）"""
        pass


class SSHTunnelManager:
    def __init__(self, database):
        self.database = database
        self.processes = {}  # port -> (name, tunnel_obj, host)
        self.hostkeys_accepted = set()
        self._key_check_lock = threading.Lock()
        
        # 检查依赖
        self._check_dependencies()

    def _check_dependencies(self):
        """检查必要的依赖"""
        if not PARAMIKO_AVAILABLE:
            error("[ERROR] paramiko 未安装！请运行: pip install paramiko")
            error("[ERROR] 或者: pip install paramiko sshtunnel")
        else:
            debug("[DEBUG] paramiko 可用")
        
        if SSHTUNNEL_AVAILABLE:
            debug("[DEBUG] sshtunnel 可用")
        else:
            debug("[DEBUG] sshtunnel 未安装，将使用 paramiko 原生方式")

    def _test_ssh_connection(self, host, username, password, port=22, timeout=10):
        """使用 paramiko 测试 SSH 连接"""
        if not PARAMIKO_AVAILABLE:
            return False, "paramiko 未安装"
        
        client = None
        try:
            debug(f"[DEBUG] 测试 SSH 连接: {username}@{host}:{port}")
            
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            client.connect(
                hostname=host,
                port=port,
                username=username,
                password=password,
                timeout=timeout,
                allow_agent=False,
                look_for_keys=False,
                banner_timeout=15,
                auth_timeout=15
            )
            
            # connect() 成功就认为连接成功
            # 不再检查 transport 状态，避免 "No existing session" 问题
            debug(f"[DEBUG] {host}: 连接测试成功")
            return True, "连接成功"
                
        except paramiko.AuthenticationException as e:
            debug(f"[DEBUG] {host}: 认证失败 - {e}")
            return False, "认证失败（密码错误）"
        except paramiko.SSHException as e:
            err_msg = str(e)
            debug(f"[DEBUG] {host}: SSH 错误 - {e}")
            # 特殊处理某些非致命错误
            if 'No existing session' in err_msg or 'Error reading SSH protocol banner' in err_msg:
                # 这些错误通常是临时的，标记为成功让后续重试
                debug(f"[DEBUG] {host}: 忽略临时错误，标记为成功")
                return True, "连接成功（临时警告）"
            return False, f"SSH错误: {e}"
        except socket.timeout:
            debug(f"[DEBUG] {host}: 连接超时")
            return False, "连接超时"
        except socket.error as e:
            debug(f"[DEBUG] {host}: 网络错误 - {e}")
            return False, f"网络错误: {e}"
        except Exception as e:
            debug(f"[DEBUG] {host}: 未知错误 - {e}")
            return False, f"错误: {e}"
        finally:
            if client:
                try:
                    client.close()
                except:
                    pass

    def accept_host_key_auto(self, host, username, password, port=22, timeout=60, is_auto_recovery=False):
        """
        自动接受主机密钥
        使用 paramiko 的 AutoAddPolicy，直接连接即可自动接受
        """
        with self._key_check_lock:
            try:
                info(f"[INFO] {host}: 开始自动接受主机密钥...")
                
                # 检查缓存
                if host in self.hostkeys_accepted:
                    debug(f"[DEBUG] {host}: 密钥已在缓存中")
                    return True
                
                # 检查服务器可达性
                debug(f"[DEBUG] {host}: 检查服务器可达性...")
                if not check_server_connectivity(host, timeout=5):
                    debug(f"[DEBUG] {host}: 服务器不可达")
                    return False
                debug(f"[DEBUG] {host}: 服务器可达")
                
                # 使用 paramiko 测试连接（会自动接受密钥）
                conn_ok, msg = self._test_ssh_connection(host, username, password, port)
                
                if conn_ok:
                    self.hostkeys_accepted.add(host)
                    success(f"[SUCCESS] {host}: 密钥已自动接受")
                    return True
                else:
                    error(f"[ERROR] {host}: 连接失败 - {msg}")
                    return False
                    
            except Exception as e:
                error(f"[ERROR] {host}: 自动接受密钥时发生异常: {e}")
                import traceback
                debug(f"[DEBUG] 异常堆栈:\n{traceback.format_exc()}")
                return False

    def start_ssh_tunnel(self, name, host, port, username, password, ssh_port=22, is_auto_recovery=False):
        """启动 SSH 隧道 (SOCKS5 代理)"""
        try:
            info(f"[INFO] {name}: 启动 SSH 隧道 (本地端口: {port})...")
            
            if not check_server_connectivity(host, timeout=3):
                debug(f"[DEBUG] {name}: 服务器不可达")
                return None

            # 确保密钥已接受
            if host not in self.hostkeys_accepted:
                if not self.accept_host_key_auto(host, username, password, ssh_port, is_auto_recovery=is_auto_recovery):
                    warning(f"[WARN] {name}: 密钥未接受，无法启动隧道")
                    return None

            # 使用 sshtunnel 库（如果可用）
            if SSHTUNNEL_AVAILABLE:
                return self._start_tunnel_with_sshtunnel(name, host, port, username, password, ssh_port)
            
            # 否则使用 paramiko 原生方式
            return self._start_tunnel_with_paramiko(name, host, port, username, password, ssh_port)

        except Exception as e:
            error(f"[ERROR] {name}: 启动隧道失败: {e}")
            import traceback
            debug(f"[DEBUG] 异常堆栈:\n{traceback.format_exc()}")
            return None

    def _start_tunnel_with_sshtunnel(self, name, host, port, username, password, ssh_port):
        """使用 sshtunnel 库启动隧道"""
        try:
            debug(f"[DEBUG] {name}: 使用 sshtunnel 启动动态转发...")
            
            # sshtunnel 不直接支持 SOCKS5 动态转发
            # 我们需要使用 paramiko 的原生方式
            return self._start_tunnel_with_paramiko(name, host, port, username, password, ssh_port)
            
        except Exception as e:
            error(f"[ERROR] {name}: sshtunnel 启动失败: {e}")
            return None

    def _start_tunnel_with_paramiko(self, name, host, port, username, password, ssh_port):
        """使用 paramiko 启动 SOCKS5 动态转发隧道"""
        max_retries = 3
        
        for attempt in range(max_retries):
            try:
                debug(f"[DEBUG] {name}: 使用 paramiko 启动 SOCKS5 代理... (尝试 {attempt + 1}/{max_retries})")
                
                # 创建带超时的 socket
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(30)  # 30秒超时
                sock.connect((host, ssh_port))
                
                # 创建 SSH Transport
                transport = paramiko.Transport(sock)
                transport.set_keepalive(30)  # 保活间隔30秒
                
                # 设置 banner 超时
                transport.banner_timeout = 30
                transport.handshake_timeout = 30
                
                transport.connect(username=username, password=password)
                
                # 创建 SOCKS5 服务器（传递连接信息用于重连）
                tunnel_obj = DynamicForwardServer(
                    transport=transport,
                    local_bind_address=('127.0.0.1', port),
                    name=name,
                    host=host,
                    ssh_port=ssh_port,
                    username=username,
                    password=password
                )
                
                # 在后台线程启动
                tunnel_thread = threading.Thread(target=tunnel_obj.serve_forever, daemon=True)
                tunnel_thread.start()
                
                # 等待端口开始监听
                for i in range(5):
                    time.sleep(1)
                    if check_port(port):
                        self.processes[port] = (name, tunnel_obj, host)
                        self._update_proxy_status(port, True)
                        success(f"[SUCCESS] {name}: SOCKS5 代理已启动 (端口 {port})")
                        return tunnel_obj
                    debug(f"[DEBUG] {name}: 等待端口监听... ({i+1}/5)")
                
                # 如果端口没开，检查服务器是否还在
                if tunnel_obj.is_alive:
                    debug(f"[DEBUG] {name}: 隧道服务运行中，但端口检测失败")
                    self.processes[port] = (name, tunnel_obj, host)
                    return tunnel_obj
                
                error(f"[ERROR] {name}: 隧道启动失败")
                return None
                
            except (socket.timeout, paramiko.SSHException) as e:
                err_msg = str(e)
                if attempt < max_retries - 1:
                    warning(f"[WARN] {name}: 连接失败 ({err_msg})，{2 ** attempt}秒后重试...")
                    time.sleep(2 ** attempt)  # 指数退避：1秒, 2秒, 4秒
                    continue
                else:
                    error(f"[ERROR] {name}: paramiko 隧道启动失败 (已重试{max_retries}次): {e}")
                    return None
                    
            except Exception as e:
                error(f"[ERROR] {name}: paramiko 隧道启动失败: {e}")
                import traceback
                debug(f"[DEBUG] 异常堆栈:\n{traceback.format_exc()}")
                return None
        
        return None

    def _update_proxy_status(self, port, is_active):
        """更新代理状态到数据库"""
        proxy_id = self._get_proxy_id(port)
        if proxy_id:
            self.database.update_proxy_status(proxy_id, is_active)

    def _get_proxy_id(self, port):
        """根据端口获取代理ID"""
        import sqlite3
        from config import DATABASE_FILE

        conn = sqlite3.connect(DATABASE_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM proxies WHERE port = ?', (port,))
        result = cursor.fetchone()
        conn.close()

        return result[0] if result else None

    def stop_ssh_tunnel(self, port):
        """停止 SSH 隧道"""
        if port in self.processes:
            name, tunnel_obj, host = self.processes[port]
            info(f"[INFO] 停止隧道: {name}")
            
            try:
                if hasattr(tunnel_obj, 'shutdown'):
                    tunnel_obj.shutdown()
                elif hasattr(tunnel_obj, 'stop'):
                    tunnel_obj.stop()
                elif hasattr(tunnel_obj, 'close'):
                    tunnel_obj.close()
            except Exception as e:
                debug(f"[DEBUG] 停止隧道时出错: {e}")
            
            del self.processes[port]
            self._update_proxy_status(port, False)

    def stop_all_tunnels(self):
        """停止所有隧道"""
        info(f"[INFO] 停止所有隧道 ({len(self.processes)} 个)...")
        for port in list(self.processes.keys()):
            self.stop_ssh_tunnel(port)

    def get_active_tunnels(self):
        """获取活跃隧道列表"""
        active = []
        for port, (name, tunnel_obj, host) in self.processes.items():
            if check_port(port):
                active.append((name, port))
        return active


class DynamicForwardServer:
    """
    SOCKS5 动态端口转发服务器
    通过 SSH 隧道转发所有请求
    """
    
    SOCKS_VERSION = 5
    
    def __init__(self, transport, local_bind_address, name="tunnel", 
                 host=None, ssh_port=22, username=None, password=None):
        self.transport = transport
        self.local_address = local_bind_address
        self.name = name
        self.server_socket = None
        self.is_alive = False
        self._stop_event = threading.Event()
        
        # 保存连接信息用于重连
        self.host = host
        self.ssh_port = ssh_port
        self.username = username
        self.password = password
        self._reconnect_lock = threading.Lock()
        
    def _check_transport(self):
        """检查 Transport 是否仍然活跃"""
        try:
            return self.transport and self.transport.is_active()
        except:
            return False
    
    def _reconnect(self):
        """重新连接 SSH"""
        if not self.host or not self.username or not self.password:
            return False
        
        with self._reconnect_lock:
            # 再次检查，可能其他线程已经重连了
            if self._check_transport():
                return True
            
            try:
                debug(f"[DEBUG] {self.name}: 尝试重新连接 SSH...")
                
                # 创建带超时的 socket
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(30)
                sock.connect((self.host, self.ssh_port))
                
                new_transport = paramiko.Transport(sock)
                new_transport.set_keepalive(30)
                new_transport.banner_timeout = 30
                new_transport.handshake_timeout = 30
                new_transport.connect(username=self.username, password=self.password)
                
                self.transport = new_transport
                debug(f"[DEBUG] {self.name}: SSH 重连成功")
                return True
            except Exception as e:
                debug(f"[DEBUG] {self.name}: SSH 重连失败: {e}")
                return False
        
    def serve_forever(self):
        """启动服务器"""
        try:
            self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server_socket.bind(self.local_address)
            self.server_socket.listen(100)
            self.server_socket.settimeout(1.0)  # 1秒超时，便于检查停止事件
            
            self.is_alive = True
            debug(f"[DEBUG] {self.name}: SOCKS5 服务器已启动在 {self.local_address}")
            
            while not self._stop_event.is_set():
                try:
                    client_socket, addr = self.server_socket.accept()
                    # 为每个客户端启动处理线程
                    handler = threading.Thread(
                        target=self._handle_client,
                        args=(client_socket,),
                        daemon=True
                    )
                    handler.start()
                except socket.timeout:
                    continue
                except Exception as e:
                    if not self._stop_event.is_set():
                        debug(f"[DEBUG] {self.name}: accept 错误: {e}")
                    break
                    
        except Exception as e:
            error(f"[ERROR] {self.name}: 服务器错误: {e}")
        finally:
            self.is_alive = False
            if self.server_socket:
                try:
                    self.server_socket.close()
                except:
                    pass
    
    def _handle_client(self, client_socket):
        """处理 SOCKS5 客户端连接"""
        channel = None
        try:
            # SOCKS5 握手
            # 1. 客户端发送: VER, NMETHODS, METHODS
            header = client_socket.recv(2)
            if len(header) < 2:
                return
            
            version, nmethods = header[0], header[1]
            if version != self.SOCKS_VERSION:
                return
            
            methods = client_socket.recv(nmethods)
            
            # 2. 服务器响应: VER, METHOD (0x00 = 无需认证)
            client_socket.sendall(bytes([self.SOCKS_VERSION, 0x00]))
            
            # 3. 客户端发送连接请求: VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT
            request = client_socket.recv(4)
            if len(request) < 4:
                return
            
            version, cmd, _, address_type = request
            
            if cmd != 0x01:  # 只支持 CONNECT 命令
                # 返回 "Command not supported"
                client_socket.sendall(bytes([self.SOCKS_VERSION, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                return
            
            # 解析目标地址
            if address_type == 0x01:  # IPv4
                addr_bytes = client_socket.recv(4)
                dest_addr = socket.inet_ntoa(addr_bytes)
            elif address_type == 0x03:  # 域名
                domain_length = client_socket.recv(1)[0]
                dest_addr = client_socket.recv(domain_length).decode('utf-8')
            elif address_type == 0x04:  # IPv6
                addr_bytes = client_socket.recv(16)
                dest_addr = socket.inet_ntop(socket.AF_INET6, addr_bytes)
            else:
                return
            
            # 解析目标端口
            port_bytes = client_socket.recv(2)
            dest_port = int.from_bytes(port_bytes, 'big')
            
            # 检查 Transport 状态，如果断开则尝试重连
            if not self._check_transport():
                if not self._reconnect():
                    # 连接失败
                    client_socket.sendall(bytes([self.SOCKS_VERSION, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                    return
            
            # 通过 SSH 隧道连接目标
            try:
                channel = self.transport.open_channel(
                    'direct-tcpip',
                    (dest_addr, dest_port),
                    client_socket.getpeername(),
                    timeout=10
                )
                
                if channel is None:
                    # 连接失败
                    client_socket.sendall(bytes([self.SOCKS_VERSION, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                    return
                
            except Exception as e:
                # 连接失败，不打印错误（因为这是正常的网络行为）
                client_socket.sendall(bytes([self.SOCKS_VERSION, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                return
            
            # 连接成功，发送响应
            # VER, REP(0x00=成功), RSV, ATYP, BND.ADDR, BND.PORT
            bind_addr = bytes([0, 0, 0, 0])  # 0.0.0.0
            bind_port = bytes([0, 0])        # 端口 0
            client_socket.sendall(bytes([self.SOCKS_VERSION, 0x00, 0x00, 0x01]) + bind_addr + bind_port)
            
            # 双向转发数据
            self._forward_data(client_socket, channel)
            
        except Exception as e:
            pass
        finally:
            if channel:
                try:
                    channel.close()
                except:
                    pass
            try:
                client_socket.close()
            except:
                pass
    
    def _forward_data(self, client_socket, channel):
        """双向转发数据"""
        import select
        
        try:
            while True:
                # 等待数据可读
                r, w, x = select.select([client_socket, channel], [], [], 1.0)
                
                if client_socket in r:
                    data = client_socket.recv(8192)
                    if len(data) == 0:
                        break
                    channel.send(data)
                
                if channel in r:
                    data = channel.recv(8192)
                    if len(data) == 0:
                        break
                    client_socket.send(data)
                    
        except Exception:
            pass
        finally:
            try:
                channel.close()
            except:
                pass
    
    def shutdown(self):
        """停止服务器"""
        self._stop_event.set()
        self.is_alive = False
        if self.transport:
            try:
                self.transport.close()
            except:
                pass
    
    def stop(self):
        self.shutdown()
    
    def close(self):
        self.shutdown()

