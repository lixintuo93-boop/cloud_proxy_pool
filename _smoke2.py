import os, glob, time
import tkinter as tk
import gui_app

LOGDIR = os.path.join(os.path.dirname(__file__), 'traffic_logs')
files = sorted(glob.glob(os.path.join(LOGDIR, '*.log')))
print(f"found {len(files)} logs")

root = tk.Tk(); root.withdraw()
win = gui_app.LogAnalyzerWindow(root, files)

deadline = time.time() + 90
while win._draining and time.time() < deadline:
    root.update(); time.sleep(0.02)
root.update()
print("scanned:", sum(1 for f in win.files.values() if f.get('scanned')),
      "errors:", sum(1 for f in win.files.values() if f.get('error')))

# --- 日期下拉候选 ---
dates = list(win.date_combo['values'])
print("date choices:", dates[:6], "... total", len(dates))

allrows = len(win.ip_tree.get_children())
print("rows (全部日期):", allrows)

# 选一个具体日期过滤
if len(dates) > 1:
    pick = dates[1]
    win.date_var.set(pick)
    win.on_date_selected()
    filtered = len(win.ip_tree.get_children())
    # 校验：显示出来的每个文件日期都等于 pick
    ok = True
    for iid in win.ip_tree.get_children():
        k = win.node_info[iid]['key']
        if win._file_day(win.files[k]) != pick:
            ok = False; break
    print(f"filter date={pick}: rows={filtered} all-match={ok}")
    win.date_var.set('全部日期'); win.on_date_selected()

# --- 复制端口原始日志 ---
target = None
for k, f in win.files.items():
    if f.get('scanned') and not f.get('error') and f['totals']['ports'] > 0:
        target = (k, f); break
k, f = target
port = sorted(f['port_stats'].keys())[0]
win.show_port_details(k, port)               # 填详情 + 建 raw 映射
nrows = len(win.detail_tree.get_children())
print(f"detail rows for port {port}: {nrows}")

# Ctrl+A 全选 + Ctrl+C 复制
win._select_all_details()
sel = len(win.detail_tree.selection())
win._copy_detail_selected()
clip = win.clipboard_get()
clip_lines = [l for l in clip.split('\n') if l and not l.startswith('#')]
print(f"select-all={sel}  copied-detail-lines={len(clip_lines)}")
print("first copied raw:", clip_lines[0][:70] if clip_lines else "(none)")

# 端口右键菜单复制（带注释头）
win._copy_port_raw(k, port)
clip2 = win.clipboard_get()
head = clip2.split('\n')[0]
body = [l for l in clip2.split('\n') if l and not l.startswith('#')]
print("port-copy header:", head)
print("port-copy body lines:", len(body), " == packets:", f['totals'] and len(f['port_data'][port]))

# 验证复制的是原始行（与解析的 raw 一致）
raw0 = f['port_data'][port][0]['raw']
print("raw matches copy:", raw0 in clip2)

print("OK")
root.destroy()
