# managers/status_monitor.py
"""
状态监控管理器 - v5.0
优化项：
- 持久化心跳线程池，避免每 tick 创建/销毁线程
- 心跳槽位 fire-and-forget，tick 不等待结果
- _init_status_cache 并发初始化（50 并发）
- _check_proxy_real_status 去掉冗余的 check_port，直接 SOCKS5 测试
- _try_reconnect_proxy 异步执行，不阻塞 tick 线程
- tick 内批量写库（batch_update_proxy_status），减少 SQLite 事务数
- 错峰心跳：proxy_id % KEEPALIVE_INTERVAL 分散到每秒一批
- 滚动状态检查：proxy_id % STATUS_CHECK_INTERVAL 滚动窗口
- 服务器恢复检测：事件驱动 + 每台服务器30秒限速
"""
import threading
import time
import socket
import concurrent.futures
from utils import check_port, check_server_connectivity, can_bind_local_port, test_proxy_simple
from config import (
    KEEPALIVE_ENABLED, KEEPALIVE_INTERVAL, KEEPALIVE_TIMEOUT,
    STATUS_CHECK_INTERVAL,
)
from logger import info, success, warning, error, debug, status, raw, LogLevel, log

# 心跳持久化线程池大小：支持 1000 代理时每槽约 4 个，留有余量
_KA_POOL_SIZE = 20


class StatusMonitor:
    """状态监控管理器"""

    def __init__(self, database, tunnel_manager):
        self.database = database
        self.tunnel_manager = tunnel_manager
        self.monitor_running = False
        self.keepalive_running = False
        self.proxy_status_cache = {}
        self.reconnect_attempts = {}
        self._keepalive_thread = None
        # 每台服务器上次恢复检查时间（单调时钟），用于限速
        self._server_recovery_times = {}
        # 持久化心跳线程池，避免每 tick 创建/销毁
        self._ka_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=_KA_POOL_SIZE, thread_name_prefix="keepalive"
        )
        # 恢复成功后的回调函数（用于启动流量监控）
        self.on_proxy_recovered = None
        # 端口检测/迁移回调（由 ProxyManager 注入），签名: (proxy_id, proxy_name, port) -> (should_start, port)
        self.resolve_port = None
        # 删除/重连竞态防护：单一真相 + 每代理生命周期锁
        self._live_proxy_ids = set()
        self._proxy_locks = {}
        self._live_lock = threading.Lock()

    # ──────────────────── 代理生命周期注册 ────────────────────────

    def _proxy_lock(self, proxy_id):
        """获取/创建该 proxy_id 的生命周期锁，串行化删除与重连/恢复路径。"""
        with self._live_lock:
            lock = self._proxy_locks.get(proxy_id)
            if lock is None:
                lock = threading.Lock()
                self._proxy_locks[proxy_id] = lock
            return lock

    def register_proxy(self, proxy_id):
        """登记代理为存活（添加路径调用；启动时由 _init_status_cache 批量登记）。"""
        with self._live_lock:
            self._live_proxy_ids.add(proxy_id)

    def forget_proxy(self, proxy_id, port=None, server_host=None):
        """
        将代理移出存活集合，并清理与之相关的 in-memory 状态。
        所有循环和重连/恢复路径都会以 _live_proxy_ids 作为单一真相做过滤，
        本方法一次返回后，30/60s 缓存窗口内的滞后处理会被立刻挡住。
        """
        with self._live_lock:
            self._live_proxy_ids.discard(proxy_id)
            self._proxy_locks.pop(proxy_id, None)
        if port is not None:
            self.proxy_status_cache.pop(port, None)
            self.reconnect_attempts.pop(port, None)
        if server_host is not None:
            self._server_recovery_times.pop(server_host, None)

    def forget_all_proxies(self):
        """清空所有 in-memory 状态（用于 delete_all_proxies）。"""
        with self._live_lock:
            self._live_proxy_ids.clear()
            self._proxy_locks.clear()
        self.proxy_status_cache.clear()
        self.reconnect_attempts.clear()
        self._server_recovery_times.clear()

    # ──────────────────── 保活线程管理 ────────────────────────────

    def _start_keepalive(self):
        """启动保活线程"""
        if not KEEPALIVE_ENABLED:
            info("保活功能已在配置中禁用 (KEEPALIVE_ENABLED=False)")
            return

        if self.keepalive_running:
            info("保活功能已在运行中，跳过重复启动")
            return

        self.keepalive_running = True
        self._keepalive_thread = threading.Thread(target=self._keepalive_loop, daemon=True)
        self._keepalive_thread.start()
        info(f"保活功能已启动 (错峰模式，间隔: {KEEPALIVE_INTERVAL}秒，池大小: {_KA_POOL_SIZE})")

    def _stop_keepalive(self):
        """停止保活线程"""
        if not self.keepalive_running:
            return
        self.keepalive_running = False
        if self._keepalive_thread and self._keepalive_thread.is_alive():
            try:
                self._keepalive_thread.join(timeout=5)
            except Exception:
                pass
        info("保活功能已停止")

    # ──────────────────── 心跳循环（错峰 + fire-and-forget）───────

    def _keepalive_loop(self):
        """
        错峰保活循环：每秒一个 tick，本秒触发槽位 = int(now) % KEEPALIVE_INTERVAL。
        每个代理稳定落在槽位 proxy_id % KEEPALIVE_INTERVAL，新增/删除代理60秒内自动生效。
        任务提交给持久化线程池，tick 本身不等待结果（fire-and-forget），
        确保单个超时代理不会阻塞心跳节奏。
        """
        info(f"保活线程已启动 (错峰+异步，间隔: {KEEPALIVE_INTERVAL}秒)")
        keepalive_count = 0
        last_refresh = 0.0
        cached_proxies = []

        while self.keepalive_running:
            try:
                tick_start = time.monotonic()
                now_ts = time.time()

                # 每60秒刷新代理列表，适应新增/删除
                if now_ts - last_refresh > 60:
                    cached_proxies = self.database.get_active_proxies_with_details()
                    last_refresh = now_ts

                epoch_second = int(now_ts) % KEEPALIVE_INTERVAL
                due_proxies = [p for p in cached_proxies if p[0] % KEEPALIVE_INTERVAL == epoch_second]

                if due_proxies:
                    keepalive_count += 1
                    n, s = keepalive_count, epoch_second
                    proxies_snap = list(due_proxies)

                    # fire-and-forget：提交给持久化线程池，tick 继续走
                    # 注：_fire 在执行时再对 _live_proxy_ids 做一次过滤，
                    # 挡掉提交瞬间到执行瞬间之间被删除的代理。
                    def _fire(proxies=proxies_snap, cnt=n, slot=s):
                        live = self._live_proxy_ids
                        filtered = [p for p in proxies if p[0] in live]
                        for proxy in filtered:
                            self._simple_keepalive_test(proxy[1], proxy[3], proxy[8])
                        info(f"[心跳#{cnt}] 槽{slot}: {len(filtered)}/{len(proxies)}个代理完成")

                    self._ka_executor.submit(_fire)

                # 精确睡到下一整秒
                elapsed = time.monotonic() - tick_start
                time.sleep(max(0.0, 1.0 - elapsed))

            except Exception as e:
                error(f"保活循环错误: {e}")
                time.sleep(5)

    # ──────────────────── SOCKS5 保活测试 ─────────────────────────

    def _simple_keepalive_test(self, proxy_name, port, target_host=None):
        """
        SOCKS5协议保活测试
        发送 SOCKS5 握手 + CONNECT 请求，触发SSH隧道向远端传输数据
        """
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(KEEPALIVE_TIMEOUT)
            sock.connect(('127.0.0.1', port))

            sock.sendall(b'\x05\x01\x00')
            response = sock.recv(2)
            if len(response) < 2 or response[0:1] != b'\x05':
                debug(f"{proxy_name} SOCKS5握手失败")
                return False

            if target_host:
                ip_parts = [int(x) for x in target_host.split('.')]
                connect_request = bytes([
                    0x05, 0x01, 0x00, 0x01,
                    ip_parts[0], ip_parts[1], ip_parts[2], ip_parts[3],
                    0x00, 0x16
                ])
                sock.sendall(connect_request)
                try:
                    connect_response = sock.recv(10)
                    if len(connect_response) >= 2:
                        debug(f"{proxy_name} 保活成功 (CONNECT响应: {connect_response[1]})")
                    return True
                except socket.timeout:
                    debug(f"{proxy_name} 保活成功 (CONNECT已发送)")
                    return True
            else:
                debug(f"{proxy_name} 握手成功，但无目标IP")
                return True

        except socket.timeout:
            debug(f"{proxy_name} 保活超时")
            return False
        except ConnectionRefusedError:
            debug(f"{proxy_name} 连接被拒绝")
            return False
        except ConnectionResetError:
            debug(f"{proxy_name} 连接被重置")
            return False
        except Exception as e:
            debug(f"{proxy_name} 保活异常: {str(e)}")
            return False
        finally:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass

    # ──────────────────── 状态监控（滚动窗口 + batch写库）─────────

    def _monitor_proxy_status(self):
        """
        滚动窗口状态监控：每秒一个 tick，本秒检查槽位 = int(now) % STATUS_CHECK_INTERVAL。
        每个代理每 STATUS_CHECK_INTERVAL 秒被检查一次，均匀分散在各秒中。
        tick 内所有状态变更合并为一次 batch 写库，减少 SQLite 事务数。
        重连操作丢入后台线程，不阻塞 tick。
        """
        info(f"状态监控线程已启动 (滚动窗口模式，周期: {STATUS_CHECK_INTERVAL}秒)")

        last_refresh = 0.0
        cached_proxies = []
        last_status_report = 0.0

        self._init_status_cache()

        while self.monitor_running:
            try:
                tick_start = time.monotonic()
                now_ts = time.time()

                # 每30秒刷新完整代理列表
                if now_ts - last_refresh > 30:
                    cached_proxies = self.database.get_all_proxies_with_details()
                    last_refresh = now_ts

                epoch_second = int(now_ts) % STATUS_CHECK_INTERVAL
                due_proxies = [p for p in cached_proxies if p[0] % STATUS_CHECK_INTERVAL == epoch_second]

                # 过滤掉已删除的代理：cached_proxies 每 30s 才刷新一次，
                # 这中间被删除的代理仍会出现在 due_proxies 里，靠 _live_proxy_ids 挡住
                live_snapshot = self._live_proxy_ids
                due_proxies = [p for p in due_proxies if p[0] in live_snapshot]

                pending_updates = []   # [(proxy_id, is_active)] 批量写库
                status_changes = 0
                new_online_count = 0

                for proxy in due_proxies:
                    proxy_id, proxy_name, host, port, is_active, last_check, \
                        server_id, server_name, server_host, server_port, username, password, *_ = proxy

                    current_status = self._check_proxy_real_status(port)
                    previous_status = self.proxy_status_cache.get(port, None)

                    # 状态发生变化
                    if previous_status is not None and current_status != previous_status:
                        status_changes += 1
                        pending_updates.append((proxy_id, current_status))

                        if current_status:
                            success(f"代理 {proxy_name} (端口 {port}) 已恢复")
                            self.reconnect_attempts[port] = 0
                        else:
                            warning(f"检测到代理 {proxy_name} (端口 {port}) 已断开")
                            # 重连异步执行，不阻塞 tick
                            threading.Thread(
                                target=self._try_reconnect_proxy,
                                args=(proxy_id, proxy_name, server_host, port, username, password, server_port),
                                daemon=True
                            ).start()

                        self.proxy_status_cache[port] = current_status

                    # 首次检测
                    elif previous_status is None:
                        self.proxy_status_cache[port] = current_status
                        if current_status != (is_active == 1):
                            pending_updates.append((proxy_id, current_status))
                            status_changes += 1

                    # 检测新上线的代理
                    elif current_status and not is_active:
                        success(f"检测到新上线代理: {proxy_name} (端口 {port})")
                        pending_updates.append((proxy_id, True))
                        self.proxy_status_cache[port] = True
                        self.reconnect_attempts[port] = 0
                        new_online_count += 1
                        status_changes += 1

                    # 离线代理 — 事件触发服务器恢复检测（内部限速30s/台）
                    elif not current_status and not is_active:
                        self._check_server_recovery(
                            proxy_id, proxy_name, server_host, port, username, password, server_port
                        )

                    # 修正不一致状态
                    elif not current_status and is_active:
                        warning(f"修正状态: {proxy_name} (端口 {port}) 实际已断开")
                        pending_updates.append((proxy_id, False))
                        self.proxy_status_cache[port] = False
                        status_changes += 1

                # 一次事务批量写库
                if pending_updates:
                    self.database.batch_update_proxy_status(pending_updates)

                # 每5分钟或有状态变化时汇报
                if now_ts - last_status_report >= 300 or status_changes > 0:
                    active_count = sum(1 for s in self.proxy_status_cache.values() if s)
                    total_count = len(cached_proxies)
                    status_msg = f"📊 状态: {active_count}/{total_count} 活跃"
                    if new_online_count > 0:
                        status_msg += f" | 🆕 新上线: {new_online_count}"
                    if status_changes > 0:
                        status_msg += f" | 🔄 变化: {status_changes}"
                    status(status_msg)
                    if now_ts - last_status_report >= 300:
                        last_status_report = now_ts

                # 精确睡到下一整秒
                elapsed = time.monotonic() - tick_start
                time.sleep(max(0.0, 1.0 - elapsed))

            except Exception as e:
                error(f"状态监控错误: {e}")
                time.sleep(10)

    # ──────────────────── 状态缓存初始化（并发）──────────────────

    def _init_status_cache(self):
        """
        并发初始化状态缓存。
        串行检查 1000 个代理可能耗时数十秒；50 并发可在 2-3 秒内完成。
        """
        try:
            proxies = self.database.get_all_proxies_with_details()
            if not proxies:
                return

            # 一次性 bootstrap 存活集合（DB 里现有的都算活的）
            with self._live_lock:
                for p in proxies:
                    self._live_proxy_ids.add(p[0])

            def _check(proxy):
                return proxy[3], self._check_proxy_real_status(proxy[3])

            with concurrent.futures.ThreadPoolExecutor(max_workers=50, thread_name_prefix="init_cache") as ex:
                results = list(ex.map(_check, proxies))

            for port, s in results:
                self.proxy_status_cache[port] = s

            active = sum(1 for _, s in results if s)
            debug(f"状态缓存已初始化: {active}/{len(results)} 活跃")
        except Exception as e:
            error(f"初始化状态缓存失败: {e}")

    # ──────────────────── 代理存活检测 ────────────────────────────

    def _check_proxy_real_status(self, port):
        """
        检查代理是否真正存活。
        优化：直接做 SOCKS5 握手测试，去掉原有冗余的 check_port TCP 探测，
        避免每次健康检查建立两次 TCP 连接。
        """
        # 先检查 tunnel_manager 内存状态（零网络开销）
        if port in self.tunnel_manager.processes:
            name, tunnel_obj, host = self.tunnel_manager.processes[port]
            if hasattr(tunnel_obj, 'transport') and tunnel_obj.transport:
                try:
                    if not tunnel_obj.transport.is_active():
                        debug(f"端口 {port}: SSH transport 已断开")
                        return False
                except Exception:
                    pass
            if hasattr(tunnel_obj, 'is_alive') and not tunnel_obj.is_alive:
                debug(f"端口 {port}: 隧道已标记为不活跃")
                return False

        # 直接 SOCKS5 握手（已包含端口存活检测，无需额外 check_port）
        return self._check_proxy_alive(port)

    def _check_proxy_alive(self, port, timeout=3):
        """SOCKS5 握手测试"""
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            sock.connect(('127.0.0.1', port))
            sock.sendall(b'\x05\x01\x00')
            response = sock.recv(2)
            return len(response) >= 2 and response[0] == 0x05 and response[1] == 0x00
        except Exception:
            return False
        finally:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass

    # ──────────────────── 服务器恢复检测（事件驱动）──────────────

    def _check_server_recovery(self, proxy_id, proxy_name, server_host, port, username, password, server_port):
        """
        事件触发的服务器恢复检测。
        同一台服务器30秒内只检查一次，避免同服务器多代理同时触发连接洪泛。
        """
        # 与 delete_proxy 串行化：拿到锁后再确认 proxy 还活着，挡掉
        # "调用排队时还活着、轮到自己执行时已被删除"造成的孤儿恢复。
        with self._proxy_lock(proxy_id):
            if proxy_id not in self._live_proxy_ids:
                return
            try:
                now = time.monotonic()
                if now - self._server_recovery_times.get(server_host, 0) < 30:
                    return
                self._server_recovery_times[server_host] = now

                if check_server_connectivity(server_host, timeout=1):
                    info(f"检测到服务器恢复: {proxy_name} ({server_host})")
                    # bind+SOCKS5 区分：是本程序自己的 tunnel 在跑（复用），还是被外部占用（走自动恢复 + 必要时迁移）
                    if not can_bind_local_port(port):
                        ok, _ = test_proxy_simple(port, timeout=2)
                        if ok:
                            success(f"{proxy_name} 端口 {port} 已有有效 SOCKS5，更新状态")
                            self.database.batch_update_proxy_status([(proxy_id, True)])
                            self.proxy_status_cache[port] = True
                            self.reconnect_attempts[port] = 0
                            return
                        # 端口被外部占用，落入 _auto_recover_proxy 自动迁移
                    info(f"尝试自动恢复 {proxy_name}...")
                    self._auto_recover_proxy(proxy_id, proxy_name, server_host, port, username, password, server_port)
            except Exception as e:
                debug(f"服务器恢复检查异常 {proxy_name}: {e}")

    def _auto_recover_proxy(self, proxy_id, proxy_name, server_host, port, username, password, server_port):
        """自动恢复代理"""
        try:
            # 端口检测/迁移（若 ProxyManager 注入了 resolve_port）
            if self.resolve_port:
                try:
                    should_start, port = self.resolve_port(proxy_id, proxy_name, port)
                except RuntimeError as e:
                    error(f"{proxy_name} port {port} 被外部占用，端口迁移失败: {e}")
                    return
                if not should_start:
                    success(f"{proxy_name} 端口 {port} 已有有效 SOCKS5，复用")
                    self.database.batch_update_proxy_status([(proxy_id, True)])
                    self.proxy_status_cache[port] = True
                    self.reconnect_attempts[port] = 0
                    return

            key_accepted = self.tunnel_manager.accept_host_key_auto(
                server_host, username, password, is_auto_recovery=True
            )
            if key_accepted:
                process = self.tunnel_manager.start_ssh_tunnel(
                    proxy_name, server_host, port, username, password, is_auto_recovery=True
                )
                if process:
                    success(f"{proxy_name} 自动恢复成功")
                    self.database.batch_update_proxy_status([(proxy_id, True)])
                    self.proxy_status_cache[port] = True
                    self.reconnect_attempts[port] = 0
                    if self.on_proxy_recovered:
                        self.on_proxy_recovered(server_host, username, password, server_port)
                else:
                    debug(f"{proxy_name} 启动失败")
            else:
                debug(f"{proxy_name} 密钥接受失败")
        except Exception as e:
            debug(f"{proxy_name} 自动恢复异常: {e}")

    # ──────────────────── 重连（异步调用方）──────────────────────

    def _try_reconnect_proxy(self, proxy_id, proxy_name, server_host, port, username, password, server_port):
        """
        尝试重新连接代理。
        调用方已将此函数丢入后台线程，此处可放心执行阻塞操作（sleep、SSH握手等）。
        """
        # 与 delete_proxy 串行化：整段套生命周期锁，确保 delete_proxy 调用 stop_ssh_tunnel
        # 之后不会再被这里的 start_ssh_tunnel 把隧道反向"复活"。
        with self._proxy_lock(proxy_id):
            if proxy_id not in self._live_proxy_ids:
                debug(f"{proxy_name} 已被删除，跳过重连")
                return False
            try:
                attempt = self.reconnect_attempts.get(port, 0)
                if attempt >= 3:
                    if attempt == 3:
                        warning(f"{proxy_name} 重连次数已达上限，停止重试")
                        self.reconnect_attempts[port] = 4
                    return False

                if not check_server_connectivity(server_host, timeout=1):
                    debug(f"{proxy_name} 服务器不可达，跳过重连")
                    return False

                info(f"尝试重连 {proxy_name} (端口 {port})...")
                self.tunnel_manager.stop_ssh_tunnel(port)
                time.sleep(2)

                # 端口检测/迁移（停掉自家 tunnel 后端口仍不可 bind 说明被外部占用）
                if self.resolve_port:
                    try:
                        should_start, port = self.resolve_port(proxy_id, proxy_name, port)
                    except RuntimeError as e:
                        error(f"{proxy_name} port {port} 被外部占用，端口迁移失败: {e}")
                        return False
                    if not should_start:
                        success(f"{proxy_name} 端口 {port} 已有有效 SOCKS5，复用")
                        self.proxy_status_cache[port] = True
                        self.database.batch_update_proxy_status([(proxy_id, True)])
                        return True

                if server_host not in self.tunnel_manager.hostkeys_accepted:
                    key_accepted = self.tunnel_manager.accept_host_key_auto(
                        server_host, username, password, is_auto_recovery=True
                    )
                    if not key_accepted:
                        debug(f"{proxy_name} 主机密钥接受失败")
                        return False

                process = self.tunnel_manager.start_ssh_tunnel(
                    proxy_name, server_host, port, username, password, is_auto_recovery=True
                )
                if process:
                    success(f"{proxy_name} 重连成功")
                    self.reconnect_attempts[port] = 0
                    self.proxy_status_cache[port] = True
                    self.database.batch_update_proxy_status([(proxy_id, True)])
                    if self.on_proxy_recovered:
                        self.on_proxy_recovered(server_host, username, password, server_port)
                    return True
                else:
                    self.reconnect_attempts[port] = attempt + 1
                    warning(f"{proxy_name} 重连失败 (尝试 {self.reconnect_attempts[port]}/3)")
                    return False
            except Exception as e:
                error(f"{proxy_name} 重连异常: {e}")
                return False

    # ──────────────────── 监控生命周期 ────────────────────────────

    def start_monitor(self):
        """启动监控"""
        if self.monitor_running:
            debug("监控已在运行中")
            return

        # 上次 stop_monitor 把心跳线程池关掉了，这里需要重建（首启时 __init__ 已建过，
        # _ka_pool_alive 标志 False 才需要重建）
        if not getattr(self, '_ka_pool_alive', True):
            self._ka_executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=_KA_POOL_SIZE, thread_name_prefix="keepalive"
            )
        self._ka_pool_alive = True

        self.monitor_running = True
        status_thread = threading.Thread(target=self._monitor_proxy_status, daemon=True)
        status_thread.start()

        self._start_keepalive()

        cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        cleanup_thread.start()
        info("代理监控已启动 (状态监控 + 自动重连 + 保活)")

    def _cleanup_loop(self):
        """定期清理循环（WAL checkpoint，防止 WAL 文件无限增长）"""
        while self.monitor_running:
            try:
                self.database.cleanup_old_status()
                time.sleep(300)
            except Exception as e:
                debug(f"清理错误: {e}")
                time.sleep(300)

    def stop_monitor(self):
        """停止监控"""
        self.monitor_running = False
        self._stop_keepalive()
        try:
            self._ka_executor.shutdown(wait=False)
        except Exception:
            pass
        self._ka_pool_alive = False  # 标记线程池已关，下次 start_monitor 重建
        info("代理监控已停止")
