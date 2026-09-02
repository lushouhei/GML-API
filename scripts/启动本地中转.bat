@echo off
chcp 65001 >nul
title GML-API 本地中转服务（关掉本窗口 ZCode 就连不上了）
cd /d "%~dp0.."
python scripts\local_proxy.py
pause
