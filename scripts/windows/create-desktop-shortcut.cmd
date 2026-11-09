@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-desktop-shortcut.ps1"
if %ERRORLEVEL% neq 0 pause
