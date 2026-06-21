# managers/proxy_manager.py
"""
代理管理器 - v2.4
- 自动恢复成功后也启动流量监控
- 服务器不可达时给出明确提示
"""
import threading
import time
import os
import subprocess
import concurrent.futures
from utils import (
    check_port, test_proxy, check_server_connectivity,
    can_bind_local_port, get_excluded_port_ranges, is_in_excluded_ranges,
    test_proxy_simple,
)
from config import DEFAULT_SERVERS
from database import ProxyDatabase
from managers.ssh_tunnel_manager import SSHTunnelManager
from managers.status_monitor import StatusMonitor
from managers.traffic_monitor import TrafficMonitor
from logger import info, success, warning, error, status, debug, raw, LogLevel, log


class ProxyManager:
    """主代理管理器"""

    def __init__(self):
        self.database = ProxyDatabase()
        self.tunnel_manager = SSHTunnelManager(self.database)
        self.status_monitor = StatusMonitor(self.database, self.tunnel_manager)
        self.traffic_monitor = TrafficMonitor(self.database)
        self.startup_lock = threading.Lock()
        # 端口分配/迁移串行锁：保证并发添加 / 启动迁移时端口不冲突
        self._port_alloc_lock = threading.Lock()
        self.sudo_configured_servers = set()  # 已配置sudo的服务器

        # 设置代理恢复回调（恢复成功后启动流量监控）
        self.status_monitor.on_proxy_recovered = self._on_proxy_recovered
        # 注入端口检测/迁移回调，让 status_monitor 的恢复/重连路径也能自动迁移端口
        self.status_monitor.resolve_port = self._resolve_port_or_migrate

        self._init_default_servers()

    def _on_proxy_recovered(self, server_host, username, password, server_port):
        """代理恢复成功后的回调"""
        # 配置sudo
        self._configure_sudo_for_tcpdump(server_host, username, password, server_port)
        # 启动流量监控
        self._auto_start_traffic_for_new_proxy(server_host, username, password, server_port)

    def _init_default_servers(self):
        """初始化默认服务器"""
        proxies = self.database.get_all_proxies_with_details()
        if not proxies:
            current_port = 5001  # 默认起始端口

            for server in DEFAULT_SERVERS:
                name, host, port, username, password = server
                server_id, message = self.database.add_ssh_server(name, host, username, password, port)
                if server_id:
                    proxy_id, msg = self.database.add_local_proxy(server_id, f"{name}-proxy", current_port)
                    info(f"Init: {name} -> port {current_port}")
                    current_port += 1

    def _configure_sudo_for_tcpdump(self, server_host, username, password, server_port=22):
        """
        自动配置服务器的sudo免密码（用于tcpdump）
        仅在root用户时有效
        """
        from config import AUTO_CONFIGURE_SUDO

        if not AUTO_CONFIGURE_SUDO:
            return True

        if server_host in self.sudo_configured_servers:
            return True

        if username != "root":
            debug(f"{server_host}: Skip sudo config (not root user)")
            return True

        try:
            # 检查是否已配置
            check_cmd = [
                "plink.exe",
                "-ssh",
                f"{username}@{server_host}",
                "-P", str(server_port),
                "-pw", password,
                "-batch",
                "grep -q 'NOPASSWD.*tcpdump' /etc/sudoers && echo CONFIGURED || echo NOT_CONFIGURED"
            ]

            result = subprocess.run(
                check_cmd,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='ignore',
                timeout=10
            )

            if "CONFIGURED" in result.stdout:
                debug(f"{server_host}: sudo already configured")
                self.sudo_configured_servers.add(server_host)
                return True

            # 配置sudo免密码
            # 使用多种方式确保tcpdump可以无密码运行
            config_cmd = [
                "plink.exe",
                "-ssh",
                f"{username}@{server_host}",
                "-P", str(server_port),
                "-pw", password,
                "-batch",
                "echo 'root ALL=(ALL) NOPASSWD: /usr/sbin/tcpdump' >> /etc/sudoers && "
                "echo 'ALL ALL=(ALL) NOPASSWD: /usr/sbin/tcpdump' >> /etc/sudoers && "
                "chmod 440 /etc/sudoers && "
                "echo SUDO_CONFIGURED"
            ]

            result = subprocess.run(
                config_cmd,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='ignore',
                timeout=15
            )

            if "SUDO_CONFIGURED" in result.stdout:
                success(f"{server_host}: sudo configured for tcpdump")
                self.sudo_configured_servers.add(server_host)
                return True
            else:
                debug(f"{server_host}: sudo config may have failed: {result.stderr[:100]}")
                # 即使配置失败也标记，避免重复尝试
                self.sudo_configured_servers.add(server_host)
                return True

        except Exception as e:
            debug(f"{server_host}: sudo config error: {e}")
            return True  # 不阻塞主流程

    # ──────────────────────────────────────────────────────────
    # 端口分配（DB 已用 → Windows 保留段 → bind 测试，三层）
    # ──────────────────────────────────────────────────────────
    _PORT_FIND_MAX_TRY = 200

    def _find_free_local_port(self, start, used_ports, excluded_ranges, max_try=None):
        """
        从 start 起向上搜，跳过：DB 已用 + 系统保留段 + 不可 bind 的端口；
        返回第一个可用端口。连续 max_try 个都不可用则抛 RuntimeError。

        Note: 调用方负责加锁（self._port_alloc_lock）和把返回值加进 used_ports。
        """
        max_try = max_try or self._PORT_FIND_MAX_TRY
        p = max(1, int(start))
        tried = 0
        while tried < max_try and p <= 65535:
            if p in used_ports:
                p += 1; tried += 1; continue
            if is_in_excluded_ranges(p, excluded_ranges):
                p += 1; tried += 1; continue
            if not can_bind_local_port(p):
                p += 1; tried += 1; continue
            return p
        raise RuntimeError(f"端口分配失败：从 {start} 起连续 {max_try} 个端口都不可用")

    def _resolve_port_or_migrate(self, proxy_id, proxy_name, current_port):
        """
        启动隧道前的端口检测：
          (a) bind 成功 → 端口空闲 → 返回 (True, current_port)，调用方继续起 SSH
          (b) bind 失败但 SOCKS5 通 → 已有有效 SOCKS5（视为本程序遗留隧道）→ 返回 (False, current_port)，调用方仅置 active 不起 SSH
          (c) bind 失败且 SOCKS5 不通 → 外部进程占用 → 自动迁移到新端口，UPDATE DB → 返回 (True, new_port)
        迁移失败抛 RuntimeError，由调用方记日志。
        """
        if can_bind_local_port(current_port):
            return (True, current_port)
        ok, _ = test_proxy_simple(current_port, timeout=2)
        if ok:
            return (False, current_port)
        # 外部占用 → 迁移
        with self._port_alloc_lock:
            used = self.database.get_used_ports()
            ranges = get_excluded_port_ranges()
            new_port = self._find_free_local_port(current_port + 1, used, ranges)
            if not self.database.update_proxy_port(proxy_id, new_port):
                raise RuntimeError(f"端口迁移 {current_port}→{new_port} 写入数据库失败")
        warning(f"{proxy_name} port {current_port} 被外部进程占用，已自动迁移到 {new_port}")
        return (True, new_port)

    def find_free_port(self, start_port=None, refresh_excluded=False):
        """
        对外的便捷端口分配接口（GUI 默认值 / 单加 / 迁移共用）。
        起始端口默认取 max(DB max+1, 5001)。
        线程安全：加 _port_alloc_lock 保证并发分配不会撞同一个端口。

        注意：返回值仅是"分配建议"，调用方仍需立即用此端口启动 SSH 隧道，
        中间间隔越短，越能避免被外部进程抢走。
        """
        with self._port_alloc_lock:
            used = self.database.get_used_ports()
            ranges = get_excluded_port_ranges(force_refresh=refresh_excluded)
            if start_port is None:
                start_port = self.database.get_next_available_port()
            return self._find_free_local_port(start_port, used, ranges)

    def add_proxy(self, server_host, username, password,
                  server_name=None, proxy_name=None, server_port=22, local_port=None, group_name='1',
                  cloud_provider='auto'):
        """添加完整的代理

        Args:
            username: SSH 用户名，必填。
            password: SSH 密码，必填。
            local_port: 直接使用此端口（调用方负责保证可用，典型来自批量加预分配）。
                        None 时自动分配：从 DB max+1 起，三层检测找首个可用端口
                        （DB 已用 → 系统保留段 → 实际可 bind）。
                        若需要"从 N 起搜索"语义，调用方应先调 find_free_port(start_port=N)。
            group_name: 组名，默认为'1'
            cloud_provider: 云厂商标记，'auto' / 'aliyun' / 'tencent' / 'default'，默认 'auto'
        """
        if not username or not password:
            error(f"add_proxy: username/password 必填 ({server_host})")
            return False

        if self.database.is_server_exists(server_host):
            error(f"SSH server {server_host} already exists")
            return False

        if server_name is None:
            server_name = f"Server-{server_host}"
        if proxy_name is None:
            proxy_name = f"{server_name}-proxy"

        server_id, message = self.database.add_ssh_server(
            server_name, server_host, username, password, server_port, cloud_provider=cloud_provider
        )

        if server_id is None:
            error(f"Failed to add SSH server: {message}")
            return False

        # 端口分配：未指定时自动找首个可用端口（三层检测）；指定时直接使用调用方给的端口
        if local_port is None:
            try:
                port = self.find_free_port()
            except RuntimeError as e:
                error(f"Failed to allocate port for {server_host}: {e}")
                self.database.delete_server_and_proxies(server_id)
                return False
        else:
            port = local_port

        proxy_id, message = self.database.add_local_proxy(server_id, proxy_name, port, group_name=group_name)

        if proxy_id is None:
            error(f"Failed to add local proxy: {message}")
            self.database.delete_server_and_proxies(server_id)
            return False

        # 登记到 status_monitor 的存活集合：这样监控/心跳循环
        # 一拿到此代理就会通过 _live_proxy_ids 过滤直接放行。
        self.status_monitor.register_proxy(proxy_id)

        success(f"Added proxy: {server_name} -> 127.0.0.1:{port} [组: {group_name}]")

        # 启动代理
        started = self.start_proxy(proxy_id)

        if started:
            # 自动配置sudo（用于tcpdump）
            self._configure_sudo_for_tcpdump(server_host, username, password, server_port)

            # 如果流量监控已启用，自动为新代理开启监控
            self._auto_start_traffic_for_new_proxy(server_host, username, password, server_port)

        return started

    def _auto_start_traffic_for_new_proxy(self, server_host, username, password, server_port):
        """为新添加的代理自动开启流量监控"""
        from config import TRAFFIC_MONITOR_ENABLED, TRAFFIC_TARGET_IPS, TRAFFIC_INTERFACE

        if not TRAFFIC_MONITOR_ENABLED:
            return

        if not TRAFFIC_TARGET_IPS:
            return

        # 检查该服务器是否已有流量监控
        if server_host in self.traffic_monitor.monitoring_servers:
            debug(f"{server_host}: Traffic monitor already started")
            return

        info(f"Auto-starting traffic monitor for new proxy: {server_host}")
        self.traffic_monitor.start_monitor_for_server(
            server_host, username, password,
            TRAFFIC_TARGET_IPS, TRAFFIC_INTERFACE, server_port
        )

    def start_proxy(self, proxy_id):
        """启动指定代理"""
        try:
            proxy_details = self.database.get_proxy_details(proxy_id)
            if not proxy_details:
                error(f"Proxy ID not found: {proxy_id}")
                return False

            proxy_name = proxy_details['proxy_name']
            server_host = proxy_details['server_host']
            port = proxy_details['port']

            # 端口检测：bind → SOCKS5 → 必要时自动迁移
            try:
                should_start, port = self._resolve_port_or_migrate(proxy_id, proxy_name, port)
            except RuntimeError as e:
                error(f"{proxy_name} port {port} 被外部占用，端口迁移失败: {e}")
                return False
            if not should_start:
                debug(f"{proxy_name} port {port} 已有有效 SOCKS5（复用本程序遗留隧道）")
                self.database.update_proxy_status(proxy_id, True)
                return True

            if not check_server_connectivity(server_host, timeout=2):
                warning(f"{proxy_name} ({server_host}) server unreachable, will retry later")
                return False

            process = self.tunnel_manager.start_ssh_tunnel(
                proxy_name,
                server_host,
                port,
                proxy_details['username'],
                proxy_details['password'],
                is_auto_recovery=False
            )

            if process:
                with self.startup_lock:
                    self.status_monitor.proxy_status_cache[port] = True
                    self.status_monitor.reconnect_attempts[port] = 0
                # 立即更新数据库状态
                self.database.update_proxy_status(proxy_id, True)
                success(f"Started proxy: {proxy_name}")
                return True
            else:
                debug(f"Failed to start proxy: {proxy_name}")
                return False

        except Exception as e:
            error(f"Start proxy {proxy_id} error: {e}")
            return False

    def start_all_proxies(self, max_workers=8):
        """多线程启动所有代理"""
        proxies = self.database.get_all_proxies_with_details()

        if not proxies:
            info("No proxies to start")
            return 0

        # 监控可能被 stop_all_proxies 停过，启动前确保已起（idempotent）
        try:
            self.start_monitor()
        except Exception as e:
            debug(f"start_monitor 异常（已忽略）: {e}")

        info(f"Preparing to start {len(proxies)} proxies (threads: {max_workers})...")

        # 阶段1：并行预检查
        status(f"Phase 1: Checking server status...")

        proxies_to_start = []
        already_running = 0
        unreachable = 0

        for proxy in proxies:
            port = proxy[3]
            self.status_monitor.proxy_status_cache[port] = False
            self.status_monitor.reconnect_attempts[port] = 0

        def check_proxy_status(proxy):
            proxy_id = proxy[0]
            port = proxy[3]
            server_host = proxy[8]

            # 端口被占（bind 失败）需要进一步分辨：是本程序自己的 tunnel 还是外部进程
            if not can_bind_local_port(port):
                ok, _ = test_proxy_simple(port, timeout=2)
                if ok:
                    return ('running', proxy)  # 是有效 SOCKS5，复用
                # 否则视为外部占用，落入 'ready' 走 _start_proxy_fast 的自动迁移

            if check_server_connectivity(server_host, timeout=2):
                return ('ready', proxy)
            else:
                return ('unreachable', proxy)

        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers * 2) as executor:
            futures = {executor.submit(check_proxy_status, p): p for p in proxies}

            for future in concurrent.futures.as_completed(futures):
                try:
                    result_status, proxy = future.result(timeout=5)
                    proxy_id = proxy[0]
                    port = proxy[3]

                    if result_status == 'running':
                        # 立即更新数据库
                        self.database.update_proxy_status(proxy_id, True)
                        self.status_monitor.proxy_status_cache[port] = True
                        already_running += 1
                    elif result_status == 'ready':
                        proxies_to_start.append(proxy)
                    else:
                        unreachable += 1
                except Exception as e:
                    debug(f"Check status error: {e}")

        status(f"Phase 1 done: {already_running} running, {len(proxies_to_start)} to start, {unreachable} unreachable")

        if not proxies_to_start:
            if already_running > 0:
                success(f"All available proxies running ({already_running})")
            return already_running

        # 阶段2：预接受密钥
        status(f"Phase 2: Processing host keys...")

        servers_to_accept = set()
        for proxy in proxies_to_start:
            server_host = proxy[8]
            if server_host not in self.tunnel_manager.hostkeys_accepted:
                servers_to_accept.add((server_host, proxy[10], proxy[11]))

        if servers_to_accept:
            # 逐个处理，因为需要弹窗
            for server_info in servers_to_accept:
                host, username, password = server_info
                self.tunnel_manager.accept_host_key_auto(host, username, password)

            info(f"Host key processing done: {len(servers_to_accept)} servers")

        # 阶段3：并行启动
        status(f"Phase 3: Starting {len(proxies_to_start)} proxies...")

        started_count = 0

        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_proxy = {
                executor.submit(self._start_proxy_fast, proxy): proxy
                for proxy in proxies_to_start
            }

            for future in concurrent.futures.as_completed(future_to_proxy):
                proxy = future_to_proxy[future]
                try:
                    if future.result(timeout=15):
                        started_count += 1
                except concurrent.futures.TimeoutError:
                    debug(f"{proxy[1]} startup timeout")
                except Exception as e:
                    debug(f"{proxy[1]} startup error: {e}")

        total_active = already_running + started_count
        success(f"Startup complete: {total_active}/{len(proxies)} proxies active")

        # 批量配置sudo（在后台线程中执行，避免阻塞）
        if total_active > 0:
            threading.Thread(
                target=self._batch_configure_sudo,
                args=(proxies,),
                daemon=True
            ).start()

        return total_active

    def _batch_configure_sudo(self, proxies):
        """批量配置sudo免密码"""
        from config import AUTO_CONFIGURE_SUDO

        if not AUTO_CONFIGURE_SUDO:
            return

        seen_servers = set()
        for proxy in proxies:
            server_host = proxy[8]
            if server_host in seen_servers:
                continue
            seen_servers.add(server_host)

            username = proxy[10]
            password = proxy[11]
            server_port = proxy[9]

            # 只检查端口活跃的服务器
            port = proxy[3]
            if check_port(port):
                self._configure_sudo_for_tcpdump(server_host, username, password, server_port)

    def _start_proxy_fast(self, proxy):
        """快速启动代理"""
        proxy_id = proxy[0]
        proxy_name = proxy[1]
        port = proxy[3]
        server_host = proxy[8]
        username = proxy[10]
        password = proxy[11]

        try:
            # 端口检测：bind → SOCKS5 → 必要时自动迁移
            try:
                should_start, port = self._resolve_port_or_migrate(proxy_id, proxy_name, port)
            except RuntimeError as e:
                error(f"{proxy_name} port {port} 被外部占用，端口迁移失败: {e}")
                return False
            if not should_start:
                with self.startup_lock:
                    self.status_monitor.proxy_status_cache[port] = True
                    self.status_monitor.reconnect_attempts[port] = 0
                self.database.update_proxy_status(proxy_id, True)
                return True

            process = self.tunnel_manager.start_ssh_tunnel(
                proxy_name, server_host, port, username, password,
                is_auto_recovery=False
            )

            if process:
                with self.startup_lock:
                    self.status_monitor.proxy_status_cache[port] = True
                    self.status_monitor.reconnect_attempts[port] = 0
                # 立即更新数据库状态
                self.database.update_proxy_status(proxy_id, True)
                return True
            return False
        except Exception as e:
            debug(f"{proxy_name} fast start failed: {e}")
            return False

    def start_monitor(self):
        """启动监控"""
        self.status_monitor.start_monitor()

    def stop_monitor(self):
        """停止监控"""
        self.status_monitor.stop_monitor()

    def show_active_proxies(self):
        """显示活跃代理"""
        active_tunnels = self.tunnel_manager.get_active_tunnels()
        raw("\n" + "=" * 60)
        raw("                 Active Proxies")
        raw("=" * 60)

        if not active_tunnels:
            raw("  (i) No active proxies")
            return

        for name, port in active_tunnels:
            test_success, test_info = test_proxy(port)
            test_status = "[OK]" if test_success else "[FAIL]"
            ip_info = f" | {test_info}" if test_success else f" | Error: {test_info[:50]}..."
            raw(f"  {name}")
            raw(f"     Port: {port}")
            raw(f"     Status: {test_status}{ip_info}")
            raw("")

    def show_all_proxies(self):
        """显示所有代理"""
        proxies = self.database.get_all_proxies_with_details()
        raw("\n" + "=" * 100)
        raw("                                     All Proxies")
        raw("=" * 100)
        raw(f"{'ID':<3} {'Proxy Name':<18} {'Address':<12} {'Port':<6} {'Server':<15} {'Status':<10} {'Last Check'}")
        raw("-" * 100)

        if not proxies:
            raw("  (i) No proxy records")
            return

        for proxy in proxies:
            proxy_id, proxy_name, host, port, is_active, last_check, server_id, server_name, server_host, server_port, username, password, *_ = proxy
            actual_status = check_port(port)
            proxy_status = "[Active]" if is_active else "[Offline]"
            actual_indicator = " *" if is_active != actual_status else ""
            check_time = last_check.split('.')[0] if last_check else "Unknown"
            raw(f"{proxy_id:<3} {proxy_name:<18} {host:<12} {port:<6} {server_host:<15} {proxy_status:<10}{actual_indicator} {check_time}")

    def add_batch_proxies(self, hosts, username, password, start_port=None, group_name='1',
                           cloud_provider='auto'):
        """批量添加代理 (多线程并发)

        Args:
            hosts: 主机列表
            username: 统一用户名，必填；行内写 "IP user pass" 时被该行覆盖
            password: 统一密码，必填；行内写 "IP user pass" 时被该行覆盖
            start_port: 起始端口（仅作搜索起点；不指定则从 max(DB)+1 开始）
            group_name: 组名，默认为'1'
            cloud_provider: 云厂商标记，'auto' / 'aliyun' / 'tencent' / 'default'，默认 'auto'
        """
        if not username or not password:
            error("add_batch_proxies: username/password 必填")
            return 0

        from config import MAX_WORKERS

        # 获取已使用的端口
        used_ports = self.database.get_used_ports()
        # 每次批量加都重查 Windows 保留段（Hyper-V 启停会改变保留段）
        excluded_ranges = get_excluded_port_ranges(force_refresh=True)
        if excluded_ranges:
            info(f"[端口分配] 已加载系统保留段：{', '.join(f'{s}-{e}' for s,e in excluded_ranges)}")

        # 确定起始端口
        if start_port is None:
            start_port = self.database.get_next_available_port()

        current_port = start_port

        # 预处理：过滤重复，分配端口
        hosts_to_add = []
        duplicate_count = 0
        port_skipped_used = 0       # DB 已占
        port_skipped_excluded = 0   # 系统保留段
        port_skipped_unbindable = 0 # bind 失败（已被监听等）

        # 串行端口分配（确保 used_ports 一致性 + bind 测试结果及时反映到下一次搜索）
        with self._port_alloc_lock:
            for i, host in enumerate(hosts):
                # 解析主机信息
                parts = host.split()
                if len(parts) >= 3:
                    host_ip, user, pwd = parts[0], parts[1], parts[2]
                elif len(parts) == 1:
                    host_ip, user, pwd = parts[0], username, password
                else:
                    host_ip, user, pwd = host, username, password

                # 处理 IP:端口 格式
                if ':' in host_ip:
                    host_ip = host_ip.split(':')[0]

                if self.database.is_server_exists(host_ip):
                    warning(f"跳过重复: {host_ip}")
                    duplicate_count += 1
                    continue

                # 三层检测找首个可用端口（手动循环以便分类计数）
                p = current_port
                tried = 0
                assigned_port = None
                while tried < self._PORT_FIND_MAX_TRY and p <= 65535:
                    if p in used_ports:
                        port_skipped_used += 1
                        p += 1; tried += 1; continue
                    if is_in_excluded_ranges(p, excluded_ranges):
                        port_skipped_excluded += 1
                        p += 1; tried += 1; continue
                    if not can_bind_local_port(p):
                        port_skipped_unbindable += 1
                        p += 1; tried += 1; continue
                    assigned_port = p
                    break

                if assigned_port is None:
                    error(f"端口分配失败 (跳过 {host_ip}): 从 {current_port} 起 {self._PORT_FIND_MAX_TRY} 个端口都不可用")
                    duplicate_count += 1  # 计入失败计数（沿用统计口径，避免新加列）
                    current_port = p
                    continue

                used_ports.add(assigned_port)
                current_port = assigned_port + 1

                hosts_to_add.append((host_ip, user, pwd, f"Server-{len(hosts_to_add) + 1}", assigned_port, group_name, cloud_provider))

        if not hosts_to_add:
            raw(f"\n[批量添加结果]")
            raw(f"   成功: 0")
            raw(f"   重复: {duplicate_count}")
            raw(f"   失败: 0")
            return 0

        skip_total = port_skipped_used + port_skipped_excluded + port_skipped_unbindable
        if skip_total > 0:
            info(f"[端口分配] 已跳过 {skip_total} 个端口（DB 已用 {port_skipped_used}、系统保留 {port_skipped_excluded}、不可 bind {port_skipped_unbindable}）")

        info(
            f"开始并发添加 {len(hosts_to_add)} 个代理到组 [{group_name}] (起始端口: {start_port}, 并发: {MAX_WORKERS})...")

        success_count = 0
        failed_count = 0

        def add_single(args):
            host_ip, user, pwd, server_name, port, grp, cp = args
            try:
                return self.add_proxy(host_ip, user, pwd, server_name, local_port=port, group_name=grp, cloud_provider=cp)
            except Exception as e:
                error(f"添加 {host_ip} 失败: {e}")
                return False

        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(add_single, args): args for args in hosts_to_add}

            for future in concurrent.futures.as_completed(futures):
                args = futures[future]
                try:
                    if future.result(timeout=60):
                        success_count += 1
                    else:
                        failed_count += 1
                except Exception as e:
                    failed_count += 1
                    debug(f"添加 {args[0]} 异常: {e}")

        raw(f"\n[批量添加结果]")
        raw(f"   成功: {success_count}")
        raw(f"   重复: {duplicate_count}")
        raw(f"   失败: {failed_count}")
        raw(f"   组: {group_name}")
        return success_count

    def delete_proxy(self, proxy_id):
        """删除指定代理"""
        try:
            proxy_details = self.database.get_proxy_details(proxy_id)
            if not proxy_details:
                error(f"代理ID不存在: {proxy_id}")
                return False

            port = proxy_details['port']
            server_id = proxy_details['server_id']
            server_host = proxy_details['server_host']
            proxy_name = proxy_details['proxy_name']

            # 整段串行化：拿到该 proxy 的生命周期锁后，重连/恢复路径都会等到
            # 这里跑完才能继续，进锁后又会发现代理已不在 _live_proxy_ids 中而早退，
            # 杜绝"删除后被异步重连复活成孤儿隧道"。
            with self.status_monitor._proxy_lock(proxy_id):
                # 1) 先停隧道
                self.tunnel_manager.stop_ssh_tunnel(port)

                # 2) 删数据库
                result, message = self.database.delete_server_and_proxies(server_id)
                if not result:
                    error(f"删除失败: {message}")
                    return False

                # 3) 清 in-memory 状态：移出存活集合、清缓存、清服务器恢复时间
                self.status_monitor.forget_proxy(
                    proxy_id, port=port, server_host=server_host
                )

            success(f"已删除代理: {proxy_name}")
            return True

        except Exception as e:
            error(f"删除代理 {proxy_id} 错误: {e}")
            return False

    def batch_check_server_connectivity(self):
        """批量检测服务器连通性 (多线程并发)"""
        from config import MAX_WORKERS

        proxies = self.database.get_all_proxies_with_details()
        if not proxies:
            warning("没有代理记录")
            return

        info(f"检测 {len(proxies)} 个服务器连通性 (并发线程: {MAX_WORKERS})...")

        # 去重服务器
        servers = {}
        for proxy in proxies:
            server_host = proxy[8]
            if server_host not in servers:
                servers[server_host] = proxy[7]  # server_name

        results = {'reachable': [], 'unreachable': []}

        def check_single(server_info):
            host, name = server_info
            try:
                if check_server_connectivity(host, timeout=5):
                    return ('reachable', host, name)
                else:
                    return ('unreachable', host, name)
            except Exception:
                return ('unreachable', host, name)

        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = [executor.submit(check_single, (host, name)) for host, name in servers.items()]

            for future in concurrent.futures.as_completed(futures):
                try:
                    status_type, host, name = future.result(timeout=10)
                    results[status_type].append((host, name))
                except Exception:
                    pass

        raw("\n" + "=" * 60)
        raw("               服务器连通性检测结果")
        raw("=" * 60)
        raw(f"\n  [可达] {len(results['reachable'])} 个服务器:")
        for host, name in results['reachable']:
            raw(f"    ✓ {name} ({host})")
        raw(f"\n  [不可达] {len(results['unreachable'])} 个服务器:")
        for host, name in results['unreachable']:
            raw(f"    ✗ {name} ({host})")
        raw("\n" + "=" * 60)

    def manual_keepalive(self):
        """手动发送心跳包 (多线程并发)"""
        from config import MAX_WORKERS

        active_proxies = self.database.get_active_proxies_with_details()
        if not active_proxies:
            warning("没有活跃代理")
            return

        info(f"向 {len(active_proxies)} 个代理发送心跳包 (并发线程: {MAX_WORKERS})...")

        success_count = 0
        failed_count = 0

        def send_keepalive(proxy):
            proxy_name = proxy[1]
            port = proxy[3]
            server_host = proxy[8]

            if not check_port(port):
                return False

            return self.status_monitor._simple_keepalive_test(proxy_name, port, server_host)

        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(send_keepalive, p): p for p in active_proxies}

            for future in concurrent.futures.as_completed(futures):
                try:
                    if future.result(timeout=10):
                        success_count += 1
                    else:
                        failed_count += 1
                except Exception:
                    failed_count += 1

        raw(f"\n[心跳包发送结果]")
        raw(f"   成功: {success_count}")
        raw(f"   失败: {failed_count}")

    def stop_all_proxies(self):
        """彻底停止所有代理：SSH 隧道 + 状态监控 + 心跳。

        必须把监控和心跳也停了，否则监控线程会在几十秒内把刚停的代理自动拉起来。
        想再启动需调用 start_all_proxies / start_proxy（两者均会按需重启监控）。
        """
        self.tunnel_manager.stop_all_tunnels()
        # 停监控（内部含 _stop_keepalive、shutdown 心跳线程池）
        try:
            self.status_monitor.stop_monitor()
        except Exception as e:
            debug(f"stop_monitor 异常（已忽略）: {e}")
        # 把所有代理在 DB 里标记为非活跃；防止下次启动监控时被误判"还在跑"
        try:
            proxies = self.database.get_all_proxies_with_details()
            if proxies:
                self.database.batch_update_proxy_status([(p[0], False) for p in proxies])
        except Exception as e:
            debug(f"批量置 inactive 失败（已忽略）: {e}")
        self.status_monitor.proxy_status_cache.clear()
        self.status_monitor.reconnect_attempts.clear()
        info("All proxies stopped (含监控与心跳)")

    def delete_all_proxies(self):
        """删除所有服务器和代理"""
        proxies = self.database.get_all_proxies_with_details()
        if not proxies:
            info("No proxies to delete")
            return

        info(f"Deleting all servers and proxies ({len(proxies)} proxies)...")
        self.stop_all_proxies()
        result, message = self.database.delete_all_servers_and_proxies()

        if result:
            success(message)
            self.status_monitor.forget_all_proxies()
            self.tunnel_manager.hostkeys_accepted.clear()
            self.tunnel_manager.processes.clear()
        else:
            error(message)

    def force_check_all_proxies(self):
        """强制检查所有代理状态"""
        info("Force checking all proxies...")
        proxies = self.database.get_all_proxies_with_details()
        updated_count = 0
        server_recovered_count = 0

        for proxy in proxies:
            proxy_id, proxy_name, host, port, is_active, last_check, server_id, server_name, server_host, server_port, username, password, *_ = proxy
            current_status = check_port(port)
            cached_status = self.status_monitor.proxy_status_cache.get(port, False)

            if current_status != is_active or current_status != cached_status:
                status_str = '[Active]' if current_status else '[Offline]'
                info(f"Update {proxy_name} status: {status_str}")
                self.database.update_proxy_status(proxy_id, current_status)
                self.status_monitor.proxy_status_cache[port] = current_status
                updated_count += 1

                if current_status and not is_active:
                    self.status_monitor.reconnect_attempts[port] = 0

            if not current_status:
                if check_server_connectivity(server_host, timeout=1):
                    info(f"Detected reachable server: {proxy_name}, attempting recovery...")
                    if self._recover_proxy(proxy_id, proxy_name, server_host, port, username, password):
                        server_recovered_count += 1

        raw(f"\n[Force Check Result]")
        raw(f"   Updated: {updated_count}")
        raw(f"   Recovered: {server_recovered_count}")
        active_count = sum(1 for s in self.status_monitor.proxy_status_cache.values() if s)
        raw(f"   Status: {active_count}/{len(proxies)} active")

    def _recover_proxy(self, proxy_id, proxy_name, server_host, port, username, password):
        """恢复代理"""
        try:
            # 端口检测：bind → SOCKS5 → 必要时自动迁移
            try:
                should_start, port = self._resolve_port_or_migrate(proxy_id, proxy_name, port)
            except RuntimeError as e:
                error(f"{proxy_name} port {port} 被外部占用，端口迁移失败: {e}")
                return False
            if not should_start:
                self.database.update_proxy_status(proxy_id, True)
                self.status_monitor.proxy_status_cache[port] = True
                self.status_monitor.reconnect_attempts[port] = 0
                return True

            key_accepted = self.tunnel_manager.accept_host_key_auto(server_host, username, password)
            if not key_accepted:
                return False

            process = self.tunnel_manager.start_ssh_tunnel(
                proxy_name, server_host, port, username, password,
                is_auto_recovery=False
            )
            if process:
                self.database.update_proxy_status(proxy_id, True)
                self.status_monitor.proxy_status_cache[port] = True
                self.status_monitor.reconnect_attempts[port] = 0
                return True
            return False
        except Exception as e:
            error(f"{proxy_name} recovery error: {e}")
            return False

    # ==================== 流量监控功能 ====================

    def start_traffic_monitor_auto(self):
        """自动启动流量监控（使用配置文件中的设置）"""
        from config import TRAFFIC_MONITOR_ENABLED, TRAFFIC_TARGET_IPS, TRAFFIC_INTERFACE

        if not TRAFFIC_MONITOR_ENABLED:
            debug("Traffic monitoring disabled in config")
            return 0

        if not TRAFFIC_TARGET_IPS:
            warning("No target IPs configured for traffic monitoring")
            return 0

        # 获取当前活跃的代理（从内存缓存和实际端口检查）
        proxies = self.database.get_all_proxies_with_details()
        active_proxies = []

        for proxy in proxies:
            port = proxy[3]
            # 检查端口是否真正在监听
            if check_port(port):
                active_proxies.append(proxy)
                # 确保数据库状态正确
                self.database.update_proxy_status(proxy[0], True)

        if not active_proxies:
            warning("No active proxies found for traffic monitoring")
            return 0

        info(f"Auto-starting traffic monitoring for IPs: {', '.join(TRAFFIC_TARGET_IPS)}")
        info(f"Found {len(active_proxies)} active proxies")

        # 启动流量监控
        started = 0
        seen_servers = set()

        for proxy in active_proxies:
            server_host = proxy[8]
            if server_host in seen_servers:
                continue
            seen_servers.add(server_host)

            username = proxy[10]
            password = proxy[11]
            server_port = proxy[9]

            if self.traffic_monitor.start_monitor_for_server(
                    server_host, username, password,
                    TRAFFIC_TARGET_IPS, TRAFFIC_INTERFACE, server_port
            ):
                started += 1

        if started > 0:
            success(f"Traffic monitoring started on {started} servers (server-side logging)")
        return started

    def save_traffic_logs(self):
        """下载所有服务器的流量日志到本机"""
        if not self.traffic_monitor.is_any_monitoring():
            warning("No servers are being monitored")
            return 0
        return self.traffic_monitor.save_all_logs()

    def show_traffic_monitor_status(self):
        """显示流量监控状态"""
        self.traffic_monitor.show_monitor_status()