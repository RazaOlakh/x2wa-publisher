@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0rerun-connection.ps1"
if %ERRORLEVEL% neq 0 pause
