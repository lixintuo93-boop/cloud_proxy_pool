# gui_app.py
"""
SOCKS5 代理管理器 - GUI版本 v3.9
- 新增代理分组功能
- 批量添加时可选择组
- 支持按组筛选代理列表
- 点击组名可快速修改
- 流量监控显示组名
"""
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext, filedialog
import threading
import time
import sys
import os
import re
import glob
import queue
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from collections import defaultdict

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from config import (
    MAX_WORKERS, KEEPALIVE_ENABLED, KEEPALIVE_INTERVAL,
    TRAFFIC_MONITOR_ENABLED, TRAFFIC_TARGET_IPS,
    DATABASE_FILE, PROXY_TEST_URL, PROXY_TEST_TIMEOUT, STATUS_CHECK_INTERVAL,
    AGENT_LOG_SAVE_DIR, AGENT_DEPLOY_WORKERS, TRAFFIC_LOG_SAVE_DIR,
    AGENT_SOURCE_DIR, RESOURCE_DIR_NAME, _app_root, find_tshark,
    get_beijing_time_str, get_beijing_time_short,
)
import json
import shutil
import stat
import zipfile
from logger import set_gui_callback, LogLevel


def _rmtree_force(path):
    """shutil.rmtree 的 Windows 兼容版：遇只读文件（如 .git/objects/）先取消只读再删。"""
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


class BatchAddDialog(tk.Toplevel):
    """批量添加代理的弹窗"""

    def __init__(self, parent, callback, default_start_port=5001, groups=None,
                 last_username='', last_password=''):
        super().__init__(parent)
        self.callback = callback
        self.default_start_port = default_start_port
        self.groups = groups if groups else ['1']
        self.last_username = last_username or ''
        self.last_password = last_password or ''
        self.title("批量添加代理")
        self.geometry("500x560")
        self.resizable(True, True)

        self.transient(parent)
        self.grab_set()

        self.create_widgets()

        self.update_idletasks()
        x = parent.winfo_x() + (parent.winfo_width() - self.winfo_width()) // 2
        y = parent.winfo_y() + (parent.winfo_height() - self.winfo_height()) // 2
        self.geometry(f"+{x}+{y}")

    def create_widgets(self):
        main_frame = ttk.Frame(self, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # 端口和组配置
        config_frame = ttk.LabelFrame(main_frame, text="配置", padding="5")
        config_frame.pack(fill=tk.X, pady=(0, 10))

        port_row = ttk.Frame(config_frame)
        port_row.pack(fill=tk.X, pady=2)

        ttk.Label(port_row, text="起始端口:").pack(side=tk.LEFT)
        self.start_port_var = tk.StringVar(value=str(self.default_start_port))
        self.port_entry = ttk.Entry(port_row, textvariable=self.start_port_var, width=10)
        self.port_entry.pack(side=tk.LEFT, padx=5)

        ttk.Label(port_row, text="(端口自动递增，冲突时跳过)", foreground="gray").pack(side=tk.LEFT, padx=10)

        # 组选择行
        group_row = ttk.Frame(config_frame)
        group_row.pack(fill=tk.X, pady=2)

        ttk.Label(group_row, text="所属组:").pack(side=tk.LEFT)
        self.group_var = tk.StringVar(value=self.groups[0] if self.groups else '1')
        self.group_combo = ttk.Combobox(group_row, textvariable=self.group_var, values=self.groups, width=15)
        self.group_combo.pack(side=tk.LEFT, padx=5)

        ttk.Label(group_row, text="(可输入新组名)", foreground="gray").pack(side=tk.LEFT, padx=10)

        # 统一用户名（必填）
        user_row = ttk.Frame(config_frame)
        user_row.pack(fill=tk.X, pady=2)
        ttk.Label(user_row, text="用户名:").pack(side=tk.LEFT)
        self.username_var = tk.StringVar(value=self.last_username)
        self.username_entry = ttk.Entry(user_row, textvariable=self.username_var, width=20)
        self.username_entry.pack(side=tk.LEFT, padx=5)
        ttk.Label(user_row, text="(必填,作为本批默认;行内 3 段写法会覆盖)", foreground="gray").pack(side=tk.LEFT, padx=10)

        # 统一密码（必填）
        pwd_row = ttk.Frame(config_frame)
        pwd_row.pack(fill=tk.X, pady=2)
        ttk.Label(pwd_row, text="密码:").pack(side=tk.LEFT)
        self.password_var = tk.StringVar(value=self.last_password)
        self.password_entry = ttk.Entry(pwd_row, textvariable=self.password_var, width=20)
        self.password_entry.pack(side=tk.LEFT, padx=5)
        ttk.Label(pwd_row, text="(必填)", foreground="gray").pack(side=tk.LEFT, padx=10)

        # 云厂商选择行（决定部署时走哪家镜像）
        cloud_row = ttk.Frame(config_frame)
        cloud_row.pack(fill=tk.X, pady=2)
        ttk.Label(cloud_row, text="云厂商:").pack(side=tk.LEFT)
        # value 直接用代码内部值；显示用中文标签
        self._cloud_options = [
            ('auto',    '自动探测'),
            ('aliyun',  '阿里云'),
            ('tencent', '腾讯云'),
            ('default', '默认（官方源）'),
        ]
        self._cloud_label_to_value = {label: val for val, label in self._cloud_options}
        self.cloud_var = tk.StringVar(value=self._cloud_options[0][1])  # 默认"自动探测"
        self.cloud_combo = ttk.Combobox(
            cloud_row, textvariable=self.cloud_var,
            values=[label for _, label in self._cloud_options],
            state='readonly', width=18,
        )
        self.cloud_combo.pack(side=tk.LEFT, padx=5)
        ttk.Label(cloud_row, text="(部署时按此选择 npm/Node.js 镜像)", foreground="gray").pack(side=tk.LEFT, padx=10)

        ttk.Label(main_frame, text="输入服务器IP（每行一个）:").pack(anchor=tk.W)
        ttk.Label(main_frame, text="格式: IP  /  IP 用户名 密码  /  腾讯云CSV(ins-xxx,名称,IP)，自动识别IP",
                  foreground="gray").pack(anchor=tk.W)

        self.text_input = scrolledtext.ScrolledText(main_frame, height=12)
        self.text_input.pack(fill=tk.BOTH, expand=True, pady=5)

        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(fill=tk.X)

        ttk.Button(btn_frame, text="📥 从文件导入", command=self.import_from_file).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="🗑️ 清空", command=lambda: self.text_input.delete(1.0, tk.END)).pack(side=tk.LEFT,
                                                                                                        padx=5)
        ttk.Button(btn_frame, text="❌ 取消", command=self.destroy).pack(side=tk.RIGHT, padx=5)
        ttk.Button(btn_frame, text="✅ 添加", command=self.do_add).pack(side=tk.RIGHT, padx=5)

    def import_from_file(self):
        filename = filedialog.askopenfilename(filetypes=[("Text files", "*.txt"), ("All files", "*.*")])
        if filename:
            try:
                with open(filename, 'r', encoding='utf-8') as f:
                    self.text_input.delete(1.0, tk.END)
                    self.text_input.insert(1.0, f.read())
            except Exception as e:
                messagebox.showerror("错误", f"导入失败: {e}")

    def do_add(self):
        try:
            start_port = int(self.start_port_var.get())
            if start_port < 1 or start_port > 65535:
                messagebox.showerror("错误", "端口必须在1-65535之间")
                return
        except ValueError:
            messagebox.showerror("错误", "请输入有效的端口号")
            return

        group_name = self.group_var.get().strip()
        if not group_name:
            group_name = '1'

        batch_username = self.username_var.get().strip()
        if not batch_username:
            messagebox.showerror("错误", "用户名必填")
            self.username_entry.focus_set()
            return

        batch_password = self.password_var.get()
        if not batch_password:
            messagebox.showerror("错误", "密码必填")
            self.password_entry.focus_set()
            return

        text = self.text_input.get(1.0, tk.END).strip()
        if not text:
            messagebox.showwarning("警告", "请输入服务器IP")
            return

        hosts = [line.strip() for line in text.split('\n') if line.strip() and not line.startswith('#')]
        if not hosts:
            messagebox.showwarning("警告", "没有有效的服务器IP")
            return

        cloud_provider = self._cloud_label_to_value.get(self.cloud_var.get(), 'auto')
        self.callback(hosts, start_port, group_name, cloud_provider, batch_username, batch_password)
        self.destroy()


class LogAnalyzerWindow(tk.Toplevel):
    """日志分析窗口 - 支持批量导入多个日志，按 IP 列表(一行一个文件)组织"""

    # tcpdump 行正则（与原实现一致）
    TCPDUMP_PATTERN = re.compile(
        r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+IP\s+'
        r'(\d+\.\d+\.\d+\.\d+)\.(\d+)\s+>\s+(\d+\.\d+\.\d+\.\d+)\.(\d+):\s+(.+)'
    )

    def __init__(self, parent, filepaths=None):
        super().__init__(parent)
        self.title("日志分析")
        self.geometry("1200x720")
        self.minsize(960, 560)

        # file_key(abspath) -> {
        #   ip, date_str, dt, size, server, target_ips, client_ip,
        #   port_stats: {port: {first_time, count, out, inc, rst}},
        #   totals: {ports, packets, out, inc, rst, t_start, t_end},
        #   port_data: {port: [packet,...]} 或 None(懒解析),
        #   iid, scanned(bool), parsed(bool), error
        # }
        self.files = {}
        self.node_info = {}   # tree iid -> {'type':'file'/'port', 'key':..., 'port':...}
        self.sort_column = 'date'
        self.sort_reverse = False

        # 批量扫描相关（大量文件时避免卡死）
        self._scan_queue = queue.Queue()   # 后台扫描结果队列
        self._pool = None                  # 后台线程池
        self._total = 0                    # 累计待扫描文件数
        self._done = 0                     # 已扫描完成数
        self._draining = False             # drain 轮询是否在运行
        self._search_after = None          # 搜索防抖句柄

        # 复制相关
        self._detail_raw = {}              # 详情表 iid -> 原始 tcpdump 行
        self._current_detail = None        # 当前详情对应的 (file_key, port)
        self._menu_target = None           # 端口行右键菜单的目标 (file_key, port)

        self.create_widgets()

        if filepaths:
            if isinstance(filepaths, str):
                filepaths = [filepaths]
            self.add_files(filepaths)

    # ---------------- 界面 ----------------
    def create_widgets(self):
        main_frame = ttk.Frame(self, padding="5")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # 顶部工具栏
        top = ttk.Frame(main_frame)
        top.pack(fill=tk.X, pady=(0, 5))

        ttk.Button(top, text="➕ 添加文件", command=self.add_files_dialog).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="📁 添加整个目录", command=self.add_directory_dialog).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="🗑️ 清空", command=self.clear_all).pack(side=tk.LEFT, padx=2)
        self.status_label = ttk.Label(top, text="", foreground="gray")
        self.status_label.pack(side=tk.LEFT, padx=10)
        ttk.Button(top, text="关闭", command=self.destroy).pack(side=tk.RIGHT, padx=2)

        # 使用PanedWindow分割 IP 列表和详情
        self.paned = ttk.PanedWindow(main_frame, orient=tk.HORIZONTAL)
        self.paned.pack(fill=tk.BOTH, expand=True)

        # 左侧：IP 列表（可展开树）
        left_frame = ttk.LabelFrame(self.paned, text="IP 列表", padding="5")
        self.paned.add(left_frame, weight=1)

        self.list_info_label = ttk.Label(left_frame, text="共 0 个文件", foreground="gray")
        self.list_info_label.pack(fill=tk.X)

        # 日期筛选下拉
        date_frame = ttk.Frame(left_frame)
        date_frame.pack(fill=tk.X, pady=(3, 0))
        ttk.Label(date_frame, text="📅 日期").pack(side=tk.LEFT)
        self.date_var = tk.StringVar(value='全部日期')
        self.date_combo = ttk.Combobox(date_frame, textvariable=self.date_var,
                                       state='readonly', values=['全部日期'])
        self.date_combo.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=3)
        self.date_combo.bind('<<ComboboxSelected>>', self.on_date_selected)

        # 搜索框（按 IP 筛选）
        search_frame = ttk.Frame(left_frame)
        search_frame.pack(fill=tk.X, pady=3)
        ttk.Label(search_frame, text="🔍 IP").pack(side=tk.LEFT)
        self.search_var = tk.StringVar()
        self.search_var.trace('w', self.filter_ips)
        ttk.Entry(search_frame, textvariable=self.search_var).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=3)

        columns = ('date', 'ports', 'packets')
        self.ip_tree = ttk.Treeview(left_frame, columns=columns, show='tree headings', height=22)

        self.ip_tree.heading('#0', text='IP / 端口', command=lambda: self.sort_by('ip'))
        self.ip_tree.heading('date', text='日期/时间', command=lambda: self.sort_by('date'))
        self.ip_tree.heading('ports', text='端口数', command=lambda: self.sort_by('ports'))
        self.ip_tree.heading('packets', text='总包数', command=lambda: self.sort_by('packets'))

        self.ip_tree.column('#0', width=150, minwidth=110)
        self.ip_tree.column('date', width=120, minwidth=80, anchor=tk.W)
        self.ip_tree.column('ports', width=55, minwidth=45, anchor=tk.CENTER)
        self.ip_tree.column('packets', width=70, minwidth=50, anchor=tk.CENTER)

        ip_scroll = ttk.Scrollbar(left_frame, orient=tk.VERTICAL, command=self.ip_tree.yview)
        self.ip_tree.configure(yscrollcommand=ip_scroll.set)

        self.ip_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        ip_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        self.ip_tree.bind('<<TreeviewSelect>>', self.on_tree_select)
        self.ip_tree.bind('<<TreeviewOpen>>', self.on_tree_open)
        self.ip_tree.bind('<Button-3>', self._on_ip_tree_menu)

        # 端口行右键菜单
        self.ip_menu = tk.Menu(self, tearoff=0)
        self.ip_menu.add_command(label="📋 复制该端口全部日志", command=self._copy_menu_target)

        # 右侧：详情
        right_frame = ttk.LabelFrame(self.paned, text="交互详情", padding="5")
        self.paned.add(right_frame, weight=3)

        # 图例和信息
        legend_frame = ttk.Frame(right_frame)
        legend_frame.pack(fill=tk.X, pady=3)

        legends = [("🟢 发出", "#e8f5e9"), ("🔵 收到", "#e3f2fd"), ("🟡 SYN", "#fff3e0"), ("🔴 RST", "#ffebee"),
                   ("🟣 FIN", "#fce4ec")]
        for text, color in legends:
            lbl = ttk.Label(legend_frame, text=text, background=color, padding=2)
            lbl.pack(side=tk.LEFT, padx=2)

        self.detail_info_label = ttk.Label(legend_frame, text="选择 IP 查看概览，展开后选择端口查看详情",
                                            foreground="gray")
        self.detail_info_label.pack(side=tk.RIGHT)

        # 详情列表
        detail_frame = ttk.Frame(right_frame)
        detail_frame.pack(fill=tk.BOTH, expand=True)

        columns = ('time', 'dir', 'src', 'dst', 'flags', 'seq', 'len', 'info')
        self.detail_tree = ttk.Treeview(detail_frame, columns=columns, show='headings', height=20)

        self.detail_tree.heading('time', text='时间')
        self.detail_tree.heading('dir', text='方向')
        self.detail_tree.heading('src', text='源地址')
        self.detail_tree.heading('dst', text='目标地址')
        self.detail_tree.heading('flags', text='标志')
        self.detail_tree.heading('seq', text='序列号')
        self.detail_tree.heading('len', text='长度')
        self.detail_tree.heading('info', text='详情')

        self.detail_tree.column('time', width=100)
        self.detail_tree.column('dir', width=40)
        self.detail_tree.column('src', width=140)
        self.detail_tree.column('dst', width=140)
        self.detail_tree.column('flags', width=60)
        self.detail_tree.column('seq', width=90)
        self.detail_tree.column('len', width=50)
        self.detail_tree.column('info', width=200)

        detail_scroll_y = ttk.Scrollbar(detail_frame, orient=tk.VERTICAL, command=self.detail_tree.yview)
        detail_scroll_x = ttk.Scrollbar(detail_frame, orient=tk.HORIZONTAL, command=self.detail_tree.xview)
        self.detail_tree.configure(yscrollcommand=detail_scroll_y.set, xscrollcommand=detail_scroll_x.set)

        self.detail_tree.grid(row=0, column=0, sticky='nsew')
        detail_scroll_y.grid(row=0, column=1, sticky='ns')
        detail_scroll_x.grid(row=1, column=0, sticky='ew')

        detail_frame.grid_rowconfigure(0, weight=1)
        detail_frame.grid_columnconfigure(0, weight=1)

        # 配置颜色标签
        self.detail_tree.tag_configure('outgoing', background='#e8f5e9')
        self.detail_tree.tag_configure('incoming', background='#e3f2fd')
        self.detail_tree.tag_configure('syn', background='#fff3e0')
        self.detail_tree.tag_configure('rst', background='#ffebee')
        self.detail_tree.tag_configure('fin', background='#fce4ec')

        # 详情区：全选 / 复制 / 右键菜单（复制原始 tcpdump 行）
        self.detail_tree.bind('<Control-a>', self._select_all_details)
        self.detail_tree.bind('<Control-A>', self._select_all_details)
        self.detail_tree.bind('<Control-c>', self._copy_detail_selected)
        self.detail_tree.bind('<Control-C>', self._copy_detail_selected)
        self.detail_tree.bind('<Button-3>', self._on_detail_menu)

        self.detail_menu = tk.Menu(self, tearoff=0)
        self.detail_menu.add_command(label="📋 复制选中 (Ctrl+C)", command=self._copy_detail_selected)
        self.detail_menu.add_command(label="📋 复制全部", command=self._copy_detail_all)

    # ---------------- 导入 ----------------
    def add_files_dialog(self):
        """多选文件加入分析"""
        paths = filedialog.askopenfilenames(
            title="选择要分析的流量抓包（可多选）",
            filetypes=[("抓包/日志", "*.pcap *.pcapng *.cap *.log"),
                       ("pcap 抓包", "*.pcap *.pcapng *.cap"),
                       ("Log files", "*.log"),
                       ("All files", "*.*")]
        )
        if paths:
            self.add_files(list(paths))

    def add_directory_dialog(self):
        """导入某目录下所有 .pcap / .log"""
        d = filedialog.askdirectory(title="选择目录（导入其中所有 .pcap / .log）")
        if not d:
            return
        paths = []
        for pat in ("*.pcap", "*.pcapng", "*.cap", "*.log"):
            paths.extend(glob.glob(os.path.join(d, pat)))
        paths = sorted(set(paths))
        if not paths:
            messagebox.showinfo("提示", "该目录下没有 .pcap / .log 文件")
            return
        self.add_files(paths)

    def add_files(self, paths):
        """批量加入文件：去重后用线程池并发扫描；结果经队列由主线程节流增量插入，
        不再每个文件都全量重建整棵树（避免数千文件时卡死）。"""
        new_keys = []
        for p in paths:
            key = os.path.abspath(p)
            if key in self.files or not os.path.isfile(key):
                continue
            self.files[key] = {'iid': None, 'scanned': False, 'parsed': False,
                               'port_data': None, 'error': None, 'ports_filled': False,
                               'ip': os.path.basename(key)}
            new_keys.append(key)
        if not new_keys:
            return

        self._total += len(new_keys)
        self.status_label.config(text=f"正在解析 {self._done}/{self._total} ...")

        if self._pool is None:
            self._pool = ThreadPoolExecutor(max_workers=6)
        for key in new_keys:
            self._pool.submit(self._scan_task, key)

        if not self._draining:
            self._draining = True
            self.after(120, self._drain_scan_results)

    def _scan_task(self, key):
        """后台线程：扫描单个文件，结果放入队列。"""
        try:
            meta = self._scan_file(key)
            meta['error'] = None
        except Exception as e:
            meta = {'error': str(e)}
        self._scan_queue.put((key, meta))

    def _drain_scan_results(self):
        """主线程节流消费扫描结果：每帧最多处理一批，增量插入行。"""
        processed = 0
        try:
            while processed < 300:   # 每帧上限，避免长时间占用 UI 线程
                key, meta = self._scan_queue.get_nowait()
                self._apply_scanned(key, meta)
                self._done += 1
                processed += 1
        except queue.Empty:
            pass

        if self._done < self._total:
            self.status_label.config(text=f"正在解析 {self._done}/{self._total} ...")
            self.after(120, self._drain_scan_results)
        else:
            self._draining = False
            self.status_label.config(text=f"完成，共 {self._total} 个文件")
            self._refresh_date_choices()
            self.refresh_tree()   # 全部完成后按当前排序统一归位

    def _apply_scanned(self, key, meta):
        """把单个文件的扫描结果写入数据，并增量插入/更新它对应的一行。"""
        info = self.files.get(key)
        if info is None:
            return  # 可能已被 clear_all 清除
        if meta.get('error'):
            info['scanned'] = True
            info['error'] = meta['error']
        else:
            info.update(meta)
            info['scanned'] = True

        # 受当前筛选（IP + 日期）：不匹配则不插入行（完成后的 refresh_tree 会统一处理）
        if not self._passes_filter(key):
            return
        self._insert_or_update_file_row(key)

    def _insert_or_update_file_row(self, key):
        """插入或更新某文件对应的父行；端口子行用一个占位 dummy 实现懒展开。"""
        info = self.files[key]
        ip = info.get('ip') or os.path.basename(key)
        if info.get('error'):
            vals, ports = ('解析失败', '', ''), 0
        else:
            t = info['totals']
            vals, ports = (info.get('date_str', ''), t['ports'], t['packets']), t['ports']

        iid = info.get('iid')
        if iid and self.ip_tree.exists(iid):
            self.ip_tree.item(iid, text=ip, values=vals)
        else:
            iid = self.ip_tree.insert('', 'end', text=ip, values=vals)
            info['iid'] = iid
            self.node_info[iid] = {'type': 'file', 'key': key}

        # 重置子行为未填充状态，仅挂一个 dummy 让其可展开
        info['ports_filled'] = False
        for c in self.ip_tree.get_children(iid):
            self.ip_tree.delete(c)
        if ports > 0:
            self.ip_tree.insert(iid, 'end', text='', values=('', '', ''), tags=('dummy',))

    def on_tree_open(self, event):
        """展开某 IP 行时才插入它的端口子行（懒加载，避免一次性几十万行）。"""
        iid = self.ip_tree.focus()
        info = self.node_info.get(iid)
        if not info or info['type'] != 'file':
            return
        f = self.files.get(info['key'])
        if not f or f.get('ports_filled'):
            return
        for c in self.ip_tree.get_children(iid):
            self.ip_tree.delete(c)   # 删除 dummy
        for port, st in sorted(f.get('port_stats', {}).items(),
                               key=lambda kv: kv[1]['first_time'] or datetime.max):
            ft = st['first_time'].strftime('%H:%M:%S') if st['first_time'] else '-'
            cid = self.ip_tree.insert(iid, 'end', text=port, values=(ft, '', st['count']))
            self.node_info[cid] = {'type': 'port', 'key': info['key'], 'port': port}
        f['ports_filled'] = True

    def _tshark_packets(self, filepath):
        """
        用 tshark 把 pcap 解析成与文本路径一致的逐包 dict 列表。
        只取 TCP；tcp.flags 十六进制位自行解码为 tcpdump 风格短标志；绝对 seq/ack。
        """
        import subprocess
        tshark = find_tshark()
        if not tshark:
            raise RuntimeError("未找到 tshark，请安装 Wireshark（自带 tshark）或将其加入 PATH")

        fields = ["frame.time_epoch", "ip.src", "ip.dst", "tcp.srcport", "tcp.dstport",
                  "tcp.flags", "tcp.seq", "tcp.ack", "tcp.len", "_ws.col.Info"]
        cmd = [tshark, "-r", filepath, "-Y", "tcp",
               "-o", "tcp.relative_sequence_numbers:FALSE",
               "-T", "fields", "-E", "separator=\t", "-E", "occurrence=f"]
        for fld in fields:
            cmd += ["-e", fld]

        result = subprocess.run(cmd, capture_output=True, text=True,
                                encoding="utf-8", errors="ignore", timeout=300)
        if result.returncode != 0 and not result.stdout:
            raise RuntimeError((result.stderr or "tshark 解析失败").strip()[:300])

        packets = []
        for line in result.stdout.splitlines():
            cols = line.split("\t")
            if len(cols) < 10:
                continue
            t_epoch, src_ip, dst_ip, src_port, dst_port = cols[0:5]
            tcp_flags, seq, ack, length = cols[5:9]
            info = "\t".join(cols[9:])
            if not (src_ip and dst_ip and src_port and dst_port):
                continue
            try:
                ts = datetime.fromtimestamp(float(t_epoch))
            except (ValueError, OSError):
                continue
            try:
                fb = int(tcp_flags, 16) if tcp_flags else 0
            except ValueError:
                fb = 0
            flags = ''
            if fb & 0x02: flags += 'S'
            if fb & 0x01: flags += 'F'
            if fb & 0x04: flags += 'R'
            if fb & 0x08: flags += 'P'
            if fb & 0x20: flags += 'U'
            if fb & 0x10: flags += '.'
            seq = seq or ''
            length = length or '0'
            raw = (f"{ts.strftime('%Y-%m-%d %H:%M:%S.%f')} IP "
                   f"{src_ip}.{src_port} > {dst_ip}.{dst_port}: "
                   f"Flags [{flags}], seq {seq}, length {length}")
            packets.append({
                'timestamp': ts, 'src_ip': src_ip, 'src_port': src_port,
                'dst_ip': dst_ip, 'dst_port': dst_port, 'flags': flags,
                'seq': seq, 'length': length, 'info': (info or '')[:100],
                'raw': raw,
            })
        return packets

    def _scan_file(self, filepath):
        """轻量扫描：得到每端口聚合与总计；不保留逐包详情。pcap 走 tshark，文本走正则。"""
        # 文件名：IP_YYYYMMDD_HHMMSS.(pcap|log)
        ip_from_name, date_str, dt = self._parse_filename(os.path.basename(filepath))
        server = None
        target_ips = []
        rows = []           # (ts, src_ip, src_port, dst_ip, dst_port, flags)
        client_ip = None

        if filepath.lower().endswith(('.pcap', '.pcapng', '.cap')):
            # 二进制抓包：tshark 解析（无文本头，server/target_ips 留空，靠文件名取 IP）
            for p in self._tshark_packets(filepath):
                rows.append((p['timestamp'], p['src_ip'], p['src_port'],
                             p['dst_ip'], p['dst_port'], p['flags']))
                if client_ip is None:
                    sp, dp = int(p['src_port']), int(p['dst_port'])
                    if sp > 1024 and dp <= 1024:
                        client_ip = p['src_ip']
                    elif dp > 1024 and sp <= 1024:
                        client_ip = p['dst_ip']
        else:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()

            # 头部：# Server / # Target IPs
            for line in content[:2000].split('\n'):
                if line.startswith('# Server:'):
                    server = line.split(':', 1)[1].strip()
                elif line.startswith('# Target IPs:'):
                    target_ips = [x.strip() for x in line.split(':', 1)[1].split(',') if x.strip()]
                elif line.strip() and not line.startswith('#'):
                    break

            # 一次正则遍历 + 识别 client_ip
            for line in content.replace('\r\n', '\n').split('\n'):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                m = self.TCPDUMP_PATTERN.match(line)
                if not m:
                    continue
                ts_str, src_ip, src_port, dst_ip, dst_port, details = m.groups()
                try:
                    ts = datetime.strptime(ts_str, '%Y-%m-%d %H:%M:%S.%f')
                except Exception:
                    continue
                flags_m = re.search(r'Flags \[([^\]]+)\]', details)
                flags = flags_m.group(1) if flags_m else ''
                rows.append((ts, src_ip, src_port, dst_ip, dst_port, flags))
                if client_ip is None:
                    if int(src_port) > 1024 and int(dst_port) <= 1024:
                        client_ip = src_ip
                    elif int(dst_port) > 1024 and int(src_port) <= 1024:
                        client_ip = dst_ip

        ip = server or ip_from_name or '未知'

        if client_ip is None and rows:
            cnt = defaultdict(int)
            for ts, s_ip, s_pt, d_ip, d_pt, fl in rows:
                if int(s_pt) > 1024:
                    cnt[s_ip] += 1
                if int(d_pt) > 1024:
                    cnt[d_ip] += 1
            if cnt:
                client_ip = max(cnt, key=lambda k: cnt[k])

        # 第二遍：按端口聚合
        port_stats = {}
        total = out = inc = rst = 0
        t_start = t_end = None
        for ts, s_ip, s_pt, d_ip, d_pt, fl in rows:
            if s_ip == client_ip:
                port, is_out = s_pt, True
            elif d_ip == client_ip:
                port, is_out = d_pt, False
            else:
                continue
            st = port_stats.get(port)
            if st is None:
                st = port_stats[port] = {'first_time': None, 'count': 0, 'out': 0, 'inc': 0, 'rst': 0}
            st['count'] += 1
            if is_out:
                st['out'] += 1
                out += 1
                if st['first_time'] is None or ts < st['first_time']:
                    st['first_time'] = ts
            else:
                st['inc'] += 1
                inc += 1
            if 'R' in fl:
                st['rst'] += 1
                rst += 1
            total += 1
            if t_start is None or ts < t_start:
                t_start = ts
            if t_end is None or ts > t_end:
                t_end = ts

        return {
            'ip': ip, 'date_str': date_str, 'dt': dt, 'size': os.path.getsize(filepath),
            'server': server, 'target_ips': target_ips, 'client_ip': client_ip,
            'port_stats': port_stats,
            'totals': {'ports': len(port_stats), 'packets': total, 'out': out,
                       'inc': inc, 'rst': rst, 't_start': t_start, 't_end': t_end},
        }

    def _parse_filename(self, fname):
        """从 IP_YYYYMMDD_HHMMSS.(pcap|log) 解析出 (ip, 日期字符串, datetime)"""
        base = os.path.splitext(fname)[0]
        m = re.match(r'(\d+\.\d+\.\d+\.\d+)_(\d{8})_(\d{6})', base)
        if m:
            ip, d, t = m.groups()
            try:
                dt = datetime.strptime(d + t, '%Y%m%d%H%M%S')
                date_str = dt.strftime('%Y-%m-%d %H:%M:%S')
            except Exception:
                dt, date_str = None, f"{d} {t}"
            return ip, date_str, dt
        return None, '', None

    # ---------------- 列表渲染 ----------------
    def _sorted_file_keys(self):
        col = self.sort_column

        def sort_key(k):
            f = self.files[k]
            if col == 'ip':
                return f.get('ip') or ''
            if col == 'ports':
                return f.get('totals', {}).get('ports', 0)
            if col == 'packets':
                return f.get('totals', {}).get('packets', 0)
            return f.get('dt') or datetime.max  # date

        return sorted(self.files.keys(), key=sort_key, reverse=self.sort_reverse)

    def refresh_tree(self):
        """全量重建左侧树（用于排序/筛选/扫描完成归位）。
        只重建父行 + 占位 dummy，端口子行仍走懒展开，避免一次性插入海量行。"""
        for iid in self.ip_tree.get_children():
            self.ip_tree.delete(iid)
        self.node_info.clear()

        shown = 0
        for key in self._sorted_file_keys():
            f = self.files[key]
            if not f.get('scanned'):
                continue  # 未扫描完成的暂不显示，完成后由 drain 增量插入
            if not self._passes_filter(key):
                continue
            f['iid'] = None   # 强制重新插入并刷新 node_info
            self._insert_or_update_file_row(key)
            shown += 1

        total_pkts = sum(f.get('totals', {}).get('packets', 0)
                         for f in self.files.values() if f.get('scanned') and not f.get('error'))
        self.list_info_label.config(
            text=f"共 {len(self.files)} 个文件 (显示 {shown}), {total_pkts} 条记录")

    def filter_ips(self, *args):
        """按 IP 过滤列表（防抖，避免大量文件时每次按键都重建）"""
        if self._search_after:
            self.after_cancel(self._search_after)
        self._search_after = self.after(300, self._do_filter)

    def _do_filter(self):
        self._search_after = None
        self.refresh_tree()

    def on_date_selected(self, event=None):
        """日期下拉变化 -> 立即重建列表"""
        self.refresh_tree()

    def _file_day(self, info):
        """文件所属日期（YYYY-MM-DD）；解析不到的归入“未知日期”"""
        dt = info.get('dt')
        return dt.strftime('%Y-%m-%d') if dt else '未知日期'

    def _passes_filter(self, key):
        """是否同时满足 IP 搜索 + 日期下拉两个条件（AND）"""
        info = self.files[key]
        ip = info.get('ip') or os.path.basename(key)
        search = self.search_var.get().strip().lower()
        if search and search not in ip.lower():
            return False
        day = self.date_var.get()
        if day and day != '全部日期' and self._file_day(info) != day:
            return False
        return True

    def _refresh_date_choices(self):
        """根据已扫描文件刷新日期下拉候选；保留当前选中（失效则回到“全部日期”）"""
        days = {self._file_day(f) for f in self.files.values()
                if f.get('scanned') and not f.get('error')}
        real = sorted((d for d in days if d != '未知日期'), reverse=True)
        ordered = ['全部日期'] + real + (['未知日期'] if '未知日期' in days else [])
        self.date_combo['values'] = ordered
        if self.date_var.get() not in ordered:
            self.date_var.set('全部日期')

    def sort_by(self, col):
        if self.sort_column == col:
            self.sort_reverse = not self.sort_reverse
        else:
            self.sort_column = col
            self.sort_reverse = False
        self.refresh_tree()

    def clear_all(self):
        self.files.clear()
        self.node_info.clear()
        # 重置批量扫描状态；丢弃队列里尚未处理的旧结果
        self._scan_queue = queue.Queue()
        self._total = 0
        self._done = 0
        self._detail_raw = {}
        self._current_detail = None
        for iid in self.ip_tree.get_children():
            self.ip_tree.delete(iid)
        for iid in self.detail_tree.get_children():
            self.detail_tree.delete(iid)
        self.date_combo['values'] = ['全部日期']
        self.date_var.set('全部日期')
        self.list_info_label.config(text="共 0 个文件")
        self.detail_info_label.config(text="选择 IP 查看概览，展开后选择端口查看详情")
        self.status_label.config(text="")

    # ---------------- 选择/详情 ----------------
    def on_tree_select(self, event):
        sel = self.ip_tree.selection()
        if not sel:
            return
        info = self.node_info.get(sel[0])
        if not info:
            return
        if info['type'] == 'file':
            self.show_file_overview(info['key'])
        else:
            self.show_port_details(info['key'], info['port'])

    def show_file_overview(self, key):
        """选中文件(IP)行时，右侧显示该文件的概览"""
        for iid in self.detail_tree.get_children():
            self.detail_tree.delete(iid)
        self._detail_raw = {}
        self._current_detail = None
        f = self.files.get(key)
        if not f or not f.get('scanned'):
            self.detail_info_label.config(text="解析中...")
            return
        if f.get('error'):
            self.detail_info_label.config(text=f"解析失败: {f['error']}")
            return
        t = f['totals']
        span = '-'
        if t['t_start'] and t['t_end']:
            span = f"{t['t_start'].strftime('%H:%M:%S')} ~ {t['t_end'].strftime('%H:%M:%S')}"
        targets = ', '.join(f.get('target_ips') or []) or '-'
        self.detail_info_label.config(
            text=(f"{f.get('ip')} | 端口 {t['ports']} | 包 {t['packets']} "
                  f"(发 {t['out']}/收 {t['inc']}/RST {t['rst']}) | {span} | 目标: {targets}")
        )

    def show_port_details(self, key, port):
        """选中端口行时，懒解析该文件并显示该端口逐包详情"""
        f = self.files.get(key)
        if not f:
            return
        if not f.get('parsed'):
            self.detail_info_label.config(text="正在解析该文件...")
            self.update_idletasks()
            try:
                f['port_data'] = self._parse_file_full(key, f.get('client_ip'))
                f['parsed'] = True
            except Exception as e:
                self.detail_info_label.config(text=f"解析失败: {e}")
                return

        for iid in self.detail_tree.get_children():
            self.detail_tree.delete(iid)
        self._detail_raw = {}
        self._current_detail = (key, port)

        packets = (f['port_data'] or {}).get(port, [])
        for p in packets:
            is_out = p['is_outgoing']
            direction = "→" if is_out else "←"
            flags = p['flags']

            if 'R' in flags:
                tag = 'rst'
            elif 'S' in flags and '.' not in flags:
                tag = 'syn'
            elif 'F' in flags:
                tag = 'fin'
            elif is_out:
                tag = 'outgoing'
            else:
                tag = 'incoming'

            time_str = p['timestamp'].strftime('%H:%M:%S.%f')[:-3]
            src = f"{p['src_ip']}:{p['src_port']}"
            dst = f"{p['dst_ip']}:{p['dst_port']}"

            iid = self.detail_tree.insert('', tk.END, values=(
                time_str, direction, src, dst, flags, p['seq'], p['length'], p['info']
            ), tags=(tag,))
            self._detail_raw[iid] = p.get('raw', '')

        self.detail_info_label.config(text=f"{f.get('ip')} 端口 {port}: {len(packets)} 条记录")

    def _parse_file_full(self, filepath, client_ip):
        """完整解析单个文件，返回 {port: [packet,...]}（含逐包字段）。pcap 走 tshark。"""
        if filepath.lower().endswith(('.pcap', '.pcapng', '.cap')):
            all_packets = self._tshark_packets(filepath)
        else:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as fobj:
                content = fobj.read()

            all_packets = []
            for line in content.replace('\r\n', '\n').split('\n'):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                m = self.TCPDUMP_PATTERN.match(line)
                if not m:
                    continue
                ts_str, src_ip, src_port, dst_ip, dst_port, details = m.groups()
                try:
                    ts = datetime.strptime(ts_str, '%Y-%m-%d %H:%M:%S.%f')
                except Exception:
                    continue
                flags_m = re.search(r'Flags \[([^\]]+)\]', details)
                flags = flags_m.group(1) if flags_m else ''
                seq_m = re.search(r'seq\s+(\d+(?::\d+)?)', details)
                seq = seq_m.group(1) if seq_m else ''
                len_m = re.search(r'length\s+(\d+)', details)
                length = len_m.group(1) if len_m else '0'
                all_packets.append({
                    'timestamp': ts, 'src_ip': src_ip, 'src_port': src_port,
                    'dst_ip': dst_ip, 'dst_port': dst_port, 'flags': flags,
                    'seq': seq, 'length': length, 'info': details[:100],
                    'raw': line,
                })

        if client_ip is None and all_packets:
            cnt = defaultdict(int)
            for p in all_packets:
                if int(p['src_port']) > 1024:
                    cnt[p['src_ip']] += 1
                if int(p['dst_port']) > 1024:
                    cnt[p['dst_ip']] += 1
            if cnt:
                client_ip = max(cnt, key=lambda k: cnt[k])

        port_data = {}
        for p in all_packets:
            if p['src_ip'] == client_ip:
                port, p['is_outgoing'] = p['src_port'], True
            elif p['dst_ip'] == client_ip:
                port, p['is_outgoing'] = p['dst_port'], False
            else:
                continue
            port_data.setdefault(port, []).append(p)
        for port in port_data:
            port_data[port].sort(key=lambda x: x['timestamp'])
        return port_data

    # ---------------- 复制 ----------------
    def _to_clipboard(self, text):
        self.clipboard_clear()
        self.clipboard_append(text)

    def _copy_port_raw(self, key, port):
        """复制某文件某端口的全部原始 tcpdump 行（必要时先懒解析）"""
        f = self.files.get(key)
        if not f:
            return
        if not f.get('parsed'):
            try:
                f['port_data'] = self._parse_file_full(key, f.get('client_ip'))
                f['parsed'] = True
            except Exception as e:
                messagebox.showerror("错误", f"解析失败: {e}")
                return
        packets = (f.get('port_data') or {}).get(port, [])
        if not packets:
            messagebox.showinfo("提示", f"端口 {port} 没有可复制的数据")
            return
        lines = [
            f"# IP: {f.get('ip')}  日期: {f.get('date_str', '')}",
            f"# 端口: {port}  包数: {len(packets)}",
            "# " + "=" * 60,
        ]
        lines += [p.get('raw', '') for p in packets]
        self._to_clipboard('\n'.join(lines))
        self.status_label.config(text=f"已复制端口 {port} 的 {len(packets)} 条原始日志")

    def _on_ip_tree_menu(self, event):
        """IP 树右键：仅端口子行弹出“复制该端口全部日志”"""
        row = self.ip_tree.identify_row(event.y)
        if not row:
            return
        info = self.node_info.get(row)
        if not info or info['type'] != 'port':
            return
        self.ip_tree.selection_set(row)
        self.ip_tree.focus(row)
        self._menu_target = (info['key'], info['port'])
        self.ip_menu.post(event.x_root, event.y_root)

    def _copy_menu_target(self):
        if self._menu_target:
            self._copy_port_raw(*self._menu_target)

    def _select_all_details(self, event=None):
        """详情区全选（Ctrl+A）"""
        items = self.detail_tree.get_children()
        if items:
            self.detail_tree.selection_set(items)
        return 'break'

    def _ordered_detail_selection(self):
        """按表中顺序返回当前选中的详情行 iid"""
        sel = set(self.detail_tree.selection())
        return [iid for iid in self.detail_tree.get_children() if iid in sel]

    def _copy_detail_selected(self, event=None):
        """复制选中详情行对应的原始 tcpdump 行（Ctrl+C / 右键）"""
        sel = self._ordered_detail_selection()
        if not sel:
            return 'break'
        lines = [self._detail_raw.get(iid, '') for iid in sel]
        text = '\n'.join(l for l in lines if l)
        if text:
            self._to_clipboard(text)
            self.status_label.config(text=f"已复制 {len(sel)} 条原始日志")
        return 'break'

    def _copy_detail_all(self):
        """复制当前端口全部原始日志行"""
        items = self.detail_tree.get_children()
        lines = [self._detail_raw.get(iid, '') for iid in items]
        text = '\n'.join(l for l in lines if l)
        if not text:
            return
        self._to_clipboard(text)
        self.status_label.config(text=f"已复制全部 {len(items)} 条原始日志")

    def _on_detail_menu(self, event):
        """详情区右键菜单：未点中选中项时先选中点击行"""
        row = self.detail_tree.identify_row(event.y)
        if row and row not in self.detail_tree.selection():
            self.detail_tree.selection_set(row)
        self.detail_menu.post(event.x_root, event.y_root)


class ProxyManagerGUI:
    def __init__(self, root):
        self.root = root
        self.root.title(f"SOCKS5 代理管理器 v3.9")
        self.root.geometry("1100x750")
        self.root.minsize(900, 650)

        self.manager = None
        self.init_thread = None
        self.is_running = True
        self.list_refresh_timer = None

        self.selected_proxy_ids = set()
        self.agent_selected_ids = set()
        self.agent_manager = None

        # 流量日志目录已改为下载时弹 askdirectory 选择（默认起点取自系统配置 tab Entry 实时值）；
        # 这里不再缓存 self.log_dir、也不预创建目录——目录由用户在 dialog 里点选时确认存在。

        self.create_widgets()
        set_gui_callback(self.on_log_message)
        self.refresh_status_loop()
        self.init_manager_async()
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

    def create_widgets(self):
        self.main_frame = ttk.Frame(self.root, padding="5")
        self.main_frame.pack(fill=tk.BOTH, expand=True)

        self.create_status_bar()

        self.paned = ttk.PanedWindow(self.main_frame, orient=tk.VERTICAL)
        self.paned.pack(fill=tk.BOTH, expand=True, pady=5)

        self.notebook = ttk.Notebook(self.paned)
        self.paned.add(self.notebook, weight=1)

        self.create_proxy_tab()
        self.create_traffic_tab()
        self.create_agent_tab()
        self.create_config_tab()

        self.notebook.bind('<<NotebookTabChanged>>', self._on_notebook_tab_changed)

        self.create_log_area()

    def create_status_bar(self):
        status_frame = ttk.LabelFrame(self.main_frame, text="系统状态", padding="5")
        status_frame.pack(fill=tk.X, pady=(0, 5))

        row1 = ttk.Frame(status_frame)
        row1.pack(fill=tk.X)

        self.time_label = ttk.Label(row1, text="北京时间: --:--:--", font=("Consolas", 10))
        self.time_label.pack(side=tk.LEFT, padx=10)

        self.proxy_status_label = ttk.Label(row1, text="代理: -/- 活跃", font=("Consolas", 10))
        self.proxy_status_label.pack(side=tk.LEFT, padx=10)

        self.keepalive_status_label = ttk.Label(row1, text="保活: --", font=("Consolas", 10))
        self.keepalive_status_label.pack(side=tk.LEFT, padx=10)

        self.init_status_label = ttk.Label(row1, text="初始化中...", font=("Consolas", 10), foreground="orange")
        self.init_status_label.pack(side=tk.RIGHT, padx=10)

    def create_proxy_tab(self):
        proxy_frame = ttk.Frame(self.notebook, padding="5")
        self.notebook.add(proxy_frame, text="📡 代理管理")

        left_frame = ttk.LabelFrame(proxy_frame, text="代理列表 (点击选择，点击组名可修改)", padding="5")
        left_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # 筛选和选择行
        select_frame = ttk.Frame(left_frame)
        select_frame.pack(fill=tk.X, pady=(0, 5))

        ttk.Button(select_frame, text="全选", width=6, command=self.select_all_proxies).pack(side=tk.LEFT, padx=2)
        ttk.Button(select_frame, text="取消", width=6, command=self.deselect_all_proxies).pack(side=tk.LEFT, padx=2)
        self.select_count_label = ttk.Label(select_frame, text="已选: 0", foreground="blue")
        self.select_count_label.pack(side=tk.LEFT, padx=10)

        # ── 筛选栏 ──
        ttk.Separator(select_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=5)

        ttk.Label(select_frame, text="组:").pack(side=tk.LEFT, padx=(5, 1))
        self.group_filter_var = tk.StringVar(value="全部")
        self.group_filter_combo = ttk.Combobox(select_frame, textvariable=self.group_filter_var, width=8,
                                               state="readonly")
        self.group_filter_combo['values'] = ["全部"]
        self.group_filter_combo.pack(side=tk.LEFT, padx=1)
        self.group_filter_combo.bind('<<ComboboxSelected>>', self.on_proxy_filter_change)

        ttk.Label(select_frame, text="状态:").pack(side=tk.LEFT, padx=(5, 1))
        self.status_filter_var = tk.StringVar(value="全部")
        self.status_filter_combo = ttk.Combobox(select_frame, textvariable=self.status_filter_var, width=8,
                                                state="readonly")
        self.status_filter_combo['values'] = ["全部", "活跃", "离线"]
        self.status_filter_combo.pack(side=tk.LEFT, padx=1)
        self.status_filter_combo.bind('<<ComboboxSelected>>', self.on_proxy_filter_change)

        ttk.Label(select_frame, text="平台:").pack(side=tk.LEFT, padx=(5, 1))
        self.platform_filter_var = tk.StringVar(value="全部")
        self.platform_filter_combo = ttk.Combobox(select_frame, textvariable=self.platform_filter_var, width=8,
                                                  state="readonly")
        self.platform_filter_combo['values'] = ["全部", "阿里云", "腾讯云", "本机", "其他"]
        self.platform_filter_combo.pack(side=tk.LEFT, padx=1)
        self.platform_filter_combo.bind('<<ComboboxSelected>>', self.on_proxy_filter_change)

        ttk.Label(select_frame, text="部署:").pack(side=tk.LEFT, padx=(5, 1))
        self.deploy_filter_var = tk.StringVar(value="全部")
        self.deploy_filter_combo = ttk.Combobox(select_frame, textvariable=self.deploy_filter_var, width=8,
                                                state="readonly")
        self.deploy_filter_combo['values'] = ["全部", "✅ 成功", "❌ 失败", "未部署"]
        self.deploy_filter_combo.pack(side=tk.LEFT, padx=1)
        self.deploy_filter_combo.bind('<<ComboboxSelected>>', self.on_proxy_filter_change)

        ttk.Label(select_frame, text="IP:").pack(side=tk.LEFT, padx=(5, 1))
        self.ip_filter_var = tk.StringVar()
        self.ip_filter_entry = ttk.Entry(select_frame, textvariable=self.ip_filter_var, width=12)
        self.ip_filter_entry.pack(side=tk.LEFT, padx=1)
        self.ip_filter_var.trace_add('write', self._on_ip_filter_input)

        # 代理列表 - 增加 服务器平台 / 部署状态 两列只读
        columns = ("选择", "ID", "名称", "端口", "服务器IP", "组", "服务器平台", "部署状态", "状态", "检查时间")
        self.proxy_tree = ttk.Treeview(left_frame, columns=columns, show="headings", height=10)

        self.proxy_tree.heading("选择", text="✓")
        self.proxy_tree.heading("ID", text="ID")
        self.proxy_tree.heading("名称", text="名称")
        self.proxy_tree.heading("端口", text="端口")
        self.proxy_tree.heading("服务器IP", text="服务器IP")
        self.proxy_tree.heading("组", text="组")
        self.proxy_tree.heading("服务器平台", text="服务器平台")
        self.proxy_tree.heading("部署状态", text="部署状态")
        self.proxy_tree.heading("状态", text="状态")
        self.proxy_tree.heading("检查时间", text="检查时间")

        self.proxy_tree.column("选择", width=30, anchor="center")
        self.proxy_tree.column("ID", width=30, anchor="center")
        self.proxy_tree.column("名称", width=70)
        self.proxy_tree.column("端口", width=50, anchor="center")
        self.proxy_tree.column("服务器IP", width=100)
        self.proxy_tree.column("组", width=50, anchor="center")
        self.proxy_tree.column("服务器平台", width=70, anchor="center")
        self.proxy_tree.column("部署状态", width=65, anchor="center")
        self.proxy_tree.column("状态", width=55, anchor="center")
        self.proxy_tree.column("检查时间", width=65, anchor="center")

        self.proxy_tree.bind('<ButtonRelease-1>', self.on_proxy_click)
        self.proxy_tree.bind('<Button-3>', self._on_proxy_right_click)      # 右键复制 IP

        scrollbar = ttk.Scrollbar(left_frame, orient=tk.VERTICAL, command=self.proxy_tree.yview)
        self.proxy_tree.configure(yscrollcommand=scrollbar.set)

        self.proxy_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        right_frame = ttk.Frame(proxy_frame)
        right_frame.pack(side=tk.RIGHT, fill=tk.Y, padx=(10, 0))

        basic_frame = ttk.LabelFrame(right_frame, text="基本操作", padding="5")
        basic_frame.pack(fill=tk.X, pady=(0, 5))

        btn_width = 14

        ttk.Button(basic_frame, text="🔄 刷新", width=btn_width, command=self.refresh_proxy_list).pack(pady=2)
        ttk.Button(basic_frame, text="▶️ 启动所有", width=btn_width, command=self.start_all_proxies).pack(pady=2)
        ttk.Button(basic_frame, text="⏹️ 停止所有", width=btn_width, command=self.stop_all_proxies).pack(pady=2)

        single_frame = ttk.LabelFrame(right_frame, text="选中操作", padding="5")
        single_frame.pack(fill=tk.X, pady=(0, 5))

        ttk.Button(single_frame, text="🔍 测试选中", width=btn_width, command=self.test_selected_proxies).pack(pady=2)
        ttk.Button(single_frame, text="📋 复制IP", width=btn_width, command=self._copy_proxy_ips).pack(pady=2)
        ttk.Button(single_frame, text="❌ 删除选中", width=btn_width, command=self.delete_selected_proxies).pack(pady=2)

        batch_frame = ttk.LabelFrame(right_frame, text="批量操作", padding="5")
        batch_frame.pack(fill=tk.X)

        ttk.Button(batch_frame, text="➕ 添加代理", width=btn_width, command=self.show_batch_add_dialog).pack(pady=2)
        ttk.Button(batch_frame, text="🌐 检测连通性", width=btn_width, command=self.batch_check_connectivity).pack(
            pady=2)
        ttk.Button(batch_frame, text="▶️ 启动心跳", width=btn_width, command=self.start_keepalive).pack(pady=2)
        ttk.Button(batch_frame, text="⏹️ 停止心跳", width=btn_width, command=self.stop_keepalive).pack(pady=2)
        ttk.Button(batch_frame, text="💓 手动发送心跳", width=btn_width, command=self.manual_keepalive).pack(pady=2)

    def create_traffic_tab(self):
        """创建流量监控选项卡 - 带checkbox选择"""
        traffic_frame = ttk.Frame(self.notebook, padding="5")
        self.notebook.add(traffic_frame, text="📊 流量监控")

        # 流量监控选中集合
        self.traffic_selected_servers = set()

        # 服务器列表
        list_frame = ttk.LabelFrame(traffic_frame, text="监控服务器 (右键查看日志，双击下载分析)", padding="5")
        list_frame.pack(fill=tk.BOTH, expand=True)

        # 操作按钮
        btn_frame = ttk.Frame(list_frame)
        btn_frame.pack(fill=tk.X, pady=(0, 5))

        ttk.Button(btn_frame, text="☑ 全选", command=self.traffic_select_all).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="☐ 取消", command=self.traffic_deselect_all).pack(side=tk.LEFT, padx=2)
        ttk.Separator(btn_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=5)
        ttk.Button(btn_frame, text="▶️ 启动选中", command=self.start_selected_monitors).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="⏹️ 停止选中", command=self.stop_selected_monitors).pack(side=tk.LEFT, padx=2)
        ttk.Separator(btn_frame, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=5)
        ttk.Button(btn_frame, text="📥 下载所有日志", command=self.download_all_logs).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="📊 日志分析", command=self.open_log_analyzer).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="📂 打开日志目录", command=self.open_log_directory).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="🔄 刷新", command=self.refresh_traffic_list).pack(side=tk.LEFT, padx=2)

        # 选中计数
        self.traffic_select_label = ttk.Label(btn_frame, text="已选: 0")
        self.traffic_select_label.pack(side=tk.RIGHT, padx=10)

        # 服务器列表 - 带checkbox列和组列
        columns = ("选择", "服务器IP", "代理名称", "组", "本地端口", "监控状态")
        self.traffic_tree = ttk.Treeview(list_frame, columns=columns, show="headings", height=12)

        self.traffic_tree.heading("选择", text="☐")
        self.traffic_tree.heading("服务器IP", text="服务器IP")
        self.traffic_tree.heading("代理名称", text="代理名称")
        self.traffic_tree.heading("组", text="组")
        self.traffic_tree.heading("本地端口", text="本地端口")
        self.traffic_tree.heading("监控状态", text="监控状态")

        self.traffic_tree.column("选择", width=40, anchor="center")
        self.traffic_tree.column("服务器IP", width=130)
        self.traffic_tree.column("代理名称", width=100)
        self.traffic_tree.column("组", width=50, anchor="center")
        self.traffic_tree.column("本地端口", width=80, anchor="center")
        self.traffic_tree.column("监控状态", width=100, anchor="center")

        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.traffic_tree.yview)
        self.traffic_tree.configure(yscrollcommand=scrollbar.set)

        self.traffic_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # 绑定点击事件
        self.traffic_tree.bind('<ButtonRelease-1>', self.on_traffic_click)
        self.traffic_tree.bind('<Button-3>', self.show_traffic_context_menu)
        self.traffic_tree.bind('<Double-1>', self.on_traffic_double_click)

        # 右键菜单
        self.traffic_context_menu = tk.Menu(self.root, tearoff=0)
        self.traffic_context_menu.add_command(label="📥 下载日志", command=self.download_server_log)
        self.traffic_context_menu.add_command(label="📂 查看历史日志", command=self.show_server_logs)
        self.traffic_context_menu.add_separator()
        self.traffic_context_menu.add_command(label="▶️ 启动监控", command=self.start_single_monitor)
        self.traffic_context_menu.add_command(label="⏹️ 停止监控", command=self.stop_single_monitor)

        # 目标IP配置
        config_frame = ttk.LabelFrame(traffic_frame, text="监控配置", padding="5")
        config_frame.pack(fill=tk.X, pady=(10, 0))

        ip_row = ttk.Frame(config_frame)
        ip_row.pack(fill=tk.X)

        ttk.Label(ip_row, text="目标IP:").pack(side=tk.LEFT)
        self.target_ips_var = tk.StringVar(value=", ".join(TRAFFIC_TARGET_IPS))
        ttk.Entry(ip_row, textvariable=self.target_ips_var, width=50).pack(side=tk.LEFT, padx=5, fill=tk.X, expand=True)
        ttk.Label(ip_row, text="(监控与这些IP的通信)", foreground="gray").pack(side=tk.LEFT, padx=5)

    def on_traffic_click(self, event):
        """流量监控列表点击事件"""
        region = self.traffic_tree.identify_region(event.x, event.y)
        if region != "cell":
            return

        column = self.traffic_tree.identify_column(event.x)
        item = self.traffic_tree.identify_row(event.y)

        if not item:
            return

        values = self.traffic_tree.item(item, 'values')
        if not values:
            return

        server_ip = values[1]

        # 点击选择列或任意位置都切换选中状态
        if column == '#1':  # 选择列
            if server_ip in self.traffic_selected_servers:
                self.traffic_selected_servers.discard(server_ip)
            else:
                self.traffic_selected_servers.add(server_ip)
            self.refresh_traffic_list()

    def traffic_select_all(self):
        """全选流量监控服务器"""
        for item in self.traffic_tree.get_children():
            values = self.traffic_tree.item(item, 'values')
            if values:
                self.traffic_selected_servers.add(values[1])
        self.refresh_traffic_list()

    def traffic_deselect_all(self):
        """取消全选"""
        self.traffic_selected_servers.clear()
        self.refresh_traffic_list()

    def start_selected_monitors(self):
        """启动选中的服务器监控"""
        if not self.traffic_selected_servers:
            messagebox.showwarning("警告", "请先选择服务器")
            return

        def do_start():
            from logger import info
            info(f"启动 {len(self.traffic_selected_servers)} 个服务器的监控...")
            for server_ip in self.traffic_selected_servers:
                proxy_info = self.get_server_proxy_info(server_ip)
                if proxy_info:
                    self.manager.traffic_monitor.start_monitor_for_server(
                        server_ip, proxy_info['username'], proxy_info['password'],
                        TRAFFIC_TARGET_IPS, server_port=proxy_info['port']
                    )
            self.root.after(0, self.refresh_traffic_list)

        self.run_async(do_start)

    def stop_selected_monitors(self):
        """停止选中的服务器监控"""
        if not self.traffic_selected_servers:
            messagebox.showwarning("警告", "请先选择服务器")
            return

        def do_stop():
            from logger import info
            info(f"停止 {len(self.traffic_selected_servers)} 个服务器的监控...")
            for server_ip in self.traffic_selected_servers:
                proxy_info = self.get_server_proxy_info(server_ip)
                if proxy_info:
                    self.manager.traffic_monitor.stop_monitor_for_server(
                        server_ip, proxy_info['username'], proxy_info['password'],
                        server_port=proxy_info['port']
                    )
            self.root.after(0, self.refresh_traffic_list)

        self.run_async(do_stop)

    def create_config_tab(self):
        """创建系统配置选项卡"""
        config_frame = ttk.Frame(self.notebook, padding="10")
        self.notebook.add(config_frame, text="🛠️系统配置")

        # 持久化配置外层 LabelFrame：把"代理测试配置"和"并发与心跳配置"两个子块都套进来，
        # 保存按钮放在外层底部，明确"保存"覆盖的是这里面所有项。
        persist_frame = ttk.LabelFrame(config_frame, text="持久化配置 (写入 user_settings.json)", padding="10")
        persist_frame.pack(fill=tk.X, pady=5)

        # 代理测试配置（子块）
        test_frame = ttk.LabelFrame(persist_frame, text="代理测试配置", padding="10")
        test_frame.pack(fill=tk.X, pady=3)

        row1 = ttk.Frame(test_frame)
        row1.pack(fill=tk.X, pady=3)

        ttk.Label(row1, text="测试URL:").pack(side=tk.LEFT)
        self.test_url_var = tk.StringVar(value=PROXY_TEST_URL)
        ttk.Entry(row1, textvariable=self.test_url_var, width=35).pack(side=tk.LEFT, padx=5)

        ttk.Label(row1, text="超时(秒):").pack(side=tk.LEFT, padx=(15, 0))
        self.test_timeout_var = tk.StringVar(value=str(PROXY_TEST_TIMEOUT))
        ttk.Entry(row1, textvariable=self.test_timeout_var, width=8).pack(side=tk.LEFT, padx=5)

        # 并发与心跳配置（子块）
        perf_frame = ttk.LabelFrame(persist_frame, text="并发与心跳配置", padding="10")
        perf_frame.pack(fill=tk.X, pady=3)

        row2 = ttk.Frame(perf_frame)
        row2.pack(fill=tk.X, pady=3)

        ttk.Label(row2, text="并发线程数:").pack(side=tk.LEFT)
        self.max_workers_var = tk.StringVar(value=str(MAX_WORKERS))
        ttk.Entry(row2, textvariable=self.max_workers_var, width=8).pack(side=tk.LEFT, padx=5)

        ttk.Label(row2, text="心跳间隔(秒):").pack(side=tk.LEFT, padx=(15, 0))
        self.keepalive_interval_var = tk.StringVar(value=str(KEEPALIVE_INTERVAL))
        ttk.Entry(row2, textvariable=self.keepalive_interval_var, width=8).pack(side=tk.LEFT, padx=5)

        ttk.Label(row2, text="Agent部署并发:").pack(side=tk.LEFT, padx=(15, 0))
        self.agent_deploy_workers_var = tk.StringVar(value=str(AGENT_DEPLOY_WORKERS))
        ttk.Entry(row2, textvariable=self.agent_deploy_workers_var, width=8).pack(side=tk.LEFT, padx=5)

        # 本地下载目录（子块）：与上面两块并列，归属同一外层 LabelFrame，统一由"保存全部配置"提交
        dirs_frame = ttk.LabelFrame(persist_frame, text="本地下载目录", padding="10")
        dirs_frame.pack(fill=tk.X, pady=3)

        row_agent = ttk.Frame(dirs_frame)
        row_agent.pack(fill=tk.X, pady=3)
        ttk.Label(row_agent, text="Agent 日志目录:", width=14, anchor=tk.W).pack(side=tk.LEFT)
        self.agent_log_save_dir_var = tk.StringVar(value=AGENT_LOG_SAVE_DIR)
        ttk.Entry(row_agent, textvariable=self.agent_log_save_dir_var).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5)
        ttk.Button(
            row_agent, text="📂 浏览…",
            command=lambda v=self.agent_log_save_dir_var: self._browse_directory(v),
        ).pack(side=tk.LEFT, padx=5)

        row_traffic = ttk.Frame(dirs_frame)
        row_traffic.pack(fill=tk.X, pady=3)
        ttk.Label(row_traffic, text="流量日志目录:", width=14, anchor=tk.W).pack(side=tk.LEFT)
        self.traffic_log_save_dir_var = tk.StringVar(value=TRAFFIC_LOG_SAVE_DIR)
        ttk.Entry(row_traffic, textvariable=self.traffic_log_save_dir_var).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5)
        ttk.Button(
            row_traffic, text="📂 浏览…",
            command=lambda v=self.traffic_log_save_dir_var: self._browse_directory(v),
        ).pack(side=tk.LEFT, padx=5)

        # 部署源配置（子块）
        deploy_cfg_frame = ttk.LabelFrame(persist_frame, text="部署源配置", padding="10")
        deploy_cfg_frame.pack(fill=tk.X, pady=3)

        row_github = ttk.Frame(deploy_cfg_frame)
        row_github.pack(fill=tk.X, pady=3)
        ttk.Label(row_github, text="GitHub 仓库 URL:", width=14, anchor=tk.W).pack(side=tk.LEFT)
        from config import GITHUB_REPO_URL
        self.github_repo_url_var = tk.StringVar(value=GITHUB_REPO_URL)
        ttk.Entry(row_github, textvariable=self.github_repo_url_var).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5)

        row_local = ttk.Frame(deploy_cfg_frame)
        row_local.pack(fill=tk.X, pady=3)
        ttk.Label(row_local, text="本机部署目录:", width=14, anchor=tk.W).pack(side=tk.LEFT)
        from config import LOCAL_DEPLOY_DIR
        self.local_deploy_dir_var = tk.StringVar(value=LOCAL_DEPLOY_DIR)
        ttk.Entry(row_local, textvariable=self.local_deploy_dir_var).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5)
        ttk.Button(
            row_local, text="📂 浏览…",
            command=lambda v=self.local_deploy_dir_var: self._browse_directory(v),
        ).pack(side=tk.LEFT, padx=5)

        # 保存按钮放在外层 LabelFrame 底部右侧——视觉上明显隶属整个"持久化配置"块
        save_row = ttk.Frame(persist_frame)
        save_row.pack(fill=tk.X, pady=(8, 0))
        ttk.Button(save_row, text="💾 保存全部配置", command=self.save_user_settings).pack(side=tk.RIGHT, padx=5)

    def _browse_directory(self, var):
        """通用目录选择：弹 askdirectory 并把选中路径写回 StringVar。"""
        initial = (var.get() or '').strip() or os.path.expanduser('~')
        chosen = filedialog.askdirectory(initialdir=initial)
        if chosen:
            # askdirectory 在 Windows 返回正斜杠，转回 OS 习惯路径
            var.set(os.path.normpath(chosen))

    def _ask_download_dir(self, var, title='选择保存目录'):
        """下载前置：弹 askdirectory，initialdir 取 StringVar 实时值；用户取消返回 None。"""
        initial = (var.get() or '').strip() or os.path.expanduser('~')
        chosen = filedialog.askdirectory(initialdir=initial, title=title)
        return os.path.normpath(chosen) if chosen else None

    def save_user_settings(self):
        """校验并把 GUI 持久化配置块内所有项写入 user_settings.json（原子写）。"""
        try:
            test_url = self.test_url_var.get().strip()
            test_timeout = int(self.test_timeout_var.get())
            max_workers = int(self.max_workers_var.get())
            keepalive_interval = int(self.keepalive_interval_var.get())
            agent_deploy_workers = int(self.agent_deploy_workers_var.get())
        except (TypeError, ValueError):
            messagebox.showerror("错误", "数值字段必须是整数（测试超时、并发线程数、心跳间隔、Agent 部署并发）")
            return

        agent_log_save_dir = self.agent_log_save_dir_var.get().strip()
        traffic_log_save_dir = self.traffic_log_save_dir_var.get().strip()
        github_repo_url = self.github_repo_url_var.get().strip()
        local_deploy_dir = self.local_deploy_dir_var.get().strip()

        # 校验
        if not test_url or not (test_url.startswith("http://") or test_url.startswith("https://")):
            messagebox.showerror("错误", "测试URL 必须以 http:// 或 https:// 开头")
            return
        if not (1 <= test_timeout <= 60):
            messagebox.showerror("错误", "测试超时必须在 1 ~ 60 秒之间")
            return
        if not (1 <= max_workers <= 500):
            messagebox.showerror("错误", "并发线程数必须在 1 ~ 500 之间")
            return
        if keepalive_interval < 30:
            messagebox.showerror("错误", "心跳间隔不能小于 30 秒")
            return
        if not (1 <= agent_deploy_workers <= 5000):
            messagebox.showerror("错误", "Agent 部署并发必须在 1 ~ 5000 之间")
            return
        if not agent_log_save_dir:
            messagebox.showerror("错误", "Agent 日志目录不能为空")
            return
        if not traffic_log_save_dir:
            messagebox.showerror("错误", "流量日志目录不能为空")
            return
        if not github_repo_url or not (github_repo_url.startswith("http://") or github_repo_url.startswith("https://")):
            messagebox.showerror("错误", "GitHub URL 必须以 http:// 或 https:// 开头")
            return
        if not local_deploy_dir:
            messagebox.showerror("错误", "本机部署目录不能为空")
            return

        settings = {
            "proxy_test_url": test_url,
            "proxy_test_timeout": test_timeout,
            "max_workers": max_workers,
            "keepalive_interval": keepalive_interval,
            "agent_deploy_workers": agent_deploy_workers,
            "agent_log_save_dir": agent_log_save_dir,
            "traffic_log_save_dir": traffic_log_save_dir,
            "github_repo_url": github_repo_url,
            "local_deploy_dir": local_deploy_dir,
        }

        # 与 config.py 的 loader 用同一份路径（_app_root 决定的 EXE 同目录 / 项目目录）
        from config import _SETTINGS_FILE as settings_file
        tmp = settings_file + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(settings, f, indent=2, ensure_ascii=False)
            os.replace(tmp, settings_file)
        except OSError as e:
            messagebox.showerror("错误", f"写入配置文件失败: {e}")
            return

        # 同步更新 config 模块的运行时值（让 LocalExecutor.resolve_dir 等立即生效）
        try:
            import config as _cfg
            _cfg._S.update(settings)
            _cfg.LOCAL_DEPLOY_DIR = local_deploy_dir
            _cfg.GITHUB_REPO_URL = github_repo_url
        except Exception:
            pass

        messagebox.showinfo(
            "已保存",
            "配置已保存到 user_settings.json\n\n"
            "立即生效：测试URL、测试超时、GitHub URL、本机部署目录\n"
            "重启后生效：并发线程数、心跳间隔、Agent 部署并发\n\n"
            "Agent / 流量日志目录：作为下载时弹出对话框的默认起点；\n"
            "修改 Entry 即生效，本次保存仅为下次启动保留默认值。"
        )

    def create_log_area(self):
        log_frame = ttk.LabelFrame(self.paned, text="系统日志", padding="5")
        self.paned.add(log_frame, weight=2)

        self.log_text = scrolledtext.ScrolledText(log_frame, wrap=tk.WORD, font=("Consolas", 9), height=10)
        self.log_text.pack(fill=tk.BOTH, expand=True)

        self.log_text.tag_configure("INFO", foreground="black")
        self.log_text.tag_configure("SUCCESS", foreground="green")
        self.log_text.tag_configure("WARNING", foreground="orange")
        self.log_text.tag_configure("ERROR", foreground="red")
        self.log_text.tag_configure("DEBUG", foreground="gray")

        btn_frame = ttk.Frame(log_frame)
        btn_frame.pack(fill=tk.X)

        ttk.Button(btn_frame, text="清空日志", command=lambda: self.log_text.delete(1.0, tk.END)).pack(side=tk.LEFT,
                                                                                                       padx=5)

        self.auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(btn_frame, text="自动滚动", variable=self.auto_scroll_var).pack(side=tk.LEFT, padx=5)

    def on_log_message(self, message, level):
        if level == LogLevel.SUCCESS:
            tag = "SUCCESS"
        elif level == LogLevel.WARNING:
            tag = "WARNING"
        elif level == LogLevel.ERROR:
            tag = "ERROR"
        elif level == LogLevel.DEBUG:
            tag = "DEBUG"
        else:
            tag = "INFO"

        def update_log():
            try:
                self.log_text.insert(tk.END, message + "\n", tag)
                if self.auto_scroll_var.get():
                    self.log_text.see(tk.END)
            except:
                pass

        self.root.after(0, update_log)

    def refresh_status_loop(self):
        if not self.is_running:
            return

        current_time = get_beijing_time_short()
        self.time_label.config(text=f"北京时间: {current_time}")

        if self.manager:
            try:
                total = len(self.manager.status_monitor.proxy_status_cache)
                active = sum(1 for s in self.manager.status_monitor.proxy_status_cache.values() if s)
                self.proxy_status_label.config(text=f"代理: {active}/{total} 活跃")

                if self.manager.status_monitor.keepalive_running:
                    self.keepalive_status_label.config(text="保活: 运行中", foreground="green")
                else:
                    self.keepalive_status_label.config(text="保活: 已停止", foreground="gray")
            except:
                pass

        self.root.after(1000, self.refresh_status_loop)

    def auto_refresh_proxy_list(self):
        if not self.is_running:
            return
        if self.manager:
            self.refresh_proxy_list_internal()
        self.list_refresh_timer = self.root.after(5000, self.auto_refresh_proxy_list)

    def init_manager_async(self):
        def init():
            try:
                from managers.proxy_manager import ProxyManager
                from managers.agent_deploy_manager import AgentDeployManager
                # ① ProxyManager 构造（DB 就绪），秒级
                self.manager = ProxyManager()
                self.agent_manager = AgentDeployManager(log_callback=self._agent_log)

                # ② 立即把列表刷出来；并启动 5s 周期刷新——start_all_proxies 跑期间状态会逐个刷新
                self.root.after(0, lambda: self.init_status_label.config(text="启动中...", foreground="orange"))
                self.root.after(0, self.refresh_proxy_list)
                self.root.after(0, self.refresh_traffic_list)
                self.root.after(5000, self.auto_refresh_proxy_list)

                # ③ 启动监控（必须在 start_all_proxies 之前，否则首次状态变更没人接）
                self.manager.start_monitor()

                # ④ 后台慢速地把所有代理起来（分钟级），列表已可见，不阻塞 UI
                self.manager.start_all_proxies(max_workers=MAX_WORKERS)

                if TRAFFIC_MONITOR_ENABLED and TRAFFIC_TARGET_IPS:
                    time.sleep(2)
                    self.manager.start_traffic_monitor_auto()

                self.root.after(0, lambda: self.init_status_label.config(text="已就绪", foreground="green"))

            except Exception as e:
                self.root.after(0, lambda: self.init_status_label.config(text="初始化失败", foreground="red"))

        self.init_thread = threading.Thread(target=init, daemon=True)
        self.init_thread.start()

    def run_async(self, func, *args, **kwargs):
        def wrapper():
            try:
                func(*args, **kwargs)
            except Exception as e:
                pass

        threading.Thread(target=wrapper, daemon=True).start()

    # ==================== 代理选择功能 ====================

    def on_proxy_click(self, event):
        region = self.proxy_tree.identify_region(event.x, event.y)
        if region == "cell":
            column = self.proxy_tree.identify_column(event.x)
            item = self.proxy_tree.identify_row(event.y)
            if item:
                values = self.proxy_tree.item(item, 'values')
                if len(values) >= 2:
                    proxy_id = int(values[1])

                    # 如果点击的是"组"列 (#6)，弹出修改组对话框
                    if column == '#6':
                        self.edit_single_proxy_group(proxy_id, values[5])  # values[5]是组名
                        return

                    # 否则是选择/取消选择操作
                    if proxy_id in self.selected_proxy_ids:
                        self.selected_proxy_ids.remove(proxy_id)
                    else:
                        self.selected_proxy_ids.add(proxy_id)
                    self.update_proxy_selection_display()

    def _on_proxy_right_click(self, event):
        """右键弹出菜单：复制 IP"""
        item = self.proxy_tree.identify_row(event.y)
        if not item:
            return
        values = self.proxy_tree.item(item, 'values')
        if len(values) < 5:
            return
        clicked_ip = values[4]  # 服务器IP
        proxy_id = int(values[1])

        # 如果右键的行未被选中，临时以该行为准
        if proxy_id not in self.selected_proxy_ids:
            ips = [clicked_ip]
        else:
            ips = self._get_selected_proxy_ips()

        if not ips:
            return

        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(
            label=f"📋 复制 IP ({len(ips)} 台)",
            command=lambda: self._do_copy_ips(ips),
        )
        menu.post(event.x_root, event.y_root)

    def _copy_proxy_ips(self):
        """按钮回调：复制所有选中代理的 IP"""
        ips = self._get_selected_proxy_ips()
        if not ips:
            messagebox.showwarning("提示", "请先选择代理")
            return
        self._do_copy_ips(ips)

    def _get_selected_proxy_ips(self):
        """从 Treeview 中提取所有选中代理的服务器 IP"""
        ips = []
        for item in self.proxy_tree.get_children():
            values = self.proxy_tree.item(item, 'values')
            if len(values) >= 2 and int(values[1]) in self.selected_proxy_ids:
                ips.append(values[4])  # 服务器IP
        return ips

    def _do_copy_ips(self, ips):
        """将 IP 列表写入剪贴板"""
        text = '\n'.join(ips)
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.on_log_message(f"已复制 {len(ips)} 个 IP 到剪贴板", LogLevel.SUCCESS)

    def edit_single_proxy_group(self, proxy_id, current_group):
        """编辑单个代理的组"""
        dialog = tk.Toplevel(self.root)
        dialog.title("修改组")
        dialog.geometry("300x150")
        dialog.transient(self.root)
        dialog.grab_set()

        # 居中
        dialog.update_idletasks()
        x = self.root.winfo_x() + (self.root.winfo_width() - dialog.winfo_width()) // 2
        y = self.root.winfo_y() + (self.root.winfo_height() - dialog.winfo_height()) // 2
        dialog.geometry(f"+{x}+{y}")

        ttk.Label(dialog, text=f"当前组: {current_group}").pack(pady=10)
        ttk.Label(dialog, text="新组名:").pack()

        # 获取已有组
        groups = self.manager.database.get_all_groups() if self.manager else ['1']

        group_var = tk.StringVar(value=current_group)
        combo = ttk.Combobox(dialog, textvariable=group_var, values=groups, width=20)
        combo.pack(pady=5)

        def do_update():
            new_group = group_var.get().strip()
            if not new_group:
                messagebox.showwarning("警告", "组名不能为空")
                return
            if self.manager:
                self.manager.database.update_proxy_group(proxy_id, new_group)
                self.refresh_proxy_list()
                self.update_group_filter_combo()
            dialog.destroy()

        btn_frame = ttk.Frame(dialog)
        btn_frame.pack(pady=15)
        ttk.Button(btn_frame, text="确定", command=do_update).pack(side=tk.LEFT, padx=10)
        ttk.Button(btn_frame, text="取消", command=dialog.destroy).pack(side=tk.LEFT, padx=10)

    def update_proxy_selection_display(self):
        for item in self.proxy_tree.get_children():
            values = list(self.proxy_tree.item(item, 'values'))
            if len(values) >= 2:
                proxy_id = int(values[1])
                values[0] = "☑" if proxy_id in self.selected_proxy_ids else "☐"
                self.proxy_tree.item(item, values=values)
        self.select_count_label.config(text=f"已选: {len(self.selected_proxy_ids)}")

    def select_all_proxies(self):
        for item in self.proxy_tree.get_children():
            values = self.proxy_tree.item(item, 'values')
            if len(values) >= 2:
                self.selected_proxy_ids.add(int(values[1]))
        self.update_proxy_selection_display()

    def deselect_all_proxies(self):
        self.selected_proxy_ids.clear()
        self.update_proxy_selection_display()

    # ==================== 代理管理功能 ====================

    def refresh_proxy_list(self):
        if self.manager:
            self.refresh_proxy_list_internal()

    def refresh_proxy_list_internal(self):
        if not self.manager:
            return

        for item in self.proxy_tree.get_children():
            self.proxy_tree.delete(item)

        proxies = self.manager.database.get_all_proxies_with_details()

        # 获取所有筛选条件
        filter_group    = self.group_filter_var.get()
        filter_status   = self.status_filter_var.get()
        filter_platform = self.platform_filter_var.get()
        filter_deploy   = self.deploy_filter_var.get()
        filter_ip       = self.ip_filter_var.get().strip()

        # 平台 / 部署状态 文案映射
        _platform_label = {'auto': '未探测', 'aliyun': '阿里云', 'tencent': '腾讯云', 'default': '其他'}
        _deploy_label   = {'never': '未部署', 'success': '✅ 成功', 'failed': '❌ 失败'}

        for proxy in proxies:
            proxy_id = proxy[0]
            proxy_name = proxy[1]
            port = proxy[3]
            server_host = proxy[8]
            group_name = proxy[12] if len(proxy) > 12 and proxy[12] else '1'
            cloud_provider     = proxy[13] if len(proxy) > 13 and proxy[13] else 'auto'
            last_deploy_status = proxy[14] if len(proxy) > 14 and proxy[14] else 'never'

            # 组筛选
            if filter_group != "全部" and group_name != filter_group:
                continue

            is_active = self.manager.status_monitor.proxy_status_cache.get(port, False)

            # 状态筛选
            if filter_status == "活跃" and not is_active:
                continue
            if filter_status == "离线" and is_active:
                continue

            # 平台筛选
            platform_text = _platform_label.get(cloud_provider, cloud_provider)
            if filter_platform != "全部" and platform_text != filter_platform:
                continue

            # 部署状态筛选
            deploy_text = _deploy_label.get(last_deploy_status, last_deploy_status)
            if filter_deploy != "全部" and deploy_text != filter_deploy:
                continue

            # IP 模糊搜索
            if filter_ip and filter_ip not in server_host:
                continue

            last_check_time = get_beijing_time_short()
            status_text = "✅ 活跃" if is_active else "❌ 离线"
            select_mark = "☑" if proxy_id in self.selected_proxy_ids else "☐"

            self.proxy_tree.insert("", tk.END, values=(
                select_mark, proxy_id, proxy_name, port, server_host, group_name,
                platform_text, deploy_text, status_text, last_check_time
            ))

        self.select_count_label.config(text=f"已选: {len(self.selected_proxy_ids)}")

        # 更新组筛选下拉框
        self.update_group_filter_combo()

    def update_group_filter_combo(self):
        """更新组筛选下拉框的选项"""
        if not self.manager:
            return
        groups = self.manager.database.get_all_groups()
        self.group_filter_combo['values'] = ["全部"] + groups

    def on_proxy_filter_change(self, event=None):
        """任一筛选条件变化时刷新列表"""
        self.refresh_proxy_list_internal()

    _ip_filter_timer = None

    def _on_ip_filter_input(self, *args):
        """IP 搜索框输入防抖（300ms），避免每敲一个字符就刷新"""
        if self._ip_filter_timer:
            self.root.after_cancel(self._ip_filter_timer)
        self._ip_filter_timer = self.root.after(300, self.on_proxy_filter_change)

    def start_all_proxies(self):
        if not self.manager:
            messagebox.showwarning("警告", "管理器未初始化")
            return

        def do_start():
            self.manager.start_all_proxies(max_workers=MAX_WORKERS)
            self.root.after(0, self.refresh_proxy_list)

        self.run_async(do_start)

    def stop_all_proxies(self):
        if not self.manager:
            return
        if not messagebox.askyesno(
            "确认",
            "确定要停止所有代理吗？\n\n注意：会同时停止状态监控与心跳，否则它们会自动把代理拉起来。\n稍后可点「启动所有」重新启动。"
        ):
            return

        def do_stop():
            self.manager.stop_all_proxies()
            self.root.after(0, self.refresh_proxy_list)

        self.run_async(do_stop)

    def test_selected_proxies(self):
        from utils import test_proxy

        if not self.selected_proxy_ids:
            messagebox.showwarning("警告", "请先选择要测试的代理")
            return

        test_url = self.test_url_var.get()
        try:
            timeout = int(self.test_timeout_var.get())
        except:
            timeout = 10

        proxy_ids = list(self.selected_proxy_ids)

        def do_test():
            from logger import info, success, error
            info(f"开始测试 {len(proxy_ids)} 个代理，目标URL: {test_url}")
            for proxy_id in proxy_ids:
                proxy_details = self.manager.database.get_proxy_details(proxy_id)
                if proxy_details:
                    name = proxy_details['proxy_name']
                    port = proxy_details['port']
                    server_ip = proxy_details['server_host']
                    info(f"测试: {name} (127.0.0.1:{port}) -> {test_url}")
                    success_flag, result_info = test_proxy(port, test_url, timeout)
                    if success_flag:
                        success(f"  ✓ {name} 测试成功 (服务器: {server_ip})")
                    else:
                        error(f"  ✗ {name} 测试失败: {result_info}")
            info("测试完成")

        self.run_async(do_test)

    def delete_selected_proxies(self):
        if not self.selected_proxy_ids:
            messagebox.showwarning("警告", "请先选择要删除的代理")
            return
        count = len(self.selected_proxy_ids)
        if not messagebox.askyesno("确认", f"确定要删除选中的 {count} 个代理吗？"):
            return
        proxy_ids = list(self.selected_proxy_ids)

        def do_delete():
            from logger import info, success
            info(f"开始删除 {len(proxy_ids)} 个代理...")
            for proxy_id in proxy_ids:
                self.manager.delete_proxy(proxy_id)
            self.selected_proxy_ids.clear()
            success(f"已删除 {len(proxy_ids)} 个代理")
            self.root.after(0, self.refresh_proxy_list)

        self.run_async(do_delete)

    def change_selected_group(self):
        """批量修改选中代理的组"""
        if not self.selected_proxy_ids:
            messagebox.showwarning("警告", "请先选择要修改的代理")
            return

        dialog = tk.Toplevel(self.root)
        dialog.title("批量修改组")
        dialog.geometry("350x180")
        dialog.transient(self.root)
        dialog.grab_set()

        # 居中
        dialog.update_idletasks()
        x = self.root.winfo_x() + (self.root.winfo_width() - dialog.winfo_width()) // 2
        y = self.root.winfo_y() + (self.root.winfo_height() - dialog.winfo_height()) // 2
        dialog.geometry(f"+{x}+{y}")

        count = len(self.selected_proxy_ids)
        ttk.Label(dialog, text=f"将 {count} 个代理移动到:").pack(pady=10)

        # 获取已有组
        groups = self.manager.database.get_all_groups() if self.manager else ['1']

        # 选择已有组或输入新组名
        ttk.Label(dialog, text="选择已有组或输入新组名:").pack()

        group_var = tk.StringVar(value=groups[0] if groups else '1')
        combo = ttk.Combobox(dialog, textvariable=group_var, values=groups, width=25)
        combo.pack(pady=5)

        def do_update():
            new_group = group_var.get().strip()
            if not new_group:
                messagebox.showwarning("警告", "组名不能为空")
                return

            proxy_ids = list(self.selected_proxy_ids)

            def do_change():
                from logger import info, success
                info(f"修改 {len(proxy_ids)} 个代理的组为: {new_group}")
                self.manager.database.update_proxies_group(proxy_ids, new_group)
                success(f"已修改 {len(proxy_ids)} 个代理的组")
                self.root.after(0, self.refresh_proxy_list)
                self.root.after(0, self.update_group_filter_combo)

            self.run_async(do_change)
            dialog.destroy()

        btn_frame = ttk.Frame(dialog)
        btn_frame.pack(pady=15)
        ttk.Button(btn_frame, text="确定", command=do_update).pack(side=tk.LEFT, padx=10)
        ttk.Button(btn_frame, text="取消", command=dialog.destroy).pack(side=tk.LEFT, padx=10)

    def show_batch_add_dialog(self):
        if not self.manager:
            messagebox.showwarning("警告", "管理器未初始化")
            return
        # 默认端口走新助手：跳过 DB 已用 / 系统保留段 / 不可 bind 的端口
        # refresh_excluded=True 让本次批量加重新查询 Windows 保留段（Hyper-V 启停会改变保留段）
        try:
            default_port = self.manager.find_free_port(refresh_excluded=True)
        except Exception:
            default_port = self.manager.database.get_next_available_port()
        groups = self.manager.database.get_all_groups()
        last_settings = self._load_user_settings_raw()
        last_username = last_settings.get('last_batch_username', '') if isinstance(last_settings, dict) else ''
        last_password = last_settings.get('last_batch_password', '') if isinstance(last_settings, dict) else ''
        BatchAddDialog(self.root, self.do_batch_add, default_port, groups,
                       last_username=last_username, last_password=last_password)

    def _load_user_settings_raw(self):
        """读取 user_settings.json 原始 dict（用于批量加凭据回填）"""
        path = os.path.join(_app_root(), 'user_settings.json')
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _save_last_batch_credentials(self, username, password):
        """把本次批量加的凭据写回 user_settings.json（明文）"""
        path = os.path.join(_app_root(), 'user_settings.json')
        data = self._load_user_settings_raw()
        data['last_batch_username'] = username
        data['last_batch_password'] = password
        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

    def do_batch_add(self, hosts, start_port, group_name='1', cloud_provider='auto',
                     batch_username='', batch_password=''):
        self._save_last_batch_credentials(batch_username, batch_password)

        def do_add():
            self.manager.add_batch_proxies(
                hosts, batch_username, batch_password,
                start_port=start_port, group_name=group_name, cloud_provider=cloud_provider
            )
            self.root.after(0, self.refresh_proxy_list)
            self.root.after(0, self.update_group_filter_combo)

        self.run_async(do_add)

    def export_proxy_list(self):
        if not self.manager:
            return
        filename = filedialog.asksaveasfilename(
            defaultextension=".txt",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")],
            initialfile=f"proxy_list_{get_beijing_time_str('%Y%m%d_%H%M%S')}.txt"
        )
        if not filename:
            return

        def do_export():
            from logger import success
            proxies = self.manager.database.get_all_proxies_with_details()
            with open(filename, 'w', encoding='utf-8') as f:
                f.write(f"# SOCKS5 代理列表\n# 导出时间: {get_beijing_time_str()}\n# 总数: {len(proxies)}\n\n")
                for proxy in proxies:
                    port = proxy[3]
                    server_host = proxy[8]
                    is_active = self.manager.status_monitor.proxy_status_cache.get(port, False)
                    f.write(f"127.0.0.1:{port}  # {server_host} [{'活跃' if is_active else '离线'}]\n")
            success(f"代理列表已导出: {filename}")

        self.run_async(do_export)

    def batch_check_connectivity(self):
        if self.manager:
            self.run_async(self.manager.batch_check_server_connectivity)

    # ==================== 流量监控功能 ====================

    def refresh_traffic_list(self):
        """刷新流量监控列表"""
        if not self.manager:
            return

        for item in self.traffic_tree.get_children():
            self.traffic_tree.delete(item)

        proxies = self.manager.database.get_all_proxies_with_details()
        monitoring_servers = self.manager.traffic_monitor.monitoring_servers if hasattr(self.manager.traffic_monitor,
                                                                                        'monitoring_servers') else set()

        seen = set()
        for proxy in proxies:
            proxy_name = proxy[1]
            port = proxy[3]
            server_host = proxy[8]
            group_name = proxy[12] if len(proxy) > 12 and proxy[12] else '1'

            if server_host in seen:
                continue
            seen.add(server_host)

            is_monitoring = server_host in monitoring_servers
            status_text = "📊 监控中" if is_monitoring else "⏸️ 未监控"
            select_mark = "☑" if server_host in self.traffic_selected_servers else "☐"

            self.traffic_tree.insert("", tk.END,
                                     values=(select_mark, server_host, proxy_name, group_name, port, status_text))

        # 更新选中计数
        self.traffic_select_label.config(text=f"已选: {len(self.traffic_selected_servers)}")

    def get_selected_server(self):
        """获取当前选中的服务器"""
        selection = self.traffic_tree.selection()
        if not selection:
            return None
        values = self.traffic_tree.item(selection[0], 'values')
        return values[1] if values else None  # 索引1是服务器IP列

    def get_server_proxy_info(self, server_ip):
        """获取服务器对应的代理信息"""
        proxies = self.manager.database.get_all_proxies_with_details()
        for proxy in proxies:
            if proxy[8] == server_ip:
                return {
                    'username': proxy[10],
                    'password': proxy[11],
                    'port': proxy[9]
                }
        return None

    def show_traffic_context_menu(self, event):
        """显示右键菜单"""
        item = self.traffic_tree.identify_row(event.y)
        if item:
            self.traffic_tree.selection_set(item)
            self.traffic_context_menu.post(event.x_root, event.y_root)

    def on_traffic_double_click(self, event):
        """双击服务器 - 快速下载并分析日志"""
        server_ip = self.get_selected_server()
        if not server_ip:
            return
        self.download_and_analyze_log(server_ip)

    def start_traffic_monitor(self):
        if not self.manager:
            return

        def do_start():
            self.manager.start_traffic_monitor_auto()
            self.root.after(0, self.refresh_traffic_list)

        self.run_async(do_start)

    def stop_traffic_monitor(self):
        if not self.manager:
            return

        def do_stop():
            self.manager.traffic_monitor.stop_all_monitors()
            self.root.after(0, self.refresh_traffic_list)

        self.run_async(do_stop)

    def start_single_monitor(self):
        """启动单个服务器监控"""
        server_ip = self.get_selected_server()
        if not server_ip or not self.manager:
            return

        proxy_info = self.get_server_proxy_info(server_ip)
        if not proxy_info:
            return

        def do_start():
            self.manager.traffic_monitor.start_monitor_for_server(
                server_ip, proxy_info['username'], proxy_info['password'],
                TRAFFIC_TARGET_IPS, server_port=proxy_info['port']
            )
            self.root.after(0, self.refresh_traffic_list)

        self.run_async(do_start)

    def stop_single_monitor(self):
        """停止单个服务器监控"""
        server_ip = self.get_selected_server()
        if not server_ip or not self.manager:
            return

        proxy_info = self.get_server_proxy_info(server_ip)
        if not proxy_info:
            return

        def do_stop():
            self.manager.traffic_monitor.stop_monitor_for_server(
                server_ip, proxy_info['username'], proxy_info['password'],
                server_port=proxy_info['port']
            )
            self.root.after(0, self.refresh_traffic_list)

        self.run_async(do_stop)

    def download_server_log(self):
        """下载选中服务器的日志"""
        server_ip = self.get_selected_server()
        if not server_ip:
            messagebox.showwarning("警告", "请先选择一个服务器")
            return
        self.download_and_analyze_log(server_ip)

    def download_and_analyze_log(self, server_ip):
        """下载并分析日志"""
        if not self.manager:
            return

        proxy_info = self.get_server_proxy_info(server_ip)
        if not proxy_info:
            messagebox.showerror("错误", f"找不到服务器 {server_ip} 的信息")
            return

        target_dir = self._ask_download_dir(self.traffic_log_save_dir_var, title='选择流量日志保存目录')
        if not target_dir:
            from logger import info
            info("已取消下载")
            return

        def do_download():
            from logger import info, success, error

            timestamp = get_beijing_time_str('%Y%m%d_%H%M%S')
            log_filename = f"{server_ip}_{timestamp}.pcap"
            local_path = os.path.join(target_dir, log_filename)

            info(f"下载日志: {server_ip} -> {log_filename}（保存至 {target_dir}）")

            saved = self.manager.traffic_monitor.save_log_for_server(
                server_ip, proxy_info['username'], proxy_info['password'],
                proxy_info['port'], local_path
            )

            if saved:
                success(f"日志已保存: {log_filename}")
                # 在主线程打开分析窗口
                self.root.after(0, lambda: self.open_analyzer_window(local_path))
            else:
                error(f"下载日志失败: {server_ip}")

        self.run_async(do_download)

    def download_all_logs(self):
        """下载所有服务器的日志"""
        if not self.manager:
            return

        target_dir = self._ask_download_dir(self.traffic_log_save_dir_var, title='选择流量日志保存目录')
        if not target_dir:
            from logger import info
            info("已取消下载")
            return

        def do_download():
            from logger import info, success

            info(f"开始并发下载所有服务器日志（保存至 {target_dir}）...")

            # 进度回报：在 worker 线程被调用，节流打印（每 25 台或最后一台），避免刷屏
            def on_progress(done, total, server_ip, ok):
                if done == total or done % 25 == 0:
                    info(f"  下载进度 {done}/{total} ...")

            results = self.manager.traffic_monitor.batch_save_logs(
                target_dir, progress_cb=on_progress
            )

            ok = sum(1 for r in results if r['ok'])
            success(f"下载完成 ✅{ok} ❌{len(results) - ok}，日志目录: {target_dir}")

        self.run_async(do_download)

    def show_server_logs(self):
        """显示服务器的历史日志列表"""
        server_ip = self.get_selected_server()
        if not server_ip:
            messagebox.showwarning("警告", "请先选择一个服务器")
            return

        # 查找该服务器的所有日志（目录取自系统配置 tab 中的"流量日志目录" Entry 实时值）
        log_dir = self.traffic_log_save_dir_var.get().strip()
        if not log_dir or not os.path.isdir(log_dir):
            messagebox.showinfo(
                "提示",
                f"流量日志目录不存在或未设置:\n{log_dir or '(空)'}\n\n请在「系统配置」标签页中设置该目录"
            )
            return
        log_files = []
        for ext in ("pcap", "pcapng", "cap", "log"):
            log_files.extend(glob.glob(os.path.join(log_dir, f"{server_ip}_*.{ext}")))
        log_files = list(set(log_files))

        if not log_files:
            messagebox.showinfo("提示", f"服务器 {server_ip} 没有历史抓包\n\n请先点击「下载日志」")
            return

        # 按时间排序（最新的在前）
        log_files.sort(reverse=True)

        # 创建选择对话框
        dialog = tk.Toplevel(self.root)
        dialog.title(f"历史日志 - {server_ip}")
        dialog.geometry("450x350")
        dialog.transient(self.root)
        dialog.grab_set()

        # 居中
        dialog.update_idletasks()
        x = self.root.winfo_x() + (self.root.winfo_width() - dialog.winfo_width()) // 2
        y = self.root.winfo_y() + (self.root.winfo_height() - dialog.winfo_height()) // 2
        dialog.geometry(f"+{x}+{y}")

        ttk.Label(dialog, text=f"服务器 {server_ip} 的历史日志：", font=("", 10, "bold")).pack(pady=10)

        # 日志列表
        list_frame = ttk.Frame(dialog)
        list_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        listbox = tk.Listbox(list_frame, font=("Consolas", 10))
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=listbox.yview)
        listbox.configure(yscrollcommand=scrollbar.set)

        listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        for log_file in log_files:
            filename = os.path.basename(log_file)
            size = os.path.getsize(log_file)
            size_str = f"{size / 1024:.1f}KB" if size > 1024 else f"{size}B"
            listbox.insert(tk.END, f"{filename}  ({size_str})")

        def on_select():
            selection = listbox.curselection()
            if selection:
                selected_file = log_files[selection[0]]
                dialog.destroy()
                self.open_analyzer_window(selected_file)

        def on_double_click(event):
            on_select()

        listbox.bind('<Double-1>', on_double_click)

        btn_frame = ttk.Frame(dialog)
        btn_frame.pack(fill=tk.X, pady=10)

        ttk.Button(btn_frame, text="📊 打开分析", command=on_select).pack(side=tk.LEFT, padx=20)
        ttk.Button(btn_frame, text="关闭", command=dialog.destroy).pack(side=tk.RIGHT, padx=20)

    def open_analyzer_window(self, filepath):
        """打开/复用日志分析窗口；filepath 可为单个路径或路径列表，会追加进现有窗口"""
        paths = filepath if isinstance(filepath, list) else [filepath]
        win = getattr(self, '_analyzer_window', None)
        if win is not None and win.winfo_exists():
            win.add_files(paths)
            win.lift()
            win.focus_force()
            return
        self._analyzer_window = LogAnalyzerWindow(self.root, paths)

    def open_log_analyzer(self):
        """日志分析入口：弹文件选择框（默认起点为流量日志目录，可多选），选中后打开分析窗口"""
        initial_dir = self.traffic_log_save_dir_var.get().strip()
        if not initial_dir or not os.path.isdir(initial_dir):
            initial_dir = None  # 目录无效则交给系统默认起点

        paths = filedialog.askopenfilenames(
            title="选择要分析的流量抓包（可多选）",
            initialdir=initial_dir,
            filetypes=[("抓包/日志", "*.pcap *.pcapng *.cap *.log"),
                       ("pcap 抓包", "*.pcap *.pcapng *.cap"),
                       ("Log files", "*.log"),
                       ("All files", "*.*")]
        )
        if paths:
            self.open_analyzer_window(list(paths))

    def open_log_directory(self):
        """打开当前流量日志目录（取系统配置 tab Entry 实时值；不存在则提示用户重选）"""
        import subprocess
        path = self.traffic_log_save_dir_var.get().strip()
        if not path or not os.path.isdir(path):
            messagebox.showwarning(
                "目录不存在",
                f"当前配置的流量日志目录不存在或为空:\n{path or '(空)'}\n\n"
                f"请在「系统配置」标签页中通过「📂 浏览…」选择一个已存在的目录。"
            )
            return
        try:
            if sys.platform == 'win32':
                os.startfile(path)
            elif sys.platform == 'darwin':
                subprocess.run(['open', path])
            else:
                subprocess.run(['xdg-open', path])
        except Exception as e:
            messagebox.showerror("错误", f"无法打开目录: {e}")

    # ==================== 心跳控制功能 ====================

    def start_keepalive(self):
        if not self.manager:
            return

        def do_start():
            self.manager.status_monitor._start_keepalive()

        self.run_async(do_start)

    def stop_keepalive(self):
        if not self.manager:
            return

        def do_stop():
            self.manager.status_monitor._stop_keepalive()

        self.run_async(do_stop)

    def manual_keepalive(self):
        if not self.manager:
            return
        self.run_async(self.manager.manual_keepalive)

    # ==================== Agent 管理 Tab ====================

    def create_agent_tab(self):
        frame = ttk.Frame(self.notebook, padding="5")
        self.notebook.add(frame, text="☁️ Agent管理")
        self.agent_tab_frame = frame  # 用于 Tab 切换事件判断

        # ── 部署源管理 ──────────────────────────────────────
        src_frame = ttk.LabelFrame(frame, text="部署源 (gamyy-core)", padding="5")
        src_frame.pack(fill=tk.X, pady=(0, 5))

        self.agent_source_status_var = tk.StringVar(value='扫描中...')
        ttk.Label(src_frame, textvariable=self.agent_source_status_var,
                  foreground="darkblue").pack(side=tk.LEFT, padx=5)

        ttk.Button(src_frame, text="📦 从 GitHub 拉取", command=self._agent_github_pull).pack(side=tk.RIGHT, padx=2)
        ttk.Button(src_frame, text="📥 从外部同步", command=self._agent_sync_source).pack(side=tk.RIGHT, padx=2)
        ttk.Button(src_frame, text="📤 导入 zip", command=self._agent_import_zip).pack(side=tk.RIGHT, padx=2)
        ttk.Button(src_frame, text="🔍 刷新状态", command=self._agent_refresh_source_status).pack(side=tk.RIGHT, padx=2)

        # ── 工具栏 ──────────────────────────────────────────
        toolbar = ttk.Frame(frame)
        toolbar.pack(fill=tk.X, pady=(0, 5))

        ttk.Button(toolbar, text="全选", width=6, command=self._agent_select_all).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="取消", width=6, command=self._agent_deselect_all).pack(side=tk.LEFT, padx=2)
        self.agent_select_label = ttk.Label(toolbar, text="已选: 0", foreground="blue")
        self.agent_select_label.pack(side=tk.LEFT, padx=8)

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=5)

        ttk.Button(toolbar, text="🔃 重载列表", command=self._agent_load_servers).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="🚀 部署Agent", command=self._agent_batch_deploy).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="🌐 完整部署", command=self._agent_batch_full_deploy).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="▶ 启动选中", command=self._agent_batch_start).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="⏹ 停止选中", command=self._agent_batch_stop).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="🔄 重启选中", command=self._agent_batch_restart).pack(side=tk.LEFT, padx=2)

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=5)

        ttk.Button(toolbar, text="📊 刷新状态", command=self._agent_refresh_status).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="📋 查看日志", command=self._agent_show_logs).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="💾 下载日志DB", command=self._agent_batch_download_db).pack(side=tk.LEFT, padx=2)

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=5)

        self.agent_progress_label = ttk.Label(toolbar, text="", foreground="gray", font=("", 10))
        self.agent_progress_label.pack(side=tk.RIGHT, padx=(0, 10))

        self.agent_stats_label = ttk.Label(toolbar, text="", foreground="#333333", font=("", 10))
        self.agent_stats_label.pack(side=tk.RIGHT, padx=5)

        # ── 服务器列表 ──────────────────────────────────────
        list_frame = ttk.LabelFrame(frame, text="云服务器列表", padding="3")
        list_frame.pack(fill=tk.BOTH, expand=True)

        cols = ("选择", "ID", "名称", "服务器IP", "SSH端口", "服务器平台", "部署状态", "部署模式", "PM2状态", "健康", "任务数", "运行时间(s)", "操作状态")
        self.agent_tree = ttk.Treeview(list_frame, columns=cols, show="headings", height=12)

        widths = [30, 40, 80, 130, 65, 70, 70, 70, 80, 60, 60, 90, 140]
        aligns = ["center"] * 12 + ["w"]
        for col, w, a in zip(cols, widths, aligns):
            self.agent_tree.heading(col, text=col)
            self.agent_tree.column(col, width=w, anchor=a, minwidth=w)

        self.agent_tree.tag_configure('online',   foreground='#067a06')
        self.agent_tree.tag_configure('stopped',  foreground='#cc6600')
        self.agent_tree.tag_configure('notfound', foreground='#999999')
        self.agent_tree.tag_configure('error',    foreground='#cc0000')

        scroll_y = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.agent_tree.yview)
        self.agent_tree.configure(yscrollcommand=scroll_y.set)
        self.agent_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scroll_y.pack(side=tk.RIGHT, fill=tk.Y)
        self.agent_tree.bind('<ButtonRelease-1>', self._on_agent_click)

        # 初始加载服务器列表
        self.root.after(500, self._agent_load_servers)
        # 初始刷新部署源状态
        self.root.after(500, self._agent_refresh_source_status)

    def _on_notebook_tab_changed(self, event):
        """切换到 Agent管理 Tab 时自动重载服务器列表"""
        try:
            if self.notebook.select() == str(self.agent_tab_frame):
                self._agent_load_servers()
        except Exception:
            pass

    # 平台/部署状态文案映射（与代理 tab 保持一致）
    _PLATFORM_LABEL = {'auto': '未探测', 'aliyun': '阿里云', 'tencent': '腾讯云', 'default': '其他'}
    _DEPLOY_LABEL   = {'never': '未部署', 'success': '✅ 成功', 'failed': '❌ 失败'}
    _MODE_LABEL     = {'agent': '🔹 Agent', 'full': '🔶 完整'}

    def _format_deploy_mode(self, raw_mode):
        """把 'agent,full' 格式化为显示文本 '🔹 Agent + 🔶 完整'。空字符串表示未部署过。"""
        if not raw_mode or not raw_mode.strip():
            return '—'
        modes = [m.strip() for m in raw_mode.split(',') if m.strip()]
        labels = [self._MODE_LABEL.get(m, m) for m in modes]
        return ' + '.join(labels)

    def _agent_load_servers(self):
        """从 DB 加载服务器列表到 Treeview（不查询状态，只填 IP/端口/平台/部署状态）"""
        if not self.agent_manager:
            self.root.after(1000, self._agent_load_servers)
            return
        servers = self.agent_manager.get_all_servers()
        for item in self.agent_tree.get_children():
            self.agent_tree.delete(item)
        self.agent_selected_ids.clear()
        for s in servers:
            is_local = bool(s.get('is_local'))
            platform = '🖥 本机' if is_local else self._PLATFORM_LABEL.get(s.get('cloud_provider') or 'auto', '未探测')
            deploy   = self._DEPLOY_LABEL.get(s.get('last_deploy_status') or 'never', '未部署')
            dmode    = self._format_deploy_mode(s.get('deploy_mode') or 'agent')
            port_disp = '-' if is_local else s['server_port']
            self.agent_tree.insert('', tk.END, iid=str(s['id']), values=(
                '', s['id'], s['name'], s['server_host'], port_disp,
                platform, deploy, dmode,
                '—', '—', '—', '—', '',
            ))
        self._agent_update_select_label()
        self._agent_update_summary()

    def _agent_update_summary(self):
        """更新工具栏的部署统计标签（部署成功/失败/未部署）"""
        try:
            servers = self.agent_manager.get_all_servers() if self.agent_manager else []
            n_total = len([s for s in servers if not s.get('is_local')])
            n_success = sum(1 for s in servers if not s.get('is_local') and s.get('last_deploy_status') == 'success')
            n_failed = sum(1 for s in servers if not s.get('is_local') and s.get('last_deploy_status') == 'failed')
            n_never = n_total - n_success - n_failed
            self.agent_stats_label.config(
                text=f"📊 共{n_total}台  ✅{n_success}  ❌{n_failed}  ⬚{n_never}"
            )
        except Exception:
            pass

    def _agent_log(self, msg, level='INFO'):
        """将 Agent 操作日志转发到系统日志"""
        _map = {
            'SUCCESS': LogLevel.SUCCESS,
            'WARNING': LogLevel.WARNING,
            'ERROR':   LogLevel.ERROR,
            'DEBUG':   LogLevel.DEBUG,
        }
        self.on_log_message(msg, _map.get(level, LogLevel.INFO))

    def _agent_set_progress(self, text):
        self.root.after(0, lambda: self.agent_progress_label.config(text=text))

    # ── 选择逻辑 ────────────────────────────────────────────
    def _on_agent_click(self, event):
        region = self.agent_tree.identify_region(event.x, event.y)
        if region != 'cell':
            return
        item = self.agent_tree.identify_row(event.y)
        if not item:
            return
        sid = int(item)
        if sid in self.agent_selected_ids:
            self.agent_selected_ids.discard(sid)
            self.agent_tree.set(item, "选择", '')
        else:
            self.agent_selected_ids.add(sid)
            self.agent_tree.set(item, "选择", '✓')
        self._agent_update_select_label()

    def _agent_select_all(self):
        for item in self.agent_tree.get_children():
            self.agent_selected_ids.add(int(item))
            self.agent_tree.set(item, "选择", '✓')
        self._agent_update_select_label()

    def _agent_deselect_all(self):
        for item in self.agent_tree.get_children():
            self.agent_selected_ids.discard(int(item))
            self.agent_tree.set(item, "选择", '')
        self._agent_update_select_label()

    def _agent_update_select_label(self):
        self.agent_select_label.config(text=f"已选: {len(self.agent_selected_ids)}")

    def _agent_update_row(self, server_id, pm2, health, uptime, running_tasks, op_status=None):
        """在主线程更新某行状态列（可选更新操作状态列）

        当前列顺序：选择(0) ID(1) 名称(2) 服务器IP(3) SSH端口(4) 服务器平台(5) 部署状态(6) 部署模式(7)
                  PM2状态(8) 健康(9) 任务数(10) 运行时间(s)(11) 操作状态(12)
        """
        iid = str(server_id)
        pm2_disp = pm2
        health_disp = '✅' if health else '❌'
        uptime_disp = str(uptime) if uptime is not None else '—'
        tasks_disp = str(running_tasks) if running_tasks is not None else '—'

        tag = {'online': 'online', 'stopped': 'stopped', 'not_found': 'notfound'}.get(pm2, 'error')

        def _do():
            try:
                if self.agent_tree.exists(iid):
                    vals = list(self.agent_tree.item(iid, 'values'))
                    vals[8]  = pm2_disp
                    vals[9]  = health_disp
                    vals[10] = tasks_disp
                    vals[11] = uptime_disp
                    if op_status is not None:
                        vals[12] = op_status
                    self.agent_tree.item(iid, values=vals, tags=(tag,))
            except Exception:
                pass
        self.root.after(0, _do)

    def _agent_set_row_op_status(self, server_id, msg):
        """实时更新某行的操作状态列（线程安全）"""
        iid = str(server_id)
        def _do():
            try:
                if self.agent_tree.exists(iid):
                    vals = list(self.agent_tree.item(iid, 'values'))
                    vals[12] = msg
                    self.agent_tree.item(iid, values=vals)
            except Exception:
                pass
        self.root.after(0, _do)

    # ── 操作方法 ────────────────────────────────────────────
    def _get_agent_targets(self, require_selection=True):
        if not self.agent_manager:
            messagebox.showwarning("提示", "Agent 管理器尚未初始化，请稍候")
            return None
        if require_selection and not self.agent_selected_ids:
            messagebox.showwarning("提示", "请先选择服务器")
            return None
        return list(self.agent_selected_ids) if self.agent_selected_ids else \
               [int(iid) for iid in self.agent_tree.get_children()]

    def _classify_for_deploy(self, ids):
        """把选中的 server ID 按部署状态分组（用于确认弹窗）。
        返回 dict { 'in_progress': [...], 'success': [...], 'todo': [...], 'local_ids': [...] }
        - in_progress: 正在部署中（_deploying_ids）→ 应自动跳过
        - success    : last_deploy_status == 'success' → 用户决定是否重部署
        - todo       : 其它（never / failed）→ 待部署
        - local_ids  : 本机，单独列出（不参与上述分类）
        """
        deploying = self.agent_manager.get_deploying_ids() if self.agent_manager else set()
        try:
            servers = self.agent_manager.get_servers_by_ids(ids) if self.agent_manager else []
        except Exception:
            servers = []
        status_map = {s['id']: (s.get('last_deploy_status') or 'never') for s in servers}
        local_ids = [s['id'] for s in servers if s.get('is_local')]
        local_set = set(local_ids)

        in_progress, success, todo = [], [], []
        for sid in ids:
            if sid in local_set:
                continue  # 本机单独通过"跳过本机"勾选框处理
            if sid in deploying:
                in_progress.append(sid)
            elif status_map.get(sid) == 'success':
                success.append(sid)
            else:
                todo.append(sid)
        return {'in_progress': in_progress, 'success': success, 'todo': todo, 'local_ids': local_ids}

    def _show_deploy_confirm_dialog(self, classification, mode_label):
        """部署前确认弹窗，带"跳过已部署成功的"和"跳过本机"checkbox。
        返回 (confirmed: bool, skip_success: bool, skip_local: bool)
        """
        n_progress = len(classification['in_progress'])
        n_success  = len(classification['success'])
        n_todo     = len(classification['todo'])
        n_local    = len(classification.get('local_ids', []))
        total      = n_progress + n_success + n_todo

        result = {'confirmed': False, 'skip_success': False, 'skip_local': False}

        dialog = tk.Toplevel(self.root)
        dialog.title(f"确认部署 — {mode_label}")
        dialog.transient(self.root)
        dialog.grab_set()
        dialog.resizable(False, False)

        ttk.Label(
            dialog, text=f"选中 {total} 台服务器：",
            font=("", 10, "bold")
        ).pack(pady=(15, 5), padx=20, anchor=tk.W)

        info = ttk.Frame(dialog, padding=(20, 5))
        info.pack(fill=tk.X)
        # 三行始终显示；0 计数省略箭头描述并显示成灰色，让非零的更显眼
        suffix_progress = " → 自动跳过（避免冲撞）" if n_progress > 0 else ""
        suffix_success  = " → 将重新部署 ⚠"        if n_success  > 0 else ""
        suffix_todo     = " → 将部署"              if n_todo     > 0 else ""
        ttk.Label(info,
                  text=f"·  正在部署中：{n_progress} 台{suffix_progress}",
                  foreground="gray").pack(anchor=tk.W)
        ttk.Label(info,
                  text=f"·  已部署成功：{n_success} 台{suffix_success}",
                  foreground="darkorange" if n_success > 0 else "gray").pack(anchor=tk.W)
        ttk.Label(info,
                  text=f"·  未部署/失败：{n_todo} 台{suffix_todo}",
                  foreground="darkblue" if n_todo > 0 else "gray").pack(anchor=tk.W)

        skip_var = tk.BooleanVar(value=True)
        if n_success > 0:
            ttk.Separator(dialog, orient=tk.HORIZONTAL).pack(fill=tk.X, padx=20, pady=8)
            ttk.Checkbutton(
                dialog,
                text=f"跳过已部署成功的 {n_success} 台（仅部署未部署/失败的 {n_todo} 台）",
                variable=skip_var,
            ).pack(padx=20, anchor=tk.W)
        # （文案与上方"已部署成功 / 未部署/失败"对齐；勾上后只跑后者）

        skip_local_var = tk.BooleanVar(value=True)
        if n_local > 0:
            ttk.Separator(dialog, orient=tk.HORIZONTAL).pack(fill=tk.X, padx=20, pady=8)
            ttk.Checkbutton(
                dialog,
                text=f"跳过本机（🖥 本机 × {n_local} 台）",
                variable=skip_local_var,
            ).pack(padx=20, anchor=tk.W)

        # 实际进入部署数实时计算
        actual = ttk.Label(dialog, foreground="green", font=("", 9, "bold"))
        actual.pack(padx=20, pady=(10, 5), anchor=tk.W)

        def _update_actual(*args):
            n = n_todo if skip_var.get() else (n_todo + n_success)
            if not skip_local_var.get():
                n = n + n_local
            actual.config(text=f"实际进入部署：{n} 台")
        _update_actual()
        skip_var.trace_add('write', _update_actual)
        skip_local_var.trace_add('write', _update_actual)

        btns = ttk.Frame(dialog)
        btns.pack(pady=15)

        def on_ok():
            result['confirmed'] = True
            result['skip_success'] = skip_var.get()
            result['skip_local'] = skip_local_var.get()
            dialog.destroy()

        def on_cancel():
            dialog.destroy()

        ttk.Button(btns, text="确认部署", command=on_ok, width=12).pack(side=tk.LEFT, padx=10)
        ttk.Button(btns, text="取消", command=on_cancel, width=12).pack(side=tk.LEFT, padx=10)
        dialog.bind('<Escape>', lambda e: on_cancel())

        # 居中
        dialog.update_idletasks()
        x = self.root.winfo_x() + (self.root.winfo_width() - dialog.winfo_width()) // 2
        y = self.root.winfo_y() + (self.root.winfo_height() - dialog.winfo_height()) // 2
        dialog.geometry(f"+{x}+{y}")

        dialog.wait_window()
        return result['confirmed'], result['skip_success'], result['skip_local']

    def _agent_batch_deploy(self):
        ids = self._get_agent_targets()
        if ids is None:
            return

        cls = self._classify_for_deploy(ids)
        confirmed, skip_success, skip_local = self._show_deploy_confirm_dialog(cls, mode_label='精简 Agent 模式')
        if not confirmed:
            return

        # 计算最终下发列表：todo 永远在内；success 视 checkbox 决定；in_progress 始终丢弃
        deploy_ids = list(cls['todo']) + ([] if skip_success else list(cls['success']))
        if not skip_local:
            deploy_ids = deploy_ids + list(cls['local_ids'])
        if not deploy_ids:
            messagebox.showinfo("提示", "没有需要部署的服务器")
            return

        # 预标记所有行为"等待中..."
        for sid in deploy_ids:
            self._agent_set_row_op_status(sid, '等待中...')
        def run():
            self._agent_set_progress(f"部署中 0/{len(deploy_ids)}...")
            def step_factory(server_id, host):
                return lambda msg: self._agent_set_row_op_status(server_id, msg)
            def on_progress(done, total, server_id, host, res):
                self._agent_set_progress(f"部署中 {done}/{total}...")
                st = res.get('status') or {}
                final_msg = '✅ 完成' if res.get('ok') else f"❌ {res.get('msg','失败')}"
                self._agent_update_row(
                    server_id,
                    st.get('pm2', '—'), st.get('health', False),
                    st.get('uptime'), st.get('running_tasks'),
                    op_status=final_msg,
                )
            results = self.agent_manager.batch_deploy(deploy_ids, on_progress, step_factory=step_factory, mode='agent')
            ok = sum(1 for r in results if r['ok'])
            self._agent_set_progress(f"部署完成 ✅{ok} ❌{len(results)-ok}")
            self._agent_log(f"部署完成：{ok}/{len(results)} 成功", 'SUCCESS' if ok == len(results) else 'WARNING')
            # 刷新 Agent 列表（持久化的"部署状态"/"服务器平台"列从 DB 重新读取）
            self.root.after(0, self._agent_load_servers)
            # 同时刷新代理 tab 的对应列
            self.root.after(0, self.refresh_proxy_list)
        self.run_async(run)

    def _agent_batch_full_deploy(self):
        """完整模式部署：上传整个 gamyy-core，云端起 web/server.js（监听 3000）。
        一般只在 1~几台服务器上跑。和 batch_deploy 是不同的部署流程，远端目录、PM2 名都不同。
        """
        ids = self._get_agent_targets()
        if ids is None:
            return

        cls = self._classify_for_deploy(ids)
        # 完整模式补一个一次性的"性质提示"
        if not messagebox.askyesno(
            "完整部署 — 模式说明",
            "你正在执行【完整项目部署】（区别于 Agent 模式）：\n\n"
            "  · 上传整个 gamyy-core（除 node_modules / 大日志 DB 等）\n"
            "  · 远端目录: /opt/gamyy-core\n"
            "  · PM2 进程: gamyy-web（监听 :3000）\n"
            "  · 含 better-sqlite3 原生编译，耗时 3~5 分钟/台\n\n"
            "建议只在少量服务器上做。下一步将弹出选中明细，确认是否继续。"
        ):
            return

        confirmed, skip_success, skip_local = self._show_deploy_confirm_dialog(cls, mode_label='完整项目模式')
        if not confirmed:
            return

        deploy_ids = list(cls['todo']) + ([] if skip_success else list(cls['success']))
        if not skip_local:
            deploy_ids = deploy_ids + list(cls['local_ids'])
        if not deploy_ids:
            messagebox.showinfo("提示", "没有需要部署的服务器")
            return

        # 如果选中了本机行，先让用户选择本机部署目录
        local_servers = self.agent_manager.get_servers_by_ids(deploy_ids)
        if any(s.get('is_local') for s in local_servers):
            from config import LOCAL_DEPLOY_DIR
            chosen = filedialog.askdirectory(
                title='选择本机部署目录（会在其下写入 gamyy-core 文件）',
                initialdir=LOCAL_DEPLOY_DIR if os.path.isdir(os.path.dirname(LOCAL_DEPLOY_DIR)) else os.path.expanduser('~'),
            )
            if not chosen:
                return
            chosen = os.path.normpath(chosen)
            # 同步更新 config 运行时值 + user_settings.json
            try:
                import config as _cfg
                _cfg._S['local_deploy_dir'] = chosen
                _cfg.LOCAL_DEPLOY_DIR = chosen
                sf = _cfg._SETTINGS_FILE
                prev = {}
                if os.path.isfile(sf):
                    with open(sf, 'r', encoding='utf-8') as f:
                        prev = json.load(f)
                prev['local_deploy_dir'] = chosen
                with open(sf + '.tmp', 'w', encoding='utf-8') as f:
                    json.dump(prev, f, indent=2, ensure_ascii=False)
                os.replace(sf + '.tmp', sf)
                self._agent_log(f"本机部署目录: {chosen}", 'INFO')
                # 同步更新系统配置页的输入框
                try:
                    self.local_deploy_dir_var.set(chosen)
                except Exception:
                    pass
            except Exception:
                pass

        for sid in deploy_ids:
            self._agent_set_row_op_status(sid, '等待中...')

        def run():
            self._agent_set_progress(f"完整部署 0/{len(deploy_ids)}...")
            def step_factory(server_id, host):
                return lambda msg: self._agent_set_row_op_status(server_id, msg)
            def on_progress(done, total, server_id, host, res):
                self._agent_set_progress(f"完整部署 {done}/{total}...")
                st = res.get('status') or {}
                final_msg = '✅ 完整部署完成' if res.get('ok') else f"❌ {res.get('msg','失败')}"
                self._agent_update_row(
                    server_id,
                    st.get('pm2', '—'), st.get('health', False),
                    st.get('uptime'), st.get('running_tasks'),
                    op_status=final_msg,
                )
            results = self.agent_manager.batch_deploy(deploy_ids, on_progress, step_factory=step_factory, mode='full')
            ok = sum(1 for r in results if r['ok'])
            self._agent_set_progress(f"完整部署完成 ✅{ok} ❌{len(results)-ok}")
            self._agent_log(f"完整部署完成：{ok}/{len(results)} 成功", 'SUCCESS' if ok == len(results) else 'WARNING')
            self.root.after(0, self._agent_load_servers)
            self.root.after(0, self.refresh_proxy_list)
        self.run_async(run)

    # ==================== 部署源管理 ====================

    def _agent_refresh_source_status(self):
        """刷新部署源状态标签。"""
        from managers.agent_deploy_manager import get_deploy_source
        path, kind = get_deploy_source()
        kind_label = {
            'synced':  '可用',
            'bundled': 'EXE 内置版',
            'missing': '⚠️ 无可用部署源',
        }.get(kind, kind)
        display = f"部署源: {kind_label}"
        if path:
            display += f"  ({path})"
        self.agent_source_status_var.set(display)

    def _agent_sync_source(self):
        """让用户选择 gamyy-core 源码目录，同步到 _app_root()/resources/<RESOURCE_DIR_NAME>/。
        默认初始目录取 AGENT_SOURCE_DIR（config.py 配置），用户可随时换。"""
        src = filedialog.askdirectory(
            title='选择 gamyy-core 源码目录',
            initialdir=AGENT_SOURCE_DIR if (AGENT_SOURCE_DIR and os.path.isdir(AGENT_SOURCE_DIR)) else os.path.expanduser('~'),
        )
        if not src:
            return
        src = os.path.normpath(src)
        if not os.path.isfile(os.path.join(src, 'agent', 'server.js')):
            messagebox.showerror("同步失败", f"该目录不像 gamyy-core 源码（缺 agent/server.js）:\n{src}")
            return

        dst = os.path.join(_app_root(), 'resources', RESOURCE_DIR_NAME)
        if not messagebox.askyesno(
            "确认同步",
            f"将把外部源目录同步到：\n{dst}\n\n"
            f"已存在的内容会被覆盖。继续？"
        ):
            return

        # 使用 agent_deploy_manager 里的过滤规则
        from managers.agent_deploy_manager import _should_skip_full

        def _ignore(directory, names):
            # shutil.copytree ignore callback: 返回要跳过的项
            rel_dir = os.path.relpath(directory, src)
            ignored = []
            for n in names:
                rel = os.path.normpath(os.path.join(rel_dir, n)) if rel_dir != '.' else n
                full = os.path.join(directory, n)
                if _should_skip_full(rel, os.path.isdir(full)):
                    ignored.append(n)
            return ignored

        def do_sync():
            try:
                # 清理已有 dst（保证覆盖一致）
                if os.path.isdir(dst):
                    _rmtree_force(dst)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copytree(src, dst, ignore=_ignore)
                self._agent_log(f"同步完成：{src} → {dst}", 'SUCCESS')
                self.root.after(0, self._agent_refresh_source_status)
            except Exception as e:
                self._agent_log(f"同步失败: {e}", 'ERROR')
                self.root.after(0, lambda: messagebox.showerror("同步失败", str(e)))

        self.run_async(do_sync)

    def _agent_github_pull(self):
        """从 GitHub 下载 zip 包，解压到统一的部署源目标（不依赖 git）。
        弹窗让用户确认/修改 URL，默认取 user_settings 保存的值。"""
        dst = os.path.join(_app_root(), 'resources', RESOURCE_DIR_NAME)
        from config import GITHUB_REPO_URL

        # 弹窗确认 URL
        dlg = tk.Toplevel(self.root)
        dlg.title("从 GitHub 拉取")
        dlg.transient(self.root)
        dlg.resizable(False, False)
        dlg.grab_set()

        frm = ttk.Frame(dlg, padding="10")
        frm.pack()
        ttk.Label(frm, text="GitHub 源码 zip 下载 URL:").pack(anchor=tk.W)

        url_var = tk.StringVar(value=GITHUB_REPO_URL)
        entry = ttk.Entry(frm, textvariable=url_var, width=60)
        entry.pack(fill=tk.X, pady=(5, 10))
        entry.selection_range(0, tk.END)
        entry.focus()

        ttk.Label(frm, text=f"将下载 zip 并写入: {dst}", foreground="gray").pack(anchor=tk.W)

        btn = ttk.Frame(frm)
        btn.pack(fill=tk.X, pady=(10, 0))
        result = tk.BooleanVar(value=False)

        def go():
            if not url_var.get().strip().startswith(('http://', 'https://')):
                messagebox.showerror("错误", "URL 必须以 http:// 或 https:// 开头", parent=dlg)
                return
            result.set(True)
            dlg.destroy()

        ttk.Button(btn, text="确认拉取", command=go).pack(side=tk.RIGHT, padx=5)
        ttk.Button(btn, text="取消", command=dlg.destroy).pack(side=tk.RIGHT)
        dlg.wait_window()

        if not result.get():
            return
        repo_url = url_var.get().strip()

        # 记住新 URL
        try:
            import config as _cfg
            _cfg._S['github_repo_url'] = repo_url
            _cfg.GITHUB_REPO_URL = repo_url
            settings_file = _cfg._SETTINGS_FILE
            prev = {}
            if os.path.isfile(settings_file):
                with open(settings_file, 'r', encoding='utf-8') as f:
                    prev = json.load(f)
            prev['github_repo_url'] = repo_url
            with open(settings_file + '.tmp', 'w', encoding='utf-8') as f:
                json.dump(prev, f, indent=2, ensure_ascii=False)
            os.replace(settings_file + '.tmp', settings_file)
        except Exception:
            pass

        def do_pull():
            import urllib.request, io
            try:
                # 直接使用用户输入的 URL，不做任何转换
                zip_url = repo_url
                self._agent_log(f"下载 {zip_url} ...", 'INFO')
                self._agent_set_progress("GitHub 拉取：下载中...")

                req = urllib.request.Request(zip_url, headers={'User-Agent': 'cloud-proxy-pool'})
                with urllib.request.urlopen(req, timeout=120) as resp:
                    data = resp.read()

                self._agent_set_progress("GitHub 拉取：解压中...")
                # 清空旧源
                if os.path.isdir(dst):
                    _rmtree_force(dst)
                os.makedirs(os.path.dirname(dst), exist_ok=True)

                # 解压到临时目录
                tmp_dst = dst + '.tmp'
                if os.path.isdir(tmp_dst):
                    _rmtree_force(tmp_dst)
                os.makedirs(tmp_dst, exist_ok=True)

                with zipfile.ZipFile(io.BytesIO(data), 'r') as zf:
                    zf.extractall(tmp_dst)

                # GitHub zip 顶层是个 gamyy-core-master 单一目录，自动剥一层
                entries = os.listdir(tmp_dst)
                if len(entries) == 1 and os.path.isdir(os.path.join(tmp_dst, entries[0])):
                    inner = os.path.join(tmp_dst, entries[0])
                    if os.path.isfile(os.path.join(inner, 'agent', 'server.js')):
                        shutil.move(inner, dst)
                        _rmtree_force(tmp_dst)
                    else:
                        raise RuntimeError("zip 内目录缺 agent/server.js，不像 gamyy-core")
                else:
                    raise RuntimeError("zip 内容结构异常（预期单一顶层目录）")

                self._agent_log(f"GitHub 拉取完成 → {dst}", 'SUCCESS')
                self.root.after(0, self._agent_refresh_source_status)

            except Exception as e:
                self._agent_log(f"GitHub 拉取失败: {e}", 'ERROR')
                try:
                    if os.path.isdir(dst + '.tmp'):
                        _rmtree_force(dst + '.tmp')
                except Exception:
                    pass
                self.root.after(0, lambda: messagebox.showerror("拉取失败", str(e)))
            finally:
                self._agent_set_progress("")

        self.run_async(do_pull)

    def _agent_import_zip(self):
        """让用户选 zip，解压到 _app_root()/resources/<RESOURCE_DIR_NAME>/（统一部署源目标）"""
        zip_path = filedialog.askopenfilename(
            title='选择 gamyy-core 源码压缩包',
            filetypes=[('Zip files', '*.zip'), ('All files', '*.*')],
        )
        if not zip_path:
            return

        dst = os.path.join(_app_root(), 'resources', RESOURCE_DIR_NAME)

        def do_import():
            try:
                # 解压到 tmp 校验后再 swap
                tmp_dst = dst + '.tmp'
                if os.path.isdir(tmp_dst):
                    _rmtree_force(tmp_dst)
                os.makedirs(tmp_dst, exist_ok=True)

                with zipfile.ZipFile(zip_path, 'r') as zf:
                    zf.extractall(tmp_dst)

                # zip 内顶层可能是个 gamyy-core-xxx 单一目录，自动剥一层
                entries = os.listdir(tmp_dst)
                if len(entries) == 1 and os.path.isdir(os.path.join(tmp_dst, entries[0])):
                    inner = os.path.join(tmp_dst, entries[0])
                    if os.path.isfile(os.path.join(inner, 'agent', 'server.js')):
                        # 把内层目录直接当成 dst
                        if os.path.isdir(dst):
                            _rmtree_force(dst)
                        shutil.move(inner, dst)
                        _rmtree_force(tmp_dst)
                    else:
                        raise RuntimeError("zip 内目录缺 agent/server.js")
                elif os.path.isfile(os.path.join(tmp_dst, 'agent', 'server.js')):
                    # zip 顶层就是项目根
                    if os.path.isdir(dst):
                        _rmtree_force(dst)
                    os.rename(tmp_dst, dst)
                else:
                    raise RuntimeError("zip 内容不像 gamyy-core 项目（找不到 agent/server.js）")

                self._agent_log(f"导入完成：{zip_path} → {dst}", 'SUCCESS')
                self.root.after(0, self._agent_refresh_source_status)
            except Exception as e:
                self._agent_log(f"导入失败: {e}", 'ERROR')
                # 清理 tmp
                try:
                    if os.path.isdir(dst + '.tmp'):
                        _rmtree_force(dst + '.tmp')
                except Exception:
                    pass
                self.root.after(0, lambda: messagebox.showerror("导入失败", str(e)))

        self.run_async(do_import)

    def _agent_batch_start(self):
        ids = self._get_agent_targets()
        if ids is None:
            return
        for sid in ids:
            self._agent_set_row_op_status(sid, '等待中...')
        def run():
            self._agent_set_progress(f"启动中 0/{len(ids)}...")
            def step_factory(server_id, host):
                return lambda msg: self._agent_set_row_op_status(server_id, msg)
            def on_progress(done, total, server_id, host, res):
                self._agent_set_progress(f"启动中 {done}/{total}...")
                st = res.get('status') or {}
                final_msg = '✅ 完成' if res.get('ok') else f"❌ {res.get('msg','失败')}"
                self._agent_update_row(
                    server_id,
                    st.get('pm2', '—'), st.get('health', False),
                    st.get('uptime'), st.get('running_tasks'),
                    op_status=final_msg,
                )
            results = self.agent_manager.batch_start(ids, on_progress, step_factory=step_factory)
            ok = sum(1 for r in results if r['ok'])
            self._agent_set_progress(f"启动完成 ✅{ok} ❌{len(results)-ok}")
            self._agent_log(f"启动完成：{ok}/{len(results)} 成功", 'SUCCESS' if ok == len(results) else 'WARNING')
        self.run_async(run)

    def _agent_batch_stop(self):
        ids = self._get_agent_targets()
        if ids is None:
            return
        for sid in ids:
            self._agent_set_row_op_status(sid, '等待中...')
        def run():
            self._agent_set_progress(f"停止中 0/{len(ids)}...")
            def step_factory(server_id, host):
                return lambda msg: self._agent_set_row_op_status(server_id, msg)
            def on_progress(done, total, server_id, host, res):
                self._agent_set_progress(f"停止中 {done}/{total}...")
                st = res.get('status') or {}
                final_msg = '✅ 完成' if res.get('ok') else f"❌ {res.get('msg','失败')}"
                self._agent_update_row(
                    server_id,
                    st.get('pm2', '—'), st.get('health', False),
                    st.get('uptime'), st.get('running_tasks'),
                    op_status=final_msg,
                )
            results = self.agent_manager.batch_stop(ids, on_progress, step_factory=step_factory)
            ok = sum(1 for r in results if r['ok'])
            self._agent_set_progress(f"停止完成 ✅{ok} ❌{len(results)-ok}")
            self._agent_log(f"停止完成：{ok}/{len(results)} 成功", 'SUCCESS' if ok == len(results) else 'WARNING')
        self.run_async(run)

    def _agent_batch_restart(self):
        ids = self._get_agent_targets()
        if ids is None:
            return
        for sid in ids:
            self._agent_set_row_op_status(sid, '等待中...')
        def run():
            self._agent_set_progress(f"重启中 0/{len(ids)}...")
            def step_factory(server_id, host):
                return lambda msg: self._agent_set_row_op_status(server_id, msg)
            def on_progress(done, total, server_id, host, res):
                self._agent_set_progress(f"重启中 {done}/{total}...")
                st = res.get('status') or {}
                final_msg = '✅ 完成' if res.get('ok') else f"❌ {res.get('msg','失败')}"
                self._agent_update_row(
                    server_id,
                    st.get('pm2', '—'), st.get('health', False),
                    st.get('uptime'), st.get('running_tasks'),
                    op_status=final_msg,
                )
            results = self.agent_manager.batch_restart(ids, on_progress, step_factory=step_factory)
            ok = sum(1 for r in results if r['ok'])
            self._agent_set_progress(f"重启完成 ✅{ok} ❌{len(results)-ok}")
            self._agent_log(f"重启完成：{ok}/{len(results)} 成功", 'SUCCESS' if ok == len(results) else 'WARNING')
        self.run_async(run)

    def _agent_refresh_status(self):
        ids = self._get_agent_targets(require_selection=False)
        if ids is None:
            return
        def run():
            self._agent_set_progress(f"查询状态 0/{len(ids)}...")
            def on_progress(done, total, server_id, host, status):
                self._agent_set_progress(f"查询状态 {done}/{total}...")
                self._agent_update_row(
                    server_id,
                    status.get('pm2', '—'),
                    status.get('health', False),
                    status.get('uptime'),
                    status.get('running_tasks'),
                )
            results = self.agent_manager.batch_status(ids, on_progress)
            online = sum(1 for r in results if r.get('pm2') == 'online')
            self._agent_set_progress(f"状态已刷新 🟢{online}/{len(results)}")
        self.run_async(run)

    def _agent_show_logs(self):
        ids = list(self.agent_selected_ids)
        if not ids:
            messagebox.showwarning("提示", "请先选择一台服务器")
            return
        if len(ids) > 1:
            messagebox.showinfo("提示", "查看日志每次只能选择一台服务器")
            return
        if not self.agent_manager:
            return
        server = self.agent_manager.get_server(ids[0])
        if not server:
            return
        def run():
            self._agent_log(f"正在获取 {server['server_host']} 的日志...", 'INFO')
            logs = self.agent_manager.get_server_logs(server, lines=200)
            self._agent_log(f"─── {server['server_host']} PM2日志 ───", 'INFO')
            self._agent_log(logs, 'INFO')
        self.run_async(run)

    def _agent_batch_download_db(self):
        ids = self._get_agent_targets()
        if ids is None:
            return
        target_dir = self._ask_download_dir(self.agent_log_save_dir_var, title='选择 Agent 日志DB 保存目录')
        if not target_dir:
            self._agent_log("已取消下载", 'INFO')
            return
        def run():
            self._agent_set_progress(f"下载DB 0/{len(ids)}...")
            def on_progress(done, total, server_id, host, res):
                self._agent_set_progress(f"下载DB {done}/{total}...")
                final_msg = '✅ 已下载' if res.get('ok') else f"❌ {res.get('msg','失败')}"
                self._agent_set_row_op_status(server_id, final_msg)
            results = self.agent_manager.batch_download_db(ids, target_dir, on_progress)
            ok = sum(1 for r in results if r['ok'])
            self._agent_set_progress(f"下载完成 ✅{ok} ❌{len(results)-ok}")
            self._agent_log(f"日志DB下载完成：{ok}/{len(results)} 成功，保存至 {target_dir}", 'SUCCESS')
        self.run_async(run)

    # 关闭流程的兜底超时（秒）：到点直接 destroy，未完成的 paramiko close 由进程退出回收
    _SHUTDOWN_TIMEOUT_SEC = 15

    def on_closing(self):
        if not messagebox.askokcancel("退出", "确定要退出程序吗？"):
            return

        # 先尽量提前停掉前台循环 + 防止重复触发关闭
        self.is_running = False
        try:
            self.root.protocol("WM_DELETE_WINDOW", lambda: None)
        except Exception:
            pass
        if self.list_refresh_timer:
            try:
                self.root.after_cancel(self.list_refresh_timer)
            except Exception:
                pass

        # 弹一个轻量的"正在停止"小窗（不阻塞）
        try:
            self._shutdown_dialog = tk.Toplevel(self.root)
            self._shutdown_dialog.title("退出中")
            self._shutdown_dialog.geometry("320x90")
            self._shutdown_dialog.transient(self.root)
            self._shutdown_dialog.protocol("WM_DELETE_WINDOW", lambda: None)
            self._shutdown_dialog.resizable(False, False)
            ttk.Label(
                self._shutdown_dialog,
                text=f"正在停止代理与监控，请稍候...\n（{self._SHUTDOWN_TIMEOUT_SEC} 秒后强制退出）",
                padding=15
            ).pack()
            self._shutdown_dialog.update()
        except Exception:
            self._shutdown_dialog = None

        # 后台线程做实际停止操作（可能耗时，留 daemon=True 让进程退出能强收）
        def _shutdown_work():
            try:
                if self.manager:
                    try:
                        self.manager.stop_all_proxies()  # 现已含监控+心跳
                    except Exception:
                        pass
                    try:
                        self.manager.traffic_monitor.stop_all_monitors()
                    except Exception:
                        pass
            except Exception:
                pass

        self._shutdown_thread = threading.Thread(target=_shutdown_work, daemon=True)
        self._shutdown_started = time.monotonic()
        self._shutdown_thread.start()
        self._poll_shutdown()

    def _poll_shutdown(self):
        """轮询关闭线程：完了 / 超时都立即 root.destroy()"""
        try:
            elapsed = time.monotonic() - self._shutdown_started
            done = not self._shutdown_thread.is_alive()
            if done or elapsed >= self._SHUTDOWN_TIMEOUT_SEC:
                try:
                    if self._shutdown_dialog is not None:
                        self._shutdown_dialog.destroy()
                except Exception:
                    pass
                self.root.destroy()
                return
            self.root.after(150, self._poll_shutdown)
        except Exception:
            try:
                self.root.destroy()
            except Exception:
                pass


def main():
    root = tk.Tk()
    app = ProxyManagerGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()