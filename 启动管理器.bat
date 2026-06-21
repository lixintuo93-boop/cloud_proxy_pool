@echo off
chcp 65001 >nul
title SOCKS5 Proxy Manager v3.0
cd /d "%~dp0"
python gui_app.py
pause
