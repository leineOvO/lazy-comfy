@echo off
chcp 65001 >nul
title lazy-comfy
setlocal
cd /d "%~dp0"

echo ============================================
echo   lazy-comfy - ComfyUI 智能休眠代理
echo ============================================
echo.
echo ComfyUI 目录：%COMFY_ROOT%
echo （留空表示让代理自动查找；要指定就右键编辑本文件，或先 set COMFY_ROOT=你的目录）
echo.

rem 便携包请指向 ...\ComfyUI_windows_portable\ComfyUI（内层 ComfyUI）
if not defined COMFY_ROOT set "COMFY_ROOT="

if defined COMFY_ROOT (
  node "%~dp0lazy-comfy.mjs" --root "%COMFY_ROOT%" --idle 10 --stop 30
) else (
  node "%~dp0lazy-comfy.mjs" --idle 10 --stop 30
)

echo.
echo 代理已退出。
pause
