#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
流量分析工具 - Traffic Analyzer v1.2
====================================
用于分析网络流量日志，按端口分组显示客户端与服务器的交互

功能特点:
- 支持拖拽文件到窗口自动打开
- 支持直接粘贴数据 (Ctrl+V)
- 支持 .pcap 抓包（调用 tshark 解析）、tcpdump 文本、Wireshark 文本三种格式
- 支持 .pcap/.pcapng/.cap、.7z 和 .log/.txt 文件
- 自动识别客户端和服务器IP
- 按端口首次发送时间排序
- 颜色区分不同类型的数据包
- 支持过滤和搜索
- 支持导出分析结果

使用方法:
1. 直接运行: python traffic_analyzer.py
2. 拖拽文件到窗口自动加载
3. 直接粘贴流量数据 (Ctrl+V)
4. 带参数运行: python traffic_analyzer.py <文件路径>

依赖:
- Python 3.6+
- tkinter (通常Python自带)
- tkinterdnd2 (拖拽支持): pip install tkinterdnd2
- py7zr (可选，用于解压7z文件): pip install py7zr

作者: Claude AI
日期: 2026-01-15
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import re
import os
from datetime import datetime
from collections import defaultdict
import sys

from config import find_tshark

# 尝试导入拖拽支持库
HAS_DND = False
try:
    from tkinterdnd2 import TkinterDnD, DND_FILES

    HAS_DND = True
except ImportError:
    pass

# 尝试导入7z支持库
HAS_PY7ZR = False
HAS_LIBARCHIVE = False

try:
    import py7zr

    HAS_PY7ZR = True
except ImportError:
    pass

if not HAS_PY7ZR:
    try:
        import ctypes
        from ctypes import c_char_p, c_int, c_void_p, c_size_t, c_int64, POINTER, create_string_buffer

        for lib_name in ['libarchive.so.13', 'libarchive.dylib', 'archive.dll']:
            try:
                ctypes.CDLL(lib_name)
                HAS_LIBARCHIVE = True
                break
            except:
                pass
    except:
        pass


class TrafficAnalyzer:
    def __init__(self, root):
        self.root = root
        self.root.title("流量分析工具 - Traffic Analyzer v1.2")
        self.root.geometry("1400x800")
        self.root.minsize(1000, 600)

        # 数据存储
        self.port_data = {}
        self.server_ips = set()
        self.client_ip = None
        self.current_port = None
        self.detected_format = None  # 检测到的数据格式

        # 配置样式
        self.setup_styles()

        # 创建界面
        self.create_widgets()

        # 设置拖拽支持
        self.setup_drag_drop()

    def setup_styles(self):
        """设置界面样式"""
        style = ttk.Style()

        available_themes = style.theme_names()
        for theme in ['vista', 'clam', 'winnative', 'aqua', 'default']:
            if theme in available_themes:
                try:
                    style.theme_use(theme)
                    break
                except:
                    pass

        style.configure("Treeview",
                        background="#ffffff",
                        foreground="#333333",
                        rowheight=26,
                        fieldbackground="#ffffff")
        style.configure("Treeview.Heading",
                        background="#e0e0e0",
                        foreground="#333333")
        style.map("Treeview", background=[('selected', '#0078d4')])

    def create_widgets(self):
        """创建界面组件"""
        # 主框架
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # 顶部工具栏
        self.create_toolbar(main_frame)

        # 分隔线
        ttk.Separator(main_frame, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=5)

        # 内容区域
        self.content_frame = ttk.Frame(main_frame)
        self.content_frame.pack(fill=tk.BOTH, expand=True)

        # 创建拖拽提示区域（初始显示）
        self.create_drop_zone()

        # 创建分析面板（初始隐藏）
        self.create_analysis_panel()

        # 底部状态栏
        self.create_statusbar(main_frame)

        # 初始显示拖拽区域
        self.show_drop_zone()

    def create_drop_zone(self):
        """创建拖拽提示区域"""
        self.drop_frame = ttk.Frame(self.content_frame)

        # 中心容器
        center_frame = ttk.Frame(self.drop_frame)
        center_frame.place(relx=0.5, rely=0.5, anchor=tk.CENTER)

        # 图标
        icon_label = ttk.Label(center_frame, text="📂", font=('', 72))
        icon_label.pack(pady=10)

        # 主提示文字
        if HAS_DND:
            main_text = "拖拽文件到这里"
        else:
            main_text = "点击选择文件"

        main_label = ttk.Label(center_frame, text=main_text, font=('', 18, 'bold'))
        main_label.pack(pady=10)

        # 副提示文字
        sub_text = "支持 .pcap 抓包 (tshark 解析) / tcpdump / Wireshark 格式，.pcap / .7z / .log / .txt 文件"
        sub_label = ttk.Label(center_frame, text=sub_text, font=('', 11), foreground='#666666')
        sub_label.pack(pady=5)

        # 粘贴提示
        paste_text = "💡 也可以直接 Ctrl+V 粘贴流量数据"
        paste_label = ttk.Label(center_frame, text=paste_text, font=('', 11), foreground='#0078d4')
        paste_label.pack(pady=5)

        # 或者点击按钮
        or_label = ttk.Label(center_frame, text="— 或者 —", font=('', 10), foreground='#999999')
        or_label.pack(pady=15)

        btn_frame = ttk.Frame(center_frame)
        btn_frame.pack(pady=5)

        browse_btn = ttk.Button(btn_frame, text="📁 浏览文件", command=self.open_file)
        browse_btn.pack(side=tk.LEFT, padx=5)

        paste_btn = ttk.Button(btn_frame, text="📋 粘贴数据", command=self.paste_data)
        paste_btn.pack(side=tk.LEFT, padx=5)

        # 依赖状态
        status_frame = ttk.Frame(center_frame)
        status_frame.pack(pady=20)

        # 拖拽支持状态
        dnd_status = "✅ 拖拽支持已启用" if HAS_DND else "⚠️ 安装 tkinterdnd2 启用拖拽: pip install tkinterdnd2"
        dnd_color = "#4caf50" if HAS_DND else "#ff9800"
        dnd_label = ttk.Label(status_frame, text=dnd_status, foreground=dnd_color, font=('', 9))
        dnd_label.pack()

        # 7z支持状态
        z7_status = "✅ 7z支持已启用" if (HAS_PY7ZR or HAS_LIBARCHIVE) else "⚠️ 安装 py7zr 支持7z: pip install py7zr"
        z7_color = "#4caf50" if (HAS_PY7ZR or HAS_LIBARCHIVE) else "#ff9800"
        z7_label = ttk.Label(status_frame, text=z7_status, foreground=z7_color, font=('', 9))
        z7_label.pack()

        # 绑定点击事件（作为拖拽的替代）
        self.drop_frame.bind('<Button-1>', lambda e: self.open_file())
        for widget in [center_frame, icon_label, main_label, sub_label]:
            widget.bind('<Button-1>', lambda e: self.open_file())

    def create_analysis_panel(self):
        """创建分析面板"""
        self.analysis_frame = ttk.Frame(self.content_frame)

        # 使用PanedWindow实现可调整大小的分栏
        paned = ttk.PanedWindow(self.analysis_frame, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True)

        # 左侧端口列表
        left_frame = self.create_port_panel(paned)
        paned.add(left_frame, weight=1)

        # 右侧数据详情
        right_frame = self.create_detail_panel(paned)
        paned.add(right_frame, weight=3)

    def show_drop_zone(self):
        """显示拖拽区域"""
        self.analysis_frame.pack_forget()
        self.drop_frame.pack(fill=tk.BOTH, expand=True)

    def show_analysis_panel(self):
        """显示分析面板"""
        self.drop_frame.pack_forget()
        self.analysis_frame.pack(fill=tk.BOTH, expand=True)

    def create_toolbar(self, parent):
        """创建工具栏"""
        toolbar = ttk.Frame(parent)
        toolbar.pack(fill=tk.X, pady=(0, 5))

        # 标题
        title_label = ttk.Label(toolbar, text="📊 流量分析工具", font=('', 14, 'bold'))
        title_label.pack(side=tk.LEFT)

        # 按钮区域
        btn_frame = ttk.Frame(toolbar)
        btn_frame.pack(side=tk.RIGHT)

        self.open_btn = ttk.Button(btn_frame, text="📁 打开文件", command=self.open_file)
        self.open_btn.pack(side=tk.LEFT, padx=5)

        self.paste_btn = ttk.Button(btn_frame, text="📋 粘贴数据", command=self.paste_data)
        self.paste_btn.pack(side=tk.LEFT, padx=5)

        self.clear_btn = ttk.Button(btn_frame, text="🗑️ 清空", command=self.clear_data)
        self.clear_btn.pack(side=tk.LEFT, padx=5)

        self.export_btn = ttk.Button(btn_frame, text="💾 导出", command=self.export_data)
        self.export_btn.pack(side=tk.LEFT, padx=5)

        # 绑定Ctrl+V快捷键
        self.root.bind('<Control-v>', lambda e: self.paste_data())
        self.root.bind('<Control-V>', lambda e: self.paste_data())

    def create_port_panel(self, parent):
        """创建端口列表面板"""
        frame = ttk.LabelFrame(parent, text=" 端口列表 ", padding="5")

        self.port_info_label = ttk.Label(frame, text="共 0 个端口", foreground="#666666")
        self.port_info_label.pack(fill=tk.X, pady=(0, 5))

        # 搜索框
        search_frame = ttk.Frame(frame)
        search_frame.pack(fill=tk.X, pady=(0, 5))

        ttk.Label(search_frame, text="🔍").pack(side=tk.LEFT)
        self.search_var = tk.StringVar()
        self.search_var.trace('w', self.filter_ports)
        search_entry = ttk.Entry(search_frame, textvariable=self.search_var, width=10)
        search_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=3)

        # 端口列表Treeview
        tree_frame = ttk.Frame(frame)
        tree_frame.pack(fill=tk.BOTH, expand=True)

        columns = ('port', 'first_time', 'packets')
        self.port_tree = ttk.Treeview(tree_frame, columns=columns, show='headings',
                                      selectmode='browse')

        self.port_tree.heading('port', text='端口', anchor=tk.W,
                               command=lambda: self.sort_port_tree('port'))
        self.port_tree.heading('first_time', text='首次时间', anchor=tk.W,
                               command=lambda: self.sort_port_tree('first_time'))
        self.port_tree.heading('packets', text='包', anchor=tk.CENTER,
                               command=lambda: self.sort_port_tree('packets'))

        # 压缩列宽
        self.port_tree.column('port', width=55, minwidth=45, stretch=False)
        self.port_tree.column('first_time', width=95, minwidth=80, stretch=True)
        self.port_tree.column('packets', width=35, minwidth=30, stretch=False)

        port_scrollbar = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL,
                                       command=self.port_tree.yview)
        self.port_tree.configure(yscrollcommand=port_scrollbar.set)

        self.port_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        port_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self.port_tree.bind('<<TreeviewSelect>>', self.on_port_select)

        # 绑定复制快捷键和右键菜单
        self.port_tree.bind('<Control-c>', self.copy_port_data)
        self.port_tree.bind('<Control-C>', self.copy_port_data)
        self.port_tree.bind('<Button-3>', self.show_port_context_menu)

        # 创建端口列表右键菜单
        self.port_context_menu = tk.Menu(self.root, tearoff=0)
        self.port_context_menu.add_command(label="📋 复制该端口所有数据", command=self.copy_port_data)
        self.port_context_menu.add_separator()
        self.port_context_menu.add_command(label="📊 导出该端口数据", command=self.export_port_data)

        self.sort_column = 'first_time'
        self.sort_reverse = False

        return frame

    def sort_port_tree(self, col):
        """对端口列表排序"""
        if self.sort_column == col:
            self.sort_reverse = not self.sort_reverse
        else:
            self.sort_column = col
            self.sort_reverse = False

        self.update_port_list()

    def create_detail_panel(self, parent):
        """创建详情面板"""
        frame = ttk.LabelFrame(parent, text=" 交互详情 ", padding="5")

        info_frame = ttk.Frame(frame)
        info_frame.pack(fill=tk.X, pady=(0, 5))

        self.detail_info_label = ttk.Label(info_frame, text="请选择一个端口查看详情",
                                           foreground="#666666")
        self.detail_info_label.pack(side=tk.LEFT)

        filter_frame = ttk.Frame(info_frame)
        filter_frame.pack(side=tk.RIGHT)

        ttk.Label(filter_frame, text="过滤:").pack(side=tk.LEFT, padx=(0, 5))
        self.filter_var = tk.StringVar(value="全部")
        filter_combo = ttk.Combobox(filter_frame, textvariable=self.filter_var,
                                    values=["全部", "客户端→服务器", "服务器→客户端",
                                            "SYN包", "RST包", "FIN包", "数据包"],
                                    state='readonly', width=15)
        filter_combo.pack(side=tk.LEFT)
        filter_combo.bind('<<ComboboxSelected>>', self.apply_filter)

        # 图例
        legend_frame = ttk.Frame(frame)
        legend_frame.pack(fill=tk.X, pady=(0, 5))

        legends = [
            ("🟢 发出", "#e8f5e9"),
            ("🔵 收到", "#e3f2fd"),
            ("🟡 SYN", "#fff3e0"),
            ("🔴 RST", "#ffebee"),
            ("🟣 FIN", "#fce4ec")
        ]
        for text, color in legends:
            lbl = ttk.Label(legend_frame, text=text, background=color, padding=3)
            lbl.pack(side=tk.LEFT, padx=2)

        # 详情Treeview - 支持多选
        detail_tree_frame = ttk.Frame(frame)
        detail_tree_frame.pack(fill=tk.BOTH, expand=True)

        columns = ('time', 'direction', 'src', 'dst', 'protocol', 'flags', 'seq', 'length', 'info')
        self.detail_tree = ttk.Treeview(detail_tree_frame, columns=columns, show='headings',
                                        selectmode='extended')  # extended支持多选

        headers = [
            ('time', '时间', 180, tk.W),
            ('direction', '方向', 50, tk.CENTER),
            ('src', '源地址', 150, tk.W),
            ('dst', '目标地址', 150, tk.W),
            ('protocol', '协议', 70, tk.CENTER),
            ('flags', '标志', 80, tk.CENTER),
            ('seq', '序列号', 100, tk.W),
            ('length', '长度', 60, tk.CENTER),
            ('info', '详细信息', 350, tk.W)
        ]

        for col, text, width, anchor in headers:
            self.detail_tree.heading(col, text=text, anchor=anchor)
            self.detail_tree.column(col, width=width, minwidth=width // 2)

        detail_scrollbar_y = ttk.Scrollbar(detail_tree_frame, orient=tk.VERTICAL,
                                           command=self.detail_tree.yview)
        detail_scrollbar_x = ttk.Scrollbar(detail_tree_frame, orient=tk.HORIZONTAL,
                                           command=self.detail_tree.xview)
        self.detail_tree.configure(yscrollcommand=detail_scrollbar_y.set,
                                   xscrollcommand=detail_scrollbar_x.set)

        self.detail_tree.grid(row=0, column=0, sticky='nsew')
        detail_scrollbar_y.grid(row=0, column=1, sticky='ns')
        detail_scrollbar_x.grid(row=1, column=0, sticky='ew')

        detail_tree_frame.grid_rowconfigure(0, weight=1)
        detail_tree_frame.grid_columnconfigure(0, weight=1)

        self.detail_tree.tag_configure('outgoing', background='#e8f5e9')
        self.detail_tree.tag_configure('incoming', background='#e3f2fd')
        self.detail_tree.tag_configure('syn', background='#fff3e0')
        self.detail_tree.tag_configure('rst', background='#ffebee')
        self.detail_tree.tag_configure('fin', background='#fce4ec')

        self.detail_tree.bind('<Double-1>', self.show_packet_detail)

        # 绑定复制和全选快捷键
        self.detail_tree.bind('<Control-c>', self.copy_detail_data)
        self.detail_tree.bind('<Control-C>', self.copy_detail_data)
        self.detail_tree.bind('<Control-a>', self.select_all_details)
        self.detail_tree.bind('<Control-A>', self.select_all_details)
        self.detail_tree.bind('<Button-3>', self.show_detail_context_menu)

        # 创建详情右键菜单
        self.detail_context_menu = tk.Menu(self.root, tearoff=0)
        self.detail_context_menu.add_command(label="📋 复制选中数据 (Ctrl+C)", command=self.copy_detail_data)
        self.detail_context_menu.add_command(label="📑 全选 (Ctrl+A)", command=self.select_all_details)
        self.detail_context_menu.add_separator()
        self.detail_context_menu.add_command(label="📊 复制所有数据", command=self.copy_all_detail_data)

        return frame

    def show_packet_detail(self, event):
        """双击显示数据包详情"""
        selection = self.detail_tree.selection()
        if not selection:
            return

        item = selection[0]
        values = self.detail_tree.item(item, 'values')

        detail_win = tk.Toplevel(self.root)
        detail_win.title("数据包详情")
        detail_win.geometry("700x450")

        text = tk.Text(detail_win, wrap=tk.WORD, padx=10, pady=10)
        scrollbar = ttk.Scrollbar(detail_win, orient=tk.VERTICAL, command=text.yview)
        text.configure(yscrollcommand=scrollbar.set)

        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        text.pack(fill=tk.BOTH, expand=True)

        labels = ['时间', '方向', '源地址', '目标地址', '协议', '标志', '序列号', '长度', '信息']
        for label, value in zip(labels, values):
            text.insert(tk.END, f"{label}: ", 'bold')
            text.insert(tk.END, f"{value}\n\n")

        text.tag_configure('bold', font=('', 10, 'bold'))
        text.config(state=tk.DISABLED)

    def create_statusbar(self, parent):
        """创建状态栏"""
        statusbar = ttk.Frame(parent)
        statusbar.pack(fill=tk.X, pady=(5, 0))

        ttk.Separator(statusbar, orient=tk.HORIZONTAL).pack(fill=tk.X)

        status_frame = ttk.Frame(statusbar)
        status_frame.pack(fill=tk.X, pady=5)

        self.status_label = ttk.Label(status_frame, text="就绪 - 拖拽文件或点击打开", foreground="#666666")
        self.status_label.pack(side=tk.LEFT)

        self.file_label = ttk.Label(status_frame, text="", foreground="#666666")
        self.file_label.pack(side=tk.RIGHT)

    def setup_drag_drop(self):
        """设置拖拽支持"""
        if HAS_DND:
            # 注册拖拽目标
            self.root.drop_target_register(DND_FILES)
            self.root.dnd_bind('<<Drop>>', self.on_drop)

            # 拖拽进入/离开效果
            self.root.dnd_bind('<<DragEnter>>', self.on_drag_enter)
            self.root.dnd_bind('<<DragLeave>>', self.on_drag_leave)

    def on_drop(self, event):
        """处理拖拽放下事件"""
        # 获取拖拽的文件路径
        files = self.root.tk.splitlist(event.data)
        if files:
            filepath = files[0]
            # 移除可能的花括号（Windows路径）
            filepath = filepath.strip('{}')
            self.load_file(filepath)

        # 恢复正常背景
        self.root.configure(background='')
        return event.action

    def on_drag_enter(self, event):
        """拖拽进入时的视觉反馈"""
        return event.action

    def on_drag_leave(self, event):
        """拖拽离开时恢复"""
        return event.action

    def open_file(self):
        """打开文件对话框"""
        filetypes = [
            ("支持的文件", "*.pcap *.pcapng *.cap *.7z *.log *.txt"),
            ("抓包文件 pcap", "*.pcap *.pcapng *.cap"),
            ("7z压缩包", "*.7z"),
            ("日志文件", "*.log *.txt"),
            ("所有文件", "*.*")
        ]
        filepath = filedialog.askopenfilename(
            title="选择流量日志文件",
            filetypes=filetypes
        )
        if filepath:
            self.load_file(filepath)

    def paste_data(self):
        """从剪贴板粘贴数据"""
        try:
            # 获取剪贴板内容
            clipboard_content = self.root.clipboard_get()

            if not clipboard_content or not clipboard_content.strip():
                messagebox.showwarning("提示", "剪贴板为空，请先复制流量数据")
                return

            # 检查是否像流量数据
            lines = clipboard_content.strip().split('\n')
            valid_lines = 0
            for line in lines[:10]:  # 检查前10行
                if re.search(r'\d+\.\d+\.\d+\.\d+', line):  # 包含IP地址
                    valid_lines += 1

            if valid_lines < 2:
                # 可能不是流量数据，让用户确认
                result = messagebox.askyesno("确认",
                                             f"剪贴板内容可能不是流量数据（共 {len(lines)} 行）。\n是否继续解析？")
                if not result:
                    return

            self.status_label.config(text=f"正在解析粘贴的数据...")
            self.root.update()

            # 解析数据
            self.parse_log(clipboard_content)
            self.update_port_list()

            # 切换到分析面板
            self.show_analysis_panel()

            self.file_label.config(text="📋 粘贴的数据")
            total_packets = sum(len(p['packets']) for p in self.port_data.values())
            self.status_label.config(text=f"解析完成 - 共解析 {total_packets} 条记录，{len(self.port_data)} 个端口")

        except tk.TclError:
            messagebox.showwarning("提示", "剪贴板为空或无法访问")
        except Exception as e:
            import traceback
            messagebox.showerror("错误", f"解析数据失败:\n{str(e)}\n\n{traceback.format_exc()}")
            self.status_label.config(text="解析失败")

    def load_file(self, filepath):
        """加载文件"""
        # 规范化路径
        filepath = os.path.normpath(filepath)

        if not os.path.exists(filepath):
            messagebox.showerror("错误", f"文件不存在:\n{filepath}")
            return

        self.status_label.config(text=f"正在加载: {os.path.basename(filepath)}...")
        self.root.update()

        try:
            low = filepath.lower()
            if low.endswith(('.pcap', '.pcapng', '.cap')):
                # 二进制抓包：用 tshark 解析
                self.parse_pcap(filepath)
            else:
                if low.endswith('.7z'):
                    if not HAS_PY7ZR and not HAS_LIBARCHIVE:
                        messagebox.showerror("错误",
                                             "无法解压7z文件！\n\n请安装 py7zr:\n  pip install py7zr\n\n或者手动解压后选择.log文件")
                        self.status_label.config(text="加载失败 - 缺少7z支持")
                        return
                    log_content = self.extract_7z(filepath)
                else:
                    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                        log_content = f.read()
                self.parse_log(log_content)

            self.update_port_list()

            # 切换到分析面板
            self.show_analysis_panel()

            self.file_label.config(text=f"📄 {os.path.basename(filepath)}")
            total_packets = sum(len(p['packets']) for p in self.port_data.values())
            self.status_label.config(text=f"加载完成 - 共解析 {total_packets} 条记录，{len(self.port_data)} 个端口")

        except Exception as e:
            import traceback
            messagebox.showerror("错误", f"加载文件失败:\n{str(e)}\n\n{traceback.format_exc()}")
            self.status_label.config(text="加载失败")

    def extract_7z(self, filepath):
        """解压7z文件"""
        if HAS_PY7ZR:
            return self._extract_with_py7zr(filepath)
        elif HAS_LIBARCHIVE:
            return self._extract_with_libarchive(filepath)
        else:
            raise Exception("没有可用的7z解压库")

    def _extract_with_py7zr(self, filepath):
        """使用py7zr解压"""
        content = b""
        with py7zr.SevenZipFile(filepath, mode='r') as archive:
            for name, bio in archive.read().items():
                content += bio.read()
        return content.decode('utf-8', errors='ignore')

    def _extract_with_libarchive(self, filepath):
        """使用libarchive解压"""
        import ctypes
        from ctypes import c_char_p, c_int, c_void_p, c_size_t, c_int64, POINTER, create_string_buffer

        libarchive = None
        for lib_name in ['libarchive.so.13', 'libarchive.dylib', 'archive.dll']:
            try:
                libarchive = ctypes.CDLL(lib_name)
                break
            except:
                pass

        if not libarchive:
            raise Exception("无法加载libarchive库")

        archive_read_new = libarchive.archive_read_new
        archive_read_new.restype = c_void_p

        archive_read_support_format_all = libarchive.archive_read_support_format_all
        archive_read_support_format_all.argtypes = [c_void_p]

        archive_read_support_filter_all = libarchive.archive_read_support_filter_all
        archive_read_support_filter_all.argtypes = [c_void_p]

        archive_read_open_filename = libarchive.archive_read_open_filename
        archive_read_open_filename.argtypes = [c_void_p, c_char_p, c_size_t]
        archive_read_open_filename.restype = c_int

        archive_read_next_header = libarchive.archive_read_next_header
        archive_read_next_header.argtypes = [c_void_p, POINTER(c_void_p)]
        archive_read_next_header.restype = c_int

        archive_read_data = libarchive.archive_read_data
        archive_read_data.argtypes = [c_void_p, c_void_p, c_size_t]
        archive_read_data.restype = c_int64

        archive_read_free = libarchive.archive_read_free
        archive_read_free.argtypes = [c_void_p]

        archive_error_string = libarchive.archive_error_string
        archive_error_string.argtypes = [c_void_p]
        archive_error_string.restype = c_char_p

        archive = archive_read_new()
        archive_read_support_format_all(archive)
        archive_read_support_filter_all(archive)

        result = archive_read_open_filename(archive, filepath.encode(), 10240)
        if result != 0:
            err = archive_error_string(archive)
            raise Exception(f"无法打开压缩包: {err.decode() if err else '未知错误'}")

        content = b""
        entry = c_void_p()

        while archive_read_next_header(archive, ctypes.byref(entry)) == 0:
            buf = create_string_buffer(65536)
            while True:
                size = archive_read_data(archive, buf, 65536)
                if size <= 0:
                    break
                content += buf.raw[:size]

        archive_read_free(archive)
        return content.decode('utf-8', errors='ignore')

    def parse_log(self, content):
        """解析流量日志（支持tcpdump和Wireshark格式）"""
        self.port_data.clear()
        self.server_ips.clear()
        self.client_ip = None

        header_match = re.search(r'# Target IPs?: (.+)', content)
        if header_match:
            target_ips = [ip.strip() for ip in header_match.group(1).split(',')]
            self.server_ips.update(target_ips)

        # tcpdump格式正则
        # 2026-01-14 14:58:55.129105 IP 172.19.204.75.57766 > 123.114.40.188.443: Flags [S], ...
        tcpdump_pattern = r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+IP\s+(\d+\.\d+\.\d+\.\d+)\.(\d+)\s+>\s+(\d+\.\d+\.\d+\.\d+)\.(\d+):\s+(.+)'

        # Wireshark格式正则
        # 144781	2026-01-15 01:23:27.012859	192.168.1.9	123.114.40.189	TCP	57610 → 443 [SYN] ...
        # 也支持箭头 -> 或 →
        wireshark_pattern = r'^\d+\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\w+)\s+(.+)'

        all_packets = []
        detected_format = None

        for line in content.replace('\r\n', '\n').split('\n'):
            line = line.strip()
            if not line or line.startswith('#') or line.startswith('tcpdump:') or line.startswith('listening'):
                continue

            packet = None

            # 尝试tcpdump格式
            match = re.match(tcpdump_pattern, line)
            if match:
                detected_format = 'tcpdump'
                timestamp_str, src_ip, src_port, dst_ip, dst_port, details = match.groups()

                try:
                    timestamp = datetime.strptime(timestamp_str, '%Y-%m-%d %H:%M:%S.%f')
                except:
                    continue

                flags_match = re.search(r'Flags \[([^\]]+)\]', details)
                flags = flags_match.group(1) if flags_match else ''

                seq_match = re.search(r'seq\s+(\d+(?::\d+)?)', details)
                seq = seq_match.group(1) if seq_match else ''

                ack_match = re.search(r'ack\s+(\d+)', details)
                ack = ack_match.group(1) if ack_match else ''

                length_match = re.search(r'length\s+(\d+)', details)
                length = length_match.group(1) if length_match else '0'

                win_match = re.search(r'win\s+(\d+)', details)
                win = win_match.group(1) if win_match else ''

                packet = {
                    'timestamp': timestamp,
                    'src_ip': src_ip,
                    'src_port': src_port,
                    'dst_ip': dst_ip,
                    'dst_port': dst_port,
                    'protocol': 'TCP',
                    'flags': flags,
                    'seq': seq,
                    'ack': ack,
                    'length': length,
                    'win': win,
                    'info': details,
                    'raw': line
                }

            # 尝试Wireshark格式
            if not packet:
                match = re.match(wireshark_pattern, line)
                if match:
                    detected_format = 'wireshark'
                    timestamp_str, src_ip, dst_ip, protocol, details = match.groups()

                    try:
                        timestamp = datetime.strptime(timestamp_str, '%Y-%m-%d %H:%M:%S.%f')
                    except:
                        continue

                    # 解析端口信息: "57610 → 443 [SYN]" 或 "443 → 57610 [SYN, ACK]"
                    port_match = re.search(r'(\d+)\s*[→\->]+\s*(\d+)', details)
                    if port_match:
                        src_port = port_match.group(1)
                        dst_port = port_match.group(2)
                    else:
                        continue

                    # 解析标志 [SYN] [ACK] [SYN, ACK] [FIN, ACK] [RST, ACK] 等
                    flags_match = re.search(r'\[([^\]]+)\]', details)
                    flags_raw = flags_match.group(1) if flags_match else ''

                    # 转换Wireshark标志格式为tcpdump格式
                    flags = self._convert_wireshark_flags(flags_raw)

                    # 解析Seq, Ack, Win, Len
                    seq_match = re.search(r'Seq[=\s]+(\d+)', details, re.IGNORECASE)
                    seq = seq_match.group(1) if seq_match else ''

                    ack_match = re.search(r'Ack[=\s]+(\d+)', details, re.IGNORECASE)
                    ack = ack_match.group(1) if ack_match else ''

                    win_match = re.search(r'Win[=\s]+(\d+)', details, re.IGNORECASE)
                    win = win_match.group(1) if win_match else ''

                    len_match = re.search(r'Len[=\s]+(\d+)', details, re.IGNORECASE)
                    length = len_match.group(1) if len_match else '0'

                    packet = {
                        'timestamp': timestamp,
                        'src_ip': src_ip,
                        'src_port': src_port,
                        'dst_ip': dst_ip,
                        'dst_port': dst_port,
                        'protocol': protocol,
                        'flags': flags,
                        'seq': seq,
                        'ack': ack,
                        'length': length,
                        'win': win,
                        'info': details,
                        'raw': line
                    }

            if packet:
                all_packets.append(packet)

        self._build_port_data(all_packets, detected_format)

    def _build_port_data(self, all_packets, detected_format):
        """把扁平 all_packets 按客户端端口归组进 self.port_data（parse_log 与 parse_pcap 共用）"""
        # 检测 client_ip：高端口(>1024) → 低端口(<=1024) 的源端通常是客户端
        for packet in all_packets:
            if self.client_ip is not None:
                break
            try:
                sp = int(packet['src_port']); dp = int(packet['dst_port'])
            except (ValueError, KeyError, TypeError):
                continue
            if sp > 1024 and dp <= 1024:
                self.client_ip = packet['src_ip']
            elif dp > 1024 and sp <= 1024:
                self.client_ip = packet['dst_ip']

        if self.client_ip is None and all_packets:
            port_counts = defaultdict(lambda: defaultdict(int))
            for p in all_packets:
                if int(p['src_port']) > 1024:
                    port_counts[p['src_ip']][p['src_port']] += 1
                if int(p['dst_port']) > 1024:
                    port_counts[p['dst_ip']][p['dst_port']] += 1

            if port_counts:
                self.client_ip = max(port_counts.keys(), key=lambda ip: sum(port_counts[ip].values()))

        for packet in all_packets:
            if packet['src_ip'] == self.client_ip:
                client_port = packet['src_port']
                is_outgoing = True
            elif packet['dst_ip'] == self.client_ip:
                client_port = packet['dst_port']
                is_outgoing = False
            else:
                continue

            packet['is_outgoing'] = is_outgoing

            if client_port not in self.port_data:
                self.port_data[client_port] = {
                    'first_time': None,
                    'packets': []
                }

            if is_outgoing:
                if self.port_data[client_port]['first_time'] is None:
                    self.port_data[client_port]['first_time'] = packet['timestamp']
                elif packet['timestamp'] < self.port_data[client_port]['first_time']:
                    self.port_data[client_port]['first_time'] = packet['timestamp']

            self.port_data[client_port]['packets'].append(packet)

        for port, data in self.port_data.items():
            if data['first_time'] is None and data['packets']:
                data['first_time'] = min(p['timestamp'] for p in data['packets'])
            data['packets'].sort(key=lambda p: p['timestamp'])

        # 记录检测到的格式
        self.detected_format = detected_format

    def parse_pcap(self, filepath):
        """
        用 tshark 解析二进制 pcap，生成与 parse_log 相同的包结构后复用归组逻辑。
        只取 TCP；关闭相对序号以得到与 tcpdump 一致的绝对 seq/ack。
        """
        self.port_data.clear()
        self.server_ips.clear()
        self.client_ip = None

        tshark = find_tshark()
        if not tshark:
            raise RuntimeError(
                "未找到 tshark。请安装 Wireshark（自带 tshark），"
                "默认路径 C:\\Program Files\\Wireshark\\tshark.exe，或将其加入 PATH。"
            )

        # 用 tcp.flags 十六进制位自行解码标志，避免不同 tshark 版本布尔字段
        # 输出 1/0 还是 True/False 的差异
        fields = [
            "frame.time_epoch", "ip.src", "ip.dst", "tcp.srcport", "tcp.dstport",
            "tcp.flags", "tcp.seq", "tcp.ack", "tcp.len", "tcp.window_size",
            "_ws.col.Protocol", "_ws.col.Info",
        ]
        cmd = [tshark, "-r", filepath, "-Y", "tcp",
               "-o", "tcp.relative_sequence_numbers:FALSE",
               "-T", "fields", "-E", "separator=\t", "-E", "occurrence=f"]
        for f in fields:
            cmd += ["-e", f]

        import subprocess
        result = subprocess.run(cmd, capture_output=True, text=True,
                                encoding="utf-8", errors="ignore", timeout=300)
        if result.returncode != 0 and not result.stdout:
            raise RuntimeError(f"tshark 解析失败:\n{(result.stderr or '').strip()[:500]}")

        all_packets = []
        for line in result.stdout.splitlines():
            cols = line.split("\t")
            if len(cols) < 12:
                continue
            t_epoch, src_ip, dst_ip, src_port, dst_port = cols[0:5]
            tcp_flags, seq, ack, length, win, proto = cols[5:11]
            infotxt = "\t".join(cols[11:])  # Info 是最后一列，可能含制表符，合并回去

            if not (src_ip and dst_ip and src_port and dst_port):
                continue
            try:
                timestamp = datetime.fromtimestamp(float(t_epoch))
            except (ValueError, OSError):
                continue

            # 解析 tcp.flags 十六进制位 -> tcpdump 风格短标志 S/F/R/P/U + '.'(ACK)
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

            all_packets.append({
                'timestamp': timestamp,
                'src_ip': src_ip,
                'src_port': src_port,
                'dst_ip': dst_ip,
                'dst_port': dst_port,
                'protocol': proto or 'TCP',
                'flags': flags,
                'seq': seq or '',
                'ack': ack or '',
                'length': length or '0',
                'win': win or '',
                'info': infotxt,
                'raw': infotxt,
            })

        self._build_port_data(all_packets, 'pcap')

    def _convert_wireshark_flags(self, flags_raw):
        """将Wireshark标志格式转换为简短格式"""
        flags_raw = flags_raw.upper()
        result = ''

        # 按照标准顺序：SYN, ACK, FIN, RST, PSH, URG
        if 'SYN' in flags_raw:
            result += 'S'
        if 'FIN' in flags_raw:
            result += 'F'
        if 'RST' in flags_raw:
            result += 'R'
        if 'PSH' in flags_raw:
            result += 'P'
        if 'ACK' in flags_raw:
            result += '.'
        if 'URG' in flags_raw:
            result += 'U'

        return result if result else flags_raw

    def update_port_list(self):
        """更新端口列表"""
        for item in self.port_tree.get_children():
            self.port_tree.delete(item)

        if self.sort_column == 'port':
            sorted_ports = sorted(self.port_data.items(),
                                  key=lambda x: int(x[0]),
                                  reverse=self.sort_reverse)
        elif self.sort_column == 'packets':
            sorted_ports = sorted(self.port_data.items(),
                                  key=lambda x: len(x[1]['packets']),
                                  reverse=self.sort_reverse)
        else:
            sorted_ports = sorted(self.port_data.items(),
                                  key=lambda x: x[1]['first_time'] or datetime.max,
                                  reverse=self.sort_reverse)

        search_text = self.search_var.get().strip()

        for port, data in sorted_ports:
            if search_text and search_text not in str(port):
                continue
            # 只显示时分秒毫秒，不显示年月日
            first_time = data['first_time'].strftime('%H:%M:%S.%f')[:-3] if data['first_time'] else '-'
            packet_count = len(data['packets'])
            self.port_tree.insert('', tk.END, values=(port, first_time, packet_count))

        self.port_info_label.config(text=f"共 {len(self.port_data)} 个端口")

    def filter_ports(self, *args):
        """过滤端口列表"""
        self.update_port_list()

    def on_port_select(self, event):
        """端口选择事件处理"""
        selection = self.port_tree.selection()
        if not selection:
            return

        item = selection[0]
        values = self.port_tree.item(item, 'values')
        port = values[0]

        self.display_port_details(port)

    def display_port_details(self, port):
        """显示端口详情"""
        for item in self.detail_tree.get_children():
            self.detail_tree.delete(item)

        if port not in self.port_data:
            return

        data = self.port_data[port]
        packets = data['packets']

        filter_type = self.filter_var.get()
        if filter_type == "客户端→服务器":
            packets = [p for p in packets if p.get('is_outgoing', True)]
        elif filter_type == "服务器→客户端":
            packets = [p for p in packets if not p.get('is_outgoing', False)]
        elif filter_type == "SYN包":
            packets = [p for p in packets if 'S' in p['flags'] and '.' not in p['flags']]
        elif filter_type == "RST包":
            packets = [p for p in packets if 'R' in p['flags']]
        elif filter_type == "FIN包":
            packets = [p for p in packets if 'F' in p['flags']]
        elif filter_type == "数据包":
            packets = [p for p in packets if int(p['length']) > 0]

        outgoing_count = sum(1 for p in data['packets'] if p.get('is_outgoing', True))
        incoming_count = len(data['packets']) - outgoing_count
        self.detail_info_label.config(
            text=f"端口 {port} | 客户端: {self.client_ip} | 总计: {len(data['packets'])} 条 | "
                 f"发出: {outgoing_count} 条 | 收到: {incoming_count} 条"
        )

        for packet in packets:
            time_str = packet['timestamp'].strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]

            src = f"{packet['src_ip']}:{packet['src_port']}"
            dst = f"{packet['dst_ip']}:{packet['dst_port']}"

            is_outgoing = packet.get('is_outgoing', True)
            direction = "→" if is_outgoing else "←"

            protocol = packet.get('protocol', 'TCP')

            # 使用info字段或构建信息
            info = packet.get('info', '')
            if not info:
                info_parts = []
                if packet['seq']:
                    info_parts.append(f"seq={packet['seq']}")
                if packet['ack']:
                    info_parts.append(f"ack={packet['ack']}")
                if packet['win']:
                    info_parts.append(f"win={packet['win']}")
                info = ', '.join(info_parts)

            flags = packet['flags']
            if 'R' in flags:
                tag = 'rst'
            elif 'S' in flags and '.' not in flags:
                tag = 'syn'
            elif 'F' in flags:
                tag = 'fin'
            elif is_outgoing:
                tag = 'outgoing'
            else:
                tag = 'incoming'

            self.detail_tree.insert('', tk.END, values=(
                time_str, direction, src, dst, protocol, flags,
                packet['seq'], packet['length'], info
            ), tags=(tag,))

        self.current_port = port

    def apply_filter(self, event=None):
        """应用过滤器"""
        if self.current_port:
            self.display_port_details(self.current_port)

    def show_port_context_menu(self, event):
        """显示端口列表右键菜单"""
        # 选中点击的项
        item = self.port_tree.identify_row(event.y)
        if item:
            self.port_tree.selection_set(item)
            self.port_context_menu.post(event.x_root, event.y_root)

    def copy_port_data(self, event=None):
        """复制选中端口的所有数据"""
        selection = self.port_tree.selection()
        if not selection:
            return

        item = selection[0]
        port = self.port_tree.item(item, 'values')[0]

        if port not in self.port_data:
            return

        data = self.port_data[port]
        lines = []

        # 添加头部信息
        lines.append(f"# 端口 {port} 流量数据")
        lines.append(f"# 客户端: {self.client_ip}")
        lines.append(f"# 首次发送时间: {data['first_time']}")
        lines.append(f"# 数据包数量: {len(data['packets'])}")
        lines.append("#" + "=" * 70)
        lines.append("")

        # 添加数据
        for packet in data['packets']:
            direction = "→" if packet.get('is_outgoing', True) else "←"
            line = f"{packet['timestamp']} {direction} {packet['src_ip']}:{packet['src_port']} > {packet['dst_ip']}:{packet['dst_port']} [{packet['flags']}] Len={packet['length']}"
            if packet.get('info'):
                line += f" {packet['info']}"
            lines.append(line)

        # 复制到剪贴板
        text = '\n'.join(lines)
        self.root.clipboard_clear()
        self.root.clipboard_append(text)

        # 显示提示
        self.status_label.config(text=f"已复制端口 {port} 的 {len(data['packets'])} 条数据到剪贴板")

    def export_port_data(self):
        """导出选中端口的数据"""
        selection = self.port_tree.selection()
        if not selection:
            return

        item = selection[0]
        port = self.port_tree.item(item, 'values')[0]

        if port not in self.port_data:
            return

        filepath = filedialog.asksaveasfilename(
            title=f"导出端口 {port} 数据",
            defaultextension=".txt",
            initialfile=f"port_{port}_traffic.txt",
            filetypes=[("文本文件", "*.txt"), ("CSV文件", "*.csv")]
        )

        if not filepath:
            return

        data = self.port_data[port]

        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(f"# 端口 {port} 流量数据\n")
                f.write(f"# 客户端: {self.client_ip}\n")
                f.write(f"# 首次发送时间: {data['first_time']}\n")
                f.write(f"# 数据包数量: {len(data['packets'])}\n")
                f.write("#" + "=" * 70 + "\n\n")

                for packet in data['packets']:
                    direction = "→" if packet.get('is_outgoing', True) else "←"
                    f.write(
                        f"{packet['timestamp']} {direction} {packet['src_ip']}:{packet['src_port']} > {packet['dst_ip']}:{packet['dst_port']} [{packet['flags']}] Len={packet['length']}\n")

            messagebox.showinfo("成功", f"数据已导出到:\n{filepath}")
        except Exception as e:
            messagebox.showerror("错误", f"导出失败:\n{str(e)}")

    def show_detail_context_menu(self, event):
        """显示详情右键菜单"""
        # 如果点击的行不在选中项中，则选中它
        item = self.detail_tree.identify_row(event.y)
        if item:
            current_selection = self.detail_tree.selection()
            if item not in current_selection:
                self.detail_tree.selection_set(item)
        self.detail_context_menu.post(event.x_root, event.y_root)

    def select_all_details(self, event=None):
        """全选详情列表"""
        all_items = self.detail_tree.get_children()
        if all_items:
            self.detail_tree.selection_set(all_items)
        return 'break'  # 阻止默认行为

    def copy_detail_data(self, event=None):
        """复制选中的详情数据"""
        selection = self.detail_tree.selection()
        if not selection:
            return 'break'

        lines = []
        # 添加表头
        lines.append("时间\t方向\t源地址\t目标地址\t协议\t标志\t序列号\t长度\t信息")

        for item in selection:
            values = self.detail_tree.item(item, 'values')
            lines.append('\t'.join(str(v) for v in values))

        text = '\n'.join(lines)
        self.root.clipboard_clear()
        self.root.clipboard_append(text)

        self.status_label.config(text=f"已复制 {len(selection)} 条数据到剪贴板")
        return 'break'

    def copy_all_detail_data(self):
        """复制所有详情数据"""
        all_items = self.detail_tree.get_children()
        if not all_items:
            return

        lines = []
        lines.append("时间\t方向\t源地址\t目标地址\t协议\t标志\t序列号\t长度\t信息")

        for item in all_items:
            values = self.detail_tree.item(item, 'values')
            lines.append('\t'.join(str(v) for v in values))

        text = '\n'.join(lines)
        self.root.clipboard_clear()
        self.root.clipboard_append(text)

        self.status_label.config(text=f"已复制全部 {len(all_items)} 条数据到剪贴板")

    def clear_data(self):
        """清空数据"""
        self.port_data.clear()
        self.server_ips.clear()
        self.client_ip = None
        self.current_port = None

        for item in self.port_tree.get_children():
            self.port_tree.delete(item)
        for item in self.detail_tree.get_children():
            self.detail_tree.delete(item)

        self.port_info_label.config(text="共 0 个端口")
        self.detail_info_label.config(text="请选择一个端口查看详情")
        self.file_label.config(text="")
        self.status_label.config(text="就绪 - 拖拽文件或点击打开")

        # 显示拖拽区域
        self.show_drop_zone()

    def export_data(self):
        """导出数据"""
        if not self.port_data:
            messagebox.showwarning("提示", "没有可导出的数据")
            return

        filepath = filedialog.asksaveasfilename(
            title="导出数据",
            defaultextension=".txt",
            filetypes=[("文本文件", "*.txt"), ("CSV文件", "*.csv"), ("HTML报告", "*.html")]
        )

        if not filepath:
            return

        try:
            if filepath.endswith('.html'):
                self._export_html(filepath)
            elif filepath.endswith('.csv'):
                self._export_csv(filepath)
            else:
                self._export_txt(filepath)

            messagebox.showinfo("成功", f"数据已导出到:\n{filepath}")

        except Exception as e:
            messagebox.showerror("错误", f"导出失败:\n{str(e)}")

    def _export_txt(self, filepath):
        """导出为文本文件"""
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write("=" * 80 + "\n")
            f.write("                     流量分析报告\n")
            f.write("=" * 80 + "\n\n")
            f.write(f"客户端IP: {self.client_ip}\n")
            f.write(f"服务器IP: {', '.join(self.server_ips) if self.server_ips else '自动检测'}\n")
            f.write(f"总端口数: {len(self.port_data)}\n")
            f.write(f"总数据包: {sum(len(p['packets']) for p in self.port_data.values())}\n")
            f.write("=" * 80 + "\n\n")

            sorted_ports = sorted(
                self.port_data.items(),
                key=lambda x: x[1]['first_time'] or datetime.max
            )

            for port, data in sorted_ports:
                f.write(f"\n{'─' * 60}\n")
                f.write(f"端口: {port}\n")
                f.write(f"首次发送时间: {data['first_time']}\n")
                f.write(f"数据包数量: {len(data['packets'])}\n")
                f.write("─" * 60 + "\n")

                for packet in data['packets']:
                    direction = "→" if packet.get('is_outgoing', True) else "←"
                    f.write(f"{packet['timestamp']} {direction} "
                            f"{packet['src_ip']}:{packet['src_port']} > "
                            f"{packet['dst_ip']}:{packet['dst_port']} "
                            f"[{packet['flags']}] len={packet['length']}\n")

    def _export_csv(self, filepath):
        """导出为CSV文件"""
        with open(filepath, 'w', encoding='utf-8-sig') as f:
            f.write("端口,时间,方向,源IP,源端口,目标IP,目标端口,标志,序列号,长度\n")

            sorted_ports = sorted(
                self.port_data.items(),
                key=lambda x: x[1]['first_time'] or datetime.max
            )

            for port, data in sorted_ports:
                for packet in data['packets']:
                    direction = "发出" if packet.get('is_outgoing', True) else "收到"
                    f.write(f"{port},{packet['timestamp']},{direction},"
                            f"{packet['src_ip']},{packet['src_port']},"
                            f"{packet['dst_ip']},{packet['dst_port']},"
                            f"{packet['flags']},{packet['seq']},{packet['length']}\n")

    def _export_html(self, filepath):
        """导出为HTML报告"""
        html_template = """<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>流量分析报告</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #333; border-bottom: 2px solid #0078d4; padding-bottom: 10px; }
        h2 { color: #0078d4; margin-top: 30px; }
        .info { background: #e3f2fd; padding: 15px; border-radius: 4px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f5f5f5; font-weight: bold; }
        tr:hover { background: #f9f9f9; }
        .outgoing { background: #e8f5e9; }
        .incoming { background: #e3f2fd; }
        .syn { background: #fff3e0; }
        .rst { background: #ffebee; }
        .fin { background: #fce4ec; }
        .port-section { margin-top: 20px; border: 1px solid #ddd; border-radius: 4px; }
        .port-header { background: #f5f5f5; padding: 10px 15px; font-weight: bold; cursor: pointer; }
        .port-content { padding: 10px; display: none; }
        .port-section.open .port-content { display: block; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 流量分析报告</h1>
        <div class="info">
            <strong>客户端IP:</strong> {client_ip}<br>
            <strong>服务器IP:</strong> {server_ips}<br>
            <strong>总端口数:</strong> {port_count}<br>
            <strong>总数据包:</strong> {packet_count}
        </div>
        <h2>端口详情</h2>
        {port_sections}
    </div>
    <script>
        document.querySelectorAll('.port-header').forEach(function(header) {{
            header.addEventListener('click', function() {{
                this.parentElement.classList.toggle('open');
            }});
        }});
    </script>
</body>
</html>"""

        port_sections = []
        sorted_ports = sorted(
            self.port_data.items(),
            key=lambda x: x[1]['first_time'] or datetime.max
        )

        for port, data in sorted_ports:
            rows = []
            for packet in data['packets']:
                is_outgoing = packet.get('is_outgoing', True)
                direction = "→" if is_outgoing else "←"
                flags = packet['flags']

                if 'R' in flags:
                    css_class = 'rst'
                elif 'S' in flags and '.' not in flags:
                    css_class = 'syn'
                elif 'F' in flags:
                    css_class = 'fin'
                elif is_outgoing:
                    css_class = 'outgoing'
                else:
                    css_class = 'incoming'

                rows.append(f"""<tr class="{css_class}">
                    <td>{packet['timestamp']}</td>
                    <td>{direction}</td>
                    <td>{packet['src_ip']}:{packet['src_port']}</td>
                    <td>{packet['dst_ip']}:{packet['dst_port']}</td>
                    <td>{packet['flags']}</td>
                    <td>{packet['length']}</td>
                </tr>""")

            section = f"""<div class="port-section">
                <div class="port-header">端口 {port} - {data['first_time']} - {len(data['packets'])} 条记录</div>
                <div class="port-content">
                    <table>
                        <tr><th>时间</th><th>方向</th><th>源地址</th><th>目标地址</th><th>标志</th><th>长度</th></tr>
                        {''.join(rows)}
                    </table>
                </div>
            </div>"""
            port_sections.append(section)

        html = html_template.format(
            client_ip=self.client_ip,
            server_ips=', '.join(self.server_ips) if self.server_ips else '自动检测',
            port_count=len(self.port_data),
            packet_count=sum(len(p['packets']) for p in self.port_data.values()),
            port_sections=''.join(port_sections)
        )

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(html)


def main():
    # 设置DPI感知（Windows）
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except:
        pass

    # 创建根窗口
    if HAS_DND:
        root = TkinterDnD.Tk()
    else:
        root = tk.Tk()

    app = TrafficAnalyzer(root)

    # 如果有命令行参数，自动加载文件
    if len(sys.argv) > 1:
        filepath = sys.argv[1]
        if os.path.exists(filepath):
            root.after(100, lambda: app.load_file(filepath))

    root.mainloop()


if __name__ == '__main__':
    main()