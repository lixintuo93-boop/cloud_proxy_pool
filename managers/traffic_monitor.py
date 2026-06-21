# managers/traffic_monitor.py
"""
服务器流量监控管理器 - v3.0 (pcap)
- 服务器本地记录模式：tcpdump 在服务器后台以二进制 pcap 抓包，文件保存在服务器本地
- 抓包用 -U -w xxx.pcap（包级原始数据，可直接 Wireshark/tshark 打开）；只过滤指定目标 IP，
  单文件、不切割（实测过滤后最大单文件 ~3.6MB，无需滚动）
- 下载走 paramiko SFTP 二进制传输（不能再用 cat/plink 文本管道，会损坏二进制）
- traffic_save 下载 pcap 到本机
"""
import threading
import time
import os
import random
import datetime
import paramiko
from concurrent.futures import ThreadPoolExecutor, as_completed
from config import TRAFFIC_LOG_SAVE_DIR
from logger import info, success, warning, error, status, debug, raw, LogLevel, log

# 同时进行 SSH 握手（DH 密钥交换 + 认证）的最大并发数。
# 握手是 CPU 密集型，限制并发握手数，防止上千 worker 同时握手把本机 CPU 打满；
# 握手完成后信号量立即释放，不影响后续命令执行/传输。
# 与 agent_deploy_manager._SSH_CONNECT_CONCURRENCY 保持一致（方案A：复刻一份，互不影响）。
_SSH_CONNECT_CONCURRENCY = 50

# 批量下载并发 worker 数。沿用 Agent 侧已验证过的下载档位 AGENT_OP_WORKERS=30，
# 不用 MAX_WORKERS(100)：30 是被验证「上千台又快又稳」的下载并发数。
_TRAFFIC_DOWNLOAD_WORKERS = 30


class TrafficMonitor:
    """流量监控管理器 - 服务器本地记录模式"""

    # SSH 建连重试参数（针对云厂商 SYN 限流 / 临时网络抖动 / 服务端 sshd 慢响应）
    # 复刻自 agent_deploy_manager（方案A）。AuthenticationException 不重试。
    _SSH_CONNECT_MAX_ATTEMPTS = 4              # 总尝试次数（含首次）
    _SSH_CONNECT_BACKOFFS = [3, 8, 15]         # 第 1..3 次重试前等待基数（秒）+ 0~50% 抖动

    def __init__(self, database):
        self.database = database
        self.monitoring_servers = set()  # 已启动监控的服务器
        self.log_dir = TRAFFIC_LOG_SAVE_DIR
        self.server_log_path = "/tmp"  # 服务器上的日志目录

        # SSH 握手限速信号量：限制同时握手的数量，防止高并发下载时握手扎堆打爆 CPU
        self._connect_sem = threading.Semaphore(_SSH_CONNECT_CONCURRENCY)

        # 创建本地日志目录
        if not os.path.exists(self.log_dir):
            os.makedirs(self.log_dir)

    def _connect(self, server_host, username, password, server_port=22, timeout=15):
        """
        建立 paramiko SSH 连接（复刻自 agent_deploy_manager._connect）。
        握手阶段用 _connect_sem 限速，防止高并发握手把本机 CPU 打满；握手完成后立即释放。

        失败重试策略：最多 4 次尝试，间隔 3/8/15s + 0~50% 抖动。
        - 认证失败（AuthenticationException）直接抛，不重试
        - 其他（socket.timeout / SSHException / 各种网络异常）计入重试
        - 每次尝试都重新进 semaphore，让出名额给其他 worker，不会卡占名额
        关键参数 allow_agent=False / look_for_keys=False：禁掉对本地 ~/.ssh 密钥与
        ssh-agent 的扫描，单台建连即可省掉几百 ms。
        """
        max_attempts = self._SSH_CONNECT_MAX_ATTEMPTS
        last_exc = None

        for attempt in range(1, max_attempts + 1):
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                with self._connect_sem:
                    client.connect(
                        hostname=server_host,
                        port=server_port,
                        username=username,
                        password=password,
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
                    warning(
                        f"[{server_host}] SSH connect failed "
                        f"({type(e).__name__}: {str(e)[:80]}), retry in {wait:.1f}s "
                        f"({attempt + 1}/{max_attempts})..."
                    )
                    time.sleep(wait)

        # 所有尝试用完，抛最后一次的异常
        if last_exc is not None:
            raise last_exc
        raise RuntimeError(f"[{server_host}] SSH connect failed: unknown reason")
    
    def _get_server_log_filename(self, server_host, target_ips):
        """生成服务器上的 pcap 文件名（固定名，方便覆盖重抓与下载）"""
        return f"traffic_{server_host.replace('.', '_')}.pcap"

    def _get_local_log_filename(self, server_host, target_ips):
        """生成本地 pcap 文件名（带时间戳）"""
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        ips_str = "_".join([ip.replace(".", "-") for ip in target_ips[:2]])
        return f"traffic_{server_host.replace('.', '-')}_{ips_str}_{timestamp}.pcap"
    
    def start_monitor_for_server(self, server_host, username, password, 
                                  target_ips, interface="eth0", 
                                  server_port=22):
        """
        为指定服务器启动流量监控（服务器本地记录模式）
        tcpdump在服务器后台运行，日志保存在服务器本地
        """
        import paramiko
        
        # 处理IP列表
        if isinstance(target_ips, str):
            target_ips = [ip.strip() for ip in target_ips.split(',') if ip.strip()]
        
        if not target_ips:
            error(f"No target IPs specified")
            return False
        
        # 构建tcpdump过滤条件
        host_filters = " or ".join([f"host {ip}" for ip in target_ips])
        filter_expr = f"({host_filters})"
        
        # 服务器上的 pcap 文件路径
        server_pcap_file = f"{self.server_log_path}/{self._get_server_log_filename(server_host, target_ips)}"

        # tcpdump 命令 - nohup 后台运行，二进制 pcap：
        #   -w  写原始包到 pcap（可 Wireshark/tshark 打开），默认 snaplen 262144 即抓全包
        #   -U  packet-buffered，每个包立即落盘，保证"边抓边下载"拿到的是完整有效 pcap
        #   单文件、不切割；重新启动会覆盖旧文件（每次启动=一个新抓包窗口）
        #   stderr 丢弃，避免 "listening on..." 之类文本混入
        tcpdump_cmd = (
            f"nohup sudo tcpdump -i {interface} '{filter_expr}' -U -w {server_pcap_file} "
            f"2>/dev/null &"
        )

        try:
            info(f"Starting traffic monitor on server: {server_host}")
            info(f"  Target IPs: {', '.join(target_ips)}")
            info(f"  Server pcap: {server_pcap_file}")
            
            # 使用paramiko执行命令
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(server_host, port=server_port, username=username, password=password, timeout=30)
            
            # 先停止已有的tcpdump进程
            client.exec_command("sudo pkill -f 'tcpdump.*traffic_' 2>/dev/null")
            time.sleep(0.5)
            
            # 启动新的tcpdump
            stdin, stdout, stderr = client.exec_command(tcpdump_cmd)
            time.sleep(1)  # 等待后台进程启动
            
            # 检查tcpdump是否启动成功
            stdin2, stdout2, stderr2 = client.exec_command("pgrep -f 'tcpdump.*traffic_' | head -1")
            pid = stdout2.read().decode().strip()

            # sudo tcpdump -w 生成的 pcap 属主是 root；下载走 SFTP 用的是普通 SSH 用户，
            # 这里 best-effort 放开读权限，确保任何 SSH 用户都能下载（忽略失败）
            client.exec_command(f"sudo chmod 644 {server_pcap_file} 2>/dev/null")

            client.close()
            
            if pid:
                self.monitoring_servers.add(server_host)
                success(f"Traffic monitor started on {server_host} (PID: {pid})")
                return True
            else:
                warning(f"Traffic monitor may not have started on {server_host}")
                # 仍然添加到监控列表，可能只是检测不到
                self.monitoring_servers.add(server_host)
                return True
            
        except Exception as e:
            error(f"Start traffic monitor failed {server_host}: {e}")
            return False
    
    def _sftp_download_pcap(self, client, remote_path, local_path):
        """
        通过 SFTP 二进制下载 pcap 文件。
        pcap 是二进制，必须用 SFTP（不能用 cat/plink 文本管道，文本编码会损坏二进制）。
        服务器上的文件正被 tcpdump 以 -U 持续写入，SFTP 读取的是当前已落盘内容，
        因 -U 每包即时 flush，截断也只发生在包边界，得到的仍是合法 pcap。

        返回下载字节数；文件不存在或为空（仅 24 字节全局头甚至更少）返回 None。
        """
        sftp = client.open_sftp()
        try:
            try:
                st = sftp.stat(remote_path)
            except IOError:
                return None
            # 仅有 pcap 全局头（24 字节）或更小，视为"还没抓到包"
            if st.st_size <= 24:
                return None
            sftp.get(remote_path, local_path)
            return st.st_size
        finally:
            try:
                sftp.close()
            except Exception:
                pass

    def save_logs_from_server(self, server_host, username, password,
                               target_ips, server_port=22):
        """
        从服务器下载 pcap 到本机（SFTP 二进制）。tcpdump 继续运行，不停止。
        """
        if isinstance(target_ips, str):
            target_ips = [ip.strip() for ip in target_ips.split(',') if ip.strip()]

        # 服务器上的 pcap 文件
        server_pcap_file = f"{self.server_log_path}/{self._get_server_log_filename(server_host, target_ips)}"

        # 本地保存的文件名（.pcap）
        local_pcap_file = os.path.join(self.log_dir, self._get_local_log_filename(server_host, target_ips))

        try:
            info(f"Downloading traffic pcap from {server_host}...")

            client = self._connect(server_host, username, password, server_port)
            try:
                size = self._sftp_download_pcap(client, server_pcap_file, local_pcap_file)
            finally:
                client.close()

            if size is None:
                warning(f"No traffic pcap found (or empty) on server {server_host}")
                return None

            success(f"Traffic pcap saved: {local_pcap_file}")
            info(f"  Size: {size / 1024:.1f} KB")

            return local_pcap_file

        except Exception as e:
            error(f"Download failed {server_host}: {e}")
            return None
    
    def save_log_for_server(self, server_host, username, password, server_port=22, local_path=None):
        """
        从指定服务器下载流量日志到指定路径
        用于GUI界面的选择性下载
        
        Args:
            server_host: 服务器IP
            username: SSH用户名
            password: SSH密码
            server_port: SSH端口
            local_path: 本地保存路径，如果为None则使用默认路径
        
        Returns:
            保存的文件路径，失败返回None
        """
        # 服务器上的 pcap 文件
        server_pcap_file = f"{self.server_log_path}/traffic_{server_host.replace('.', '_')}.pcap"

        # 本地保存路径
        if local_path is None:
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            local_path = os.path.join(self.log_dir, f"{server_host}_{timestamp}.pcap")

        try:
            info(f"Downloading traffic pcap from {server_host}...")

            # 使用复刻自 Agent 的 _connect 建连（信号量限速 + 重试退避 + 禁本地密钥扫描），
            # 既加快单台建连，也让高并发批量下载稳定。读取走 SFTP 二进制传输。
            client = self._connect(server_host, username, password, server_port)
            try:
                size = self._sftp_download_pcap(client, server_pcap_file, local_path)
            finally:
                client.close()

            if size is None:
                warning(f"No traffic pcap found (or empty) on server {server_host}")
                warning(f"  (pcap 文件路径: {server_pcap_file})")
                return None

            info(f"Downloaded {size / 1024:.1f} KB from {server_host}")

            return local_path

        except Exception as e:
            error(f"Download failed {server_host}: {e}")
            return None

    # ──────────────────────────────────────────────────────────
    # 批量并发下载（复刻自 agent_deploy_manager._batch_run / batch_download_db）
    # ──────────────────────────────────────────────────────────
    # 入场抖动：批量任务开局所有 worker 同一瞬间冲向 _connect_sem，会让 SSH 握手
    # SYN 在同一时刻爆发，触发云厂商 SYN 限流；给每个任务 0~JITTER 秒的随机入场延迟，
    # 把"齐刷刷一波 SYN"摊成"几秒内均匀分散"。
    _BATCH_JITTER_SECONDS = 3.0

    def batch_save_logs(self, target_dir, progress_cb=None, max_workers=_TRAFFIC_DOWNLOAD_WORKERS):
        """
        并发下载所有服务器的流量日志到 target_dir。
        - 一次查库取全部代理，按 server_ip 去重（同一台只下一次）
        - 有界线程池 + as_completed + 失败隔离（单台异常不拖垮整批）
        - 每完成一台回调 progress_cb(done, total, server_ip, ok)
        返回 list[{'server_ip', 'ok', 'path'}]
        """
        proxies = self.database.get_all_proxies_with_details()

        # 按 server_ip 去重，构建唯一服务器列表
        servers = []
        seen = set()
        for proxy in proxies:
            server_ip = proxy[8]
            if server_ip in seen:
                continue
            seen.add(server_ip)
            servers.append({
                'server_ip': server_ip,
                'username': proxy[10],
                'password': proxy[11],
                'server_port': proxy[9],
            })

        total = len(servers)
        results = []
        done_count = 0

        if total == 0:
            warning("No servers to download")
            return results

        # I/O 密集型任务线程栈 512KB 足够，默认 8MB 在高并发时浪费大量内存
        # (Linux 生效；Windows 忽略)
        try:
            threading.stack_size(512 * 1024)
        except Exception:
            pass

        # 抖动幅度：批量较小（<=10）时不抖；较大时按上限 _BATCH_JITTER_SECONDS
        jitter = self._BATCH_JITTER_SECONDS if total > 10 else 0.0

        def _do_one(s):
            if jitter > 0:
                time.sleep(random.uniform(0, jitter))
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            local_path = os.path.join(target_dir, f"{s['server_ip']}_{timestamp}.pcap")
            saved = self.save_log_for_server(
                s['server_ip'], s['username'], s['password'],
                s['server_port'], local_path
            )
            return saved  # 成功返回路径，失败/空日志返回 None

        info(f"Batch downloading traffic logs from {total} servers (workers={max_workers})...")

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_to_server = {pool.submit(_do_one, s): s for s in servers}
            for future in as_completed(future_to_server):
                s = future_to_server[future]
                try:
                    path = future.result()
                    ok = bool(path)
                except Exception as e:
                    path, ok = None, False
                    error(f"  ✗ {s['server_ip']}: {e}")

                done_count += 1
                results.append({'server_ip': s['server_ip'], 'ok': ok, 'path': path})

                if progress_cb:
                    try:
                        progress_cb(done_count, total, s['server_ip'], ok)
                    except Exception:
                        pass

        ok_count = sum(1 for r in results if r['ok'])
        success(f"Batch download done: {ok_count}/{total} succeeded")
        return results

    def save_all_logs(self):
        """从所有服务器下载流量日志"""
        from config import TRAFFIC_TARGET_IPS
        
        if not self.monitoring_servers:
            warning("No servers are being monitored")
            return 0
        
        proxies = self.database.get_all_proxies_with_details()
        saved_count = 0
        
        # 构建服务器信息字典
        server_info = {}
        for proxy in proxies:
            server_host = proxy[8]
            if server_host in self.monitoring_servers:
                server_info[server_host] = {
                    'username': proxy[10],
                    'password': proxy[11],
                    'port': proxy[9]
                }
        
        for server_host, info_dict in server_info.items():
            result = self.save_logs_from_server(
                server_host,
                info_dict['username'],
                info_dict['password'],
                TRAFFIC_TARGET_IPS,
                info_dict['port']
            )
            if result:
                saved_count += 1
        
        if saved_count > 0:
            success(f"Saved traffic logs from {saved_count} servers")
        return saved_count
    
    def get_monitor_status(self):
        """获取监控状态"""
        return list(self.monitoring_servers)
    
    def show_monitor_status(self):
        """显示监控状态"""
        raw("\n" + "=" * 50)
        raw("           Traffic Monitor Status")
        raw("=" * 50)
        
        if not self.monitoring_servers:
            raw("  (i) No servers are being monitored")
        else:
            raw(f"  Recording on {len(self.monitoring_servers)} server(s):")
            raw("")
            for server in self.monitoring_servers:
                raw(f"    [Recording] {server}")
            raw("")
            raw("  Use 'traffic_save' to download logs to local")
        
        raw("=" * 50)
    
    def start_all_monitors(self, target_ips, interface="eth0"):
        """为所有活跃服务器批量启动流量监控"""
        from utils import check_port
        
        proxies = self.database.get_all_proxies_with_details()
        
        if not proxies:
            warning("No proxies configured")
            return 0
        
        started = 0
        seen_servers = set()
        
        for proxy in proxies:
            server_host = proxy[8]
            port = proxy[3]
            
            # 跳过已处理的服务器
            if server_host in seen_servers:
                continue
            seen_servers.add(server_host)
            
            # 只为活跃的代理启动监控
            if not check_port(port):
                continue
            
            username = proxy[10]
            password = proxy[11]
            server_port = proxy[9]
            
            if self.start_monitor_for_server(
                server_host, username, password,
                target_ips, interface, server_port
            ):
                started += 1
        
        if started > 0:
            success(f"Traffic monitoring started on {started} server(s)")
        return started
    
    def is_any_monitoring(self):
        """检查是否有服务器在监控中"""
        return len(self.monitoring_servers) > 0
    
    def stop_monitor_for_server(self, server_host, username, password, server_port=22):
        """停止指定服务器的流量监控"""
        import paramiko
        
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(server_host, port=server_port, username=username, password=password, timeout=30)
            
            # 杀掉tcpdump进程
            client.exec_command("sudo pkill -f 'tcpdump.*traffic_' || true")
            
            client.close()
            
            if server_host in self.monitoring_servers:
                self.monitoring_servers.remove(server_host)
            
            success(f"Stopped traffic monitor on {server_host}")
            return True
            
        except Exception as e:
            error(f"Failed to stop traffic monitor on {server_host}: {e}")
            return False
    
    def stop_all_monitors(self):
        """停止所有服务器的流量监控 (多线程并发)"""
        from config import MAX_WORKERS
        import concurrent.futures
        
        if not self.monitoring_servers:
            info("没有正在运行的流量监控")
            return 0
        
        proxies = self.database.get_all_proxies_with_details()
        
        # 构建服务器信息
        servers_to_stop = []
        for proxy in proxies:
            server_host = proxy[8]
            if server_host in self.monitoring_servers:
                servers_to_stop.append({
                    'host': server_host,
                    'username': proxy[10],
                    'password': proxy[11],
                    'port': proxy[9]
                })
        
        if not servers_to_stop:
            self.monitoring_servers.clear()
            return 0
        
        info(f"停止 {len(servers_to_stop)} 个服务器的流量监控...")
        
        stopped_count = 0
        
        def stop_single(server_info):
            return self.stop_monitor_for_server(
                server_info['host'],
                server_info['username'],
                server_info['password'],
                server_info['port']
            )
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = [executor.submit(stop_single, s) for s in servers_to_stop]
            
            for future in concurrent.futures.as_completed(futures):
                try:
                    if future.result(timeout=20):
                        stopped_count += 1
                except Exception:
                    pass
        
        self.monitoring_servers.clear()
        success(f"已停止 {stopped_count} 个流量监控")
        return stopped_count
