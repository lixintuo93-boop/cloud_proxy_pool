# -*- mode: python ; coding: utf-8 -*-
# cloud_proxy_pool PyInstaller spec — 单文件 GUI EXE
# 打包：pyinstaller cloud_proxy_pool.spec
# 产物：dist/cloud_proxy_pool.exe

import os
import sys
from pathlib import Path

_here = Path(SPECPATH)

_block_cipher = None

# —— 要打进 EXE 的数据目录 / 文件 ——
datas = []

# gamyy-core 源码（完整部署源），打包时如果存在就内置
gamyy_core = _here / 'resources' / 'gamyy_core'
if gamyy_core.is_dir() and (gamyy_core / 'agent' / 'server.js').is_file():
    datas.append((str(gamyy_core), 'resources/gamyy_core'))

# plink.exe（SSH 隧道工具）
plink = _here / 'plink.exe'
if plink.is_file():
    datas.append((str(plink), '.'))

# —— 隐式导入（paramiko 及其 C 扩展依赖） ——
hiddenimports = [
    'paramiko',
    'paramiko.dsskey',
    'paramiko.ecdsakey',
    'paramiko.ed25519key',
    'paramiko.kex_curve25519',
    'paramiko.kex_gex',
    'paramiko.kex_group1',
    'paramiko.kex_group14',
    'paramiko.kex_group16',
    'paramiko.kex_group18',
    'paramiko.kex_gss',
    'paramiko.rsakey',
    'cryptography',
    'bcrypt',
    'nacl',
    'pynacl',
    'sqlite3',
    'json',
    'queue',
    'fnmatch',
]

# —— 排除大模块（matplotlib / numpy / pandas 全家桶） ——
excluded = [
    'matplotlib', 'numpy', 'pandas', 'scipy', 'PIL', 'Pillow',
    'PyQt5', 'PyQt6', 'PySide2', 'PySide6',
    'tkinter.test', 'tkinter.tix',
    'unittest', 'test', 'pdb', 'doctest',
    'distutils', 'setuptools', 'pip', 'wheel',
    'lib2to3', 'ctypes.test',
]

a = Analysis(
    ['gui_app.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excluded,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=_block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=_block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='cloud_proxy_pool',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='icon.ico' if (_here / 'icon.ico').is_file() else None,
)
