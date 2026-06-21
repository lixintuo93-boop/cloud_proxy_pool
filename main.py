# main.py
"""
SOCKS5 代理管理器 - 主程序 v3.0
- 完整的命令行交互界面
- 所有操作支持多线程并发
- 统一日志格式
"""
import sys
import os
import datetime
import time

# 添加当前目录到Python路径
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# 提升文件描述符上限（Linux/Mac；Windows 默认已足够，静默忽略）
try:
    import resource
    resource.setrlimit(resource.RLIMIT_NOFILE, (65536, 65536))
except Exception:
    pass

from managers.proxy_manager import ProxyManager
from logger import info, success, warning, error, status, raw, set_log_level, LogLevel
from config import MAX_WORKERS


class InteractiveMenu:
    """交互式菜单管理"""
    
    def __init__(self):
        self.manager = ProxyManager()
        self.running = True
        
    def clear_screen(self):
        """清屏"""
        os.system('cls' if os.name == 'nt' else 'clear')
        
    def print_banner(self):
        """打印横幅"""
        raw("")
        raw("=" * 70)
        raw("              SOCKS5 Proxy Manager v3.0")
        raw("              多线程并发管理 | 最大并发: " + str(MAX_WORKERS))
        raw("=" * 70)
        
    def print_status_bar(self):
        """打印状态栏"""
        from config import KEEPALIVE_ENABLED
        from config import TRAFFIC_MONITOR_ENABLED, TRAFFIC_TARGET_IPS

        current_time = datetime.datetime.now().strftime("%H:%M:%S")

        # 获取代理统计
        proxies = self.manager.database.get_all_proxies_with_details()
        total = len(proxies)
        active = sum(1 for p in proxies if self.manager.status_monitor.proxy_status_cache.get(p[3], False))

        raw("-" * 70)
        raw(f"  时间: {current_time} | 代理: {active}/{total} 活跃 | 并发线程: {MAX_WORKERS}")

        # 保活状态
        keepalive_status = "开启" if KEEPALIVE_ENABLED else "关闭"
        raw(f"  保活: {keepalive_status}")
        
        # 流量监控状态
        traffic_status = "开启" if TRAFFIC_MONITOR_ENABLED else "关闭"
        if TRAFFIC_MONITOR_ENABLED and TRAFFIC_TARGET_IPS:
            traffic_status += f" ({len(TRAFFIC_TARGET_IPS)}个目标IP)"
        raw(f"  流量监控: {traffic_status}")
        raw("-" * 70)
        
    def print_main_menu(self):
        """打印主菜单"""
        raw("")
        raw("  ┌─────────────────────────────────────────────────────────────────┐")
        raw("  │                         主菜单                                  │")
        raw("  ├─────────────────────────────────────────────────────────────────┤")
        raw("  │  [1] 代理管理        [2] 流量监控        [3] 系统操作           │")
        raw("  │  [4] 查看状态        [5] 刷新界面                               │")
        raw("  │  [0] 退出程序                                                   │")
        raw("  └─────────────────────────────────────────────────────────────────┘")
        raw("")
        
    def print_proxy_menu(self):
        """代理管理子菜单"""
        raw("")
        raw("  ┌─────────────────────────────────────────────────────────────────┐")
        raw("  │                       代理管理                                  │")
        raw("  ├─────────────────────────────────────────────────────────────────┤")
        raw("  │  [1] 显示活跃代理          [2] 显示所有代理                     │")
        raw("  │  [3] 批量添加代理          [4] 添加单个代理                     │")
        raw("  │  [5] 删除指定代理          [6] 删除所有代理                     │")
        raw("  │  [7] 启动所有代理          [8] 停止所有代理                     │")
        raw("  │  [9] 重启所有代理          [10] 测试代理连接                    │")
        raw("  │  [0] 返回主菜单                                                 │")
        raw("  └─────────────────────────────────────────────────────────────────┘")
        raw("")
        
    def print_traffic_menu(self):
        """流量监控子菜单"""
        raw("")
        raw("  ┌─────────────────────────────────────────────────────────────────┐")
        raw("  │                        流量监控                                 │")
        raw("  ├─────────────────────────────────────────────────────────────────┤")
        raw("  │  [1] 查看监控状态               [2] 启动流量监控                │")
        raw("  │  [3] 下载流量日志               [4] 停止流量监控                │")
        raw("  │  [0] 返回主菜单                                                 │")
        raw("  └─────────────────────────────────────────────────────────────────┘")
        raw("")
        
    def print_system_menu(self):
        """系统操作子菜单"""
        raw("")
        raw("  ┌─────────────────────────────────────────────────────────────────┐")
        raw("  │                        系统操作                                 │")
        raw("  ├─────────────────────────────────────────────────────────────────┤")
        raw("  │  [1] 强制检查所有代理状态       [2] 清除密钥缓存                │")
        raw("  │  [3] 手动发送心跳包             [4] 查看保活状态                │")
        raw("  │  [5] 清理数据库旧记录           [6] 导出代理列表                │")
        raw("  │  [0] 返回主菜单                                                 │")
        raw("  └─────────────────────────────────────────────────────────────────┘")
        raw("")
        
    def get_input(self, prompt="请选择: "):
        """获取用户输入"""
        try:
            return input(prompt).strip()
        except (KeyboardInterrupt, EOFError):
            return "0"
            
    def pause(self, msg="按回车键继续..."):
        """暂停等待"""
        input(msg)
        
    # ==================== 代理管理功能 ====================
    
    def handle_proxy_menu(self):
        """处理代理管理菜单"""
        while True:
            self.clear_screen()
            self.print_banner()
            self.print_status_bar()
            self.print_proxy_menu()
            
            choice = self.get_input()
            
            if choice == "0":
                break
            elif choice == "1":
                self.show_active_proxies()
            elif choice == "2":
                self.show_all_proxies()
            elif choice == "3":
                self.batch_add_proxies()
            elif choice == "4":
                self.add_single_proxy()
            elif choice == "5":
                self.delete_proxy()
            elif choice == "6":
                self.delete_all_proxies()
            elif choice == "7":
                self.start_all_proxies()
            elif choice == "8":
                self.stop_all_proxies()
            elif choice == "9":
                self.restart_all_proxies()
            elif choice == "10":
                self.test_proxy_connection()
            else:
                warning("无效选项")
                self.pause()
                
    def show_active_proxies(self):
        """显示活跃代理"""
        raw("\n")
        self.manager.show_active_proxies()
        self.pause()
        
    def show_all_proxies(self):
        """显示所有代理"""
        raw("\n")
        self.manager.show_all_proxies()
        self.pause()
        
    def batch_add_proxies(self):
        """批量添加代理"""
        raw("\n批量添加代理:")
        raw("-" * 50)

        username = self.get_input("统一用户名: ").strip()
        if not username:
            error("用户名必填,已取消")
            self.pause()
            return

        password = self.get_input("统一密码: ")
        if not password:
            error("密码必填,已取消")
            self.pause()
            return

        raw("\n输入要添加的服务器IP (每行一个, 空行结束):")
        raw("格式: IP 或 IP:端口 （用上方统一凭据）  或  IP 用户名 密码 （本行覆盖）")
        raw("-" * 50)

        hosts = []
        while True:
            try:
                line = input("Host> ").strip()
                if not line:
                    break
                hosts.append(line)
            except KeyboardInterrupt:
                raw("\n已取消")
                break

        if hosts:
            raw(f"\n开始批量添加 {len(hosts)} 个代理 (并发线程: {MAX_WORKERS})...")
            self.manager.add_batch_proxies(hosts, username, password)
        else:
            warning("未输入任何主机")
        self.pause()
        
    def add_single_proxy(self):
        """添加单个代理"""
        raw("\n添加单个代理:")
        raw("-" * 50)

        host = self.get_input("服务器IP: ").strip()
        if not host:
            warning("已取消")
            self.pause()
            return

        username = self.get_input("用户名: ").strip()
        if not username:
            error("用户名必填,已取消")
            self.pause()
            return

        password = self.get_input("密码: ")
        if not password:
            error("密码必填,已取消")
            self.pause()
            return

        server_name = self.get_input("服务器名称 [自动]: ") or None

        if self.manager.add_proxy(host, username, password, server_name):
            success(f"代理添加成功: {host}")
        else:
            error(f"代理添加失败: {host}")
        self.pause()
        
    def delete_proxy(self):
        """删除指定代理"""
        raw("\n")
        self.manager.show_all_proxies()
        raw("")
        
        proxy_id = self.get_input("输入要删除的代理ID (0取消): ")
        if proxy_id == "0" or not proxy_id:
            raw("已取消")
            self.pause()
            return
            
        try:
            proxy_id = int(proxy_id)
            confirm = self.get_input(f"确认删除代理ID {proxy_id}? (y/N): ").lower()
            if confirm == 'y':
                if self.manager.delete_proxy(proxy_id):
                    success(f"代理 {proxy_id} 已删除")
                else:
                    error(f"删除代理 {proxy_id} 失败")
            else:
                raw("已取消")
        except ValueError:
            error("无效的代理ID")
        self.pause()
        
    def delete_all_proxies(self):
        """删除所有代理"""
        raw("\n")
        confirm = self.get_input("⚠️  确认删除所有代理? 此操作不可恢复! (输入 DELETE 确认): ")
        if confirm == "DELETE":
            self.manager.delete_all_proxies()
        else:
            raw("已取消")
        self.pause()
        
    def start_all_proxies(self):
        """启动所有代理"""
        raw("\n")
        info(f"启动所有代理 (并发线程: {MAX_WORKERS})...")
        started = self.manager.start_all_proxies(max_workers=MAX_WORKERS)
        success(f"启动完成: {started} 个代理运行中")
        self.pause()
        
    def stop_all_proxies(self):
        """停止所有代理"""
        raw("\n")
        confirm = self.get_input("确认停止所有代理? (y/N): ").lower()
        if confirm == 'y':
            self.manager.stop_all_proxies()
            success("所有代理已停止")
        else:
            raw("已取消")
        self.pause()
        
    def restart_all_proxies(self):
        """重启所有代理"""
        raw("\n")
        info("重启所有代理...")
        self.manager.stop_all_proxies()
        time.sleep(2)
        started = self.manager.start_all_proxies(max_workers=MAX_WORKERS)
        success(f"重启完成: {started} 个代理运行中")
        
        # 重启流量监控
        from config import TRAFFIC_MONITOR_ENABLED, TRAFFIC_TARGET_IPS
        if TRAFFIC_MONITOR_ENABLED and TRAFFIC_TARGET_IPS:
            time.sleep(2)
            self.manager.start_traffic_monitor_auto()
        self.pause()
        
    def test_proxy_connection(self):
        """测试代理连接"""
        raw("\n")
        self.manager.show_all_proxies()
        raw("")
        
        port = self.get_input("输入要测试的端口 (0取消): ")
        if port == "0" or not port:
            raw("已取消")
            self.pause()
            return
            
        try:
            port = int(port)
            from utils import test_proxy
            info(f"测试端口 {port}...")
            test_success, test_info = test_proxy(port)
            if test_success:
                success(f"端口 {port} 测试成功: {test_info}")
            else:
                error(f"端口 {port} 测试失败: {test_info}")
        except ValueError:
            error("无效的端口号")
        self.pause()
        
    # ==================== 流量监控功能 ====================
    
    def handle_traffic_menu(self):
        """处理流量监控菜单"""
        while True:
            self.clear_screen()
            self.print_banner()
            self.print_status_bar()
            self.print_traffic_menu()
            
            choice = self.get_input()
            
            if choice == "0":
                break
            elif choice == "1":
                self.show_traffic_status()
            elif choice == "2":
                self.start_traffic_monitor()
            elif choice == "3":
                self.save_traffic_logs()
            elif choice == "4":
                self.stop_traffic_monitor()
            else:
                warning("无效选项")
                self.pause()
                
    def show_traffic_status(self):
        """显示流量监控状态"""
        raw("\n")
        self.manager.show_traffic_monitor_status()
        self.pause()
        
    def start_traffic_monitor(self):
        """启动流量监控"""
        raw("\n")
        started = self.manager.start_traffic_monitor_auto()
        if started > 0:
            success(f"流量监控已启动: {started} 个服务器")
        else:
            warning("未启动任何流量监控")
        self.pause()
        
    def save_traffic_logs(self):
        """下载流量日志"""
        raw("\n")
        saved = self.manager.save_traffic_logs()
        if saved > 0:
            success(f"已下载 {saved} 个流量日志文件")
        else:
            warning("未下载任何日志文件")
        self.pause()
        
    def stop_traffic_monitor(self):
        """停止流量监控"""
        raw("\n")
        confirm = self.get_input("确认停止所有流量监控? (y/N): ").lower()
        if confirm == 'y':
            self.manager.traffic_monitor.stop_all_monitors()
            success("流量监控已停止")
        else:
            raw("已取消")
        self.pause()
        
    # ==================== 系统操作功能 ====================
    
    def handle_system_menu(self):
        """处理系统操作菜单"""
        while True:
            self.clear_screen()
            self.print_banner()
            self.print_status_bar()
            self.print_system_menu()
            
            choice = self.get_input()
            
            if choice == "0":
                break
            elif choice == "1":
                self.force_check_proxies()
            elif choice == "2":
                self.clear_key_cache()
            elif choice == "3":
                self.manual_keepalive()
            elif choice == "4":
                self.show_keepalive_status()
            elif choice == "5":
                self.cleanup_database()
            elif choice == "6":
                self.export_proxy_list()
            else:
                warning("无效选项")
                self.pause()
                
    def force_check_proxies(self):
        """强制检查所有代理状态"""
        raw("\n")
        info(f"强制检查所有代理状态 (并发线程: {MAX_WORKERS})...")
        self.manager.force_check_all_proxies()
        self.pause()
        
    def clear_key_cache(self):
        """清除密钥缓存"""
        raw("\n")
        confirm = self.get_input("确认清除所有SSH密钥缓存? (y/N): ").lower()
        if confirm == 'y':
            self.manager.tunnel_manager.hostkeys_accepted.clear()
            success("SSH密钥缓存已清除")
        else:
            raw("已取消")
        self.pause()
        
    def manual_keepalive(self):
        """手动发送心跳包"""
        raw("\n")
        info(f"手动发送心跳包 (并发线程: {MAX_WORKERS})...")
        self.manager.manual_keepalive()
        self.pause()
        
    def show_keepalive_status(self):
        """显示保活状态"""
        raw("\n")
        from config import KEEPALIVE_ENABLED, KEEPALIVE_INTERVAL, KEEPALIVE_TIMEOUT

        raw("=" * 50)
        raw("            保活状态")
        raw("=" * 50)
        raw(f"  启用状态: {'是' if KEEPALIVE_ENABLED else '否'}")
        raw(f"  心跳间隔: {KEEPALIVE_INTERVAL} 秒")
        raw(f"  连接超时: {KEEPALIVE_TIMEOUT} 秒")
        raw(f"  当前运行: {'是' if self.manager.status_monitor.keepalive_running else '否'}")
        raw("=" * 50)
        self.pause()
        
    def cleanup_database(self):
        """清理数据库旧记录"""
        raw("\n")
        info("清理数据库旧记录...")
        self.manager.database.cleanup_old_status()
        success("数据库清理完成")
        self.pause()
        
    def export_proxy_list(self):
        """导出代理列表"""
        raw("\n")
        proxies = self.manager.database.get_all_proxies_with_details()
        
        if not proxies:
            warning("没有代理可导出")
            self.pause()
            return
            
        filename = f"proxy_list_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
        
        with open(filename, 'w', encoding='utf-8') as f:
            f.write("# SOCKS5 代理列表\n")
            f.write(f"# 导出时间: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"# 总数: {len(proxies)}\n")
            f.write("#" + "=" * 50 + "\n\n")
            
            for proxy in proxies:
                proxy_name = proxy[1]
                port = proxy[3]
                server_host = proxy[8]
                is_active = self.manager.status_monitor.proxy_status_cache.get(port, False)
                status_str = "活跃" if is_active else "离线"
                
                f.write(f"127.0.0.1:{port}  # {proxy_name} ({server_host}) [{status_str}]\n")
                
        success(f"代理列表已导出到: {filename}")
        self.pause()
        
    # ==================== 查看状态功能 ====================
    
    def show_status_summary(self):
        """显示状态概要"""
        self.clear_screen()
        self.print_banner()
        self.print_status_bar()
        
        raw("\n")
        raw("=" * 70)
        raw("                           状态概要")
        raw("=" * 70)
        
        # 代理统计
        proxies = self.manager.database.get_all_proxies_with_details()
        total = len(proxies)
        active = sum(1 for p in proxies if self.manager.status_monitor.proxy_status_cache.get(p[3], False))
        
        raw(f"\n  [代理状态]")
        raw(f"    总数: {total}")
        raw(f"    活跃: {active}")
        raw(f"    离线: {total - active}")
        
        # 流量监控
        monitoring_count = len(self.manager.traffic_monitor.monitoring_servers)
        raw(f"\n  [流量监控]")
        raw(f"    监控中: {monitoring_count} 个服务器")
        
        # 系统信息
        raw(f"\n  [系统配置]")
        raw(f"    最大并发: {MAX_WORKERS}")
        raw(f"    保活状态: {'运行中' if self.manager.status_monitor.keepalive_running else '停止'}")
        
        raw("\n" + "=" * 70)
        self.pause()
        
    # ==================== 主循环 ====================
    
    def run(self):
        """运行主循环"""
        # 启动监控
        self.manager.start_monitor()
        
        # 自动启动代理
        self.clear_screen()
        self.print_banner()
        raw("\n>>> 正在启动所有代理...")
        started = self.manager.start_all_proxies(max_workers=MAX_WORKERS)
        success(f"启动完成: {started} 个代理运行中")
        
        # 自动启动流量监控
        from config import TRAFFIC_MONITOR_ENABLED, TRAFFIC_TARGET_IPS
        if TRAFFIC_MONITOR_ENABLED and TRAFFIC_TARGET_IPS:
            raw("\n>>> 正在启动流量监控...")
            time.sleep(2)
            self.manager.start_traffic_monitor_auto()
            
        self.pause("\n按回车键进入主菜单...")
        
        # 主循环
        while self.running:
            try:
                self.clear_screen()
                self.print_banner()
                self.print_status_bar()
                self.print_main_menu()
                
                choice = self.get_input()
                
                if choice == "0":
                    confirm = self.get_input("确认退出程序? (y/N): ").lower()
                    if confirm == 'y':
                        self.running = False
                elif choice == "1":
                    self.handle_proxy_menu()
                elif choice == "2":
                    self.handle_traffic_menu()
                elif choice == "3":
                    self.handle_system_menu()
                elif choice == "4":
                    self.show_status_summary()
                elif choice == "5":
                    continue  # 刷新界面
                else:
                    warning("无效选项")
                    self.pause()
                    
            except KeyboardInterrupt:
                raw("\n")
                confirm = self.get_input("\n确认退出程序? (y/N): ").lower()
                if confirm == 'y':
                    self.running = False
            except Exception as e:
                error(f"发生错误: {e}")
                self.pause()
                
        # 退出清理
        raw("\n>>> 正在退出...")
        self.manager.stop_all_proxies()
        self.manager.stop_monitor()
        self.manager.traffic_monitor.stop_all_monitors()
        success("程序已退出")


def main():
    """主函数"""
    menu = InteractiveMenu()
    menu.run()


if __name__ == "__main__":
    main()
