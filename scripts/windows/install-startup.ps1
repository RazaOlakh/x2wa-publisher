<#
.SYNOPSIS
  Installs (or removes) per-user startup for the X -> WhatsApp Channel Poster controller.

.DESCRIPTION
  Creates a launcher script and a shortcut in the current user's Startup
  folder, so the controller starts when the user logs in - no administrator
  rights, no scheduled task with stored credentials.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-startup.ps1 install
  powershell -ExecutionPolicy Bypass -File install-startup.ps1 status
  powershell -ExecutionPolicy Bypass -File install-startup.ps1 uninstall
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status', 'restart')]
  [string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'

$ServiceName   = 'x2wa-controller'
$ControllerDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\controller')).Path
$ControllerJs  = Join-Path $ControllerDir 'src\server.js'
$LauncherName  = "$ServiceName.cmd"
$StartupDir    = [Environment]::GetFolderPath('Startup')
$LauncherPath  = Join-Path $StartupDir $LauncherName
$DataRoot      = Join-Path $env:LOCALAPPDATA 'x-whatsapp-poster'
$SessionDir    = Join-Path $DataRoot 'whatsapp-session'
$TmpRoot       = Join-Path $DataRoot 'tmp'
$LogFile       = Join-Path $DataRoot 'controller.log'
$ChromePath    = Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $ChromePath)) {
  $ChromePath = Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
}
if (-not (Test-Path $ChromePath)) { $ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe' }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Get-ControllerProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ControllerJs*" }
}

function Test-Prerequisites {
  if (-not (Test-Path $ControllerJs)) { throw "controller not found at $ControllerJs" }
  if (-not (Test-Path (Join-Path $ControllerDir 'node_modules\whatsapp-web.js'))) {
    throw "controller dependencies missing - run: (cd '$ControllerDir'; npm install)"
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js 18+ not found in PATH. Install it from https://nodejs.org and reopen the terminal." }
  $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $ff) { Write-Warning "ffmpeg/ffprobe not found on PATH - video posts will fail. Install ffmpeg and reopen the terminal." }
}

function New-Launcher {
  Write-Step "Writing launcher to $LauncherPath"
  $nodeExe = (Get-Command node).Source
  # A hidden console window; the controller logs to the file and to the
  # session log. The lock file prevents a duplicate controller.
  $body = @"
@echo off
setlocal
set "CONTROLLER_PORT=47825"
set "SESSION_DIR=$SessionDir"
set "TMP_ROOT=$TmpRoot"
set "CHROME_PATH=$ChromePath"
if not exist "%LOCALAPPDATA%\x-whatsapp-poster" mkdir "%LOCALAPPDATA%\x-whatsapp-poster"
start "x2wa-controller" /min "$nodeExe" "$ControllerJs" >> "$LogFile" 2>&1
"@
  Set-Content -Path $LauncherPath -Value $body -Encoding ASCII
}

switch ($Action) {
  'install' {
    Test-Prerequisites
    if (-not (Test-Path $StartupDir)) { throw "Startup folder not found: $StartupDir" }
    New-Launcher
    Write-Step "Installed. The controller will start at every logon."
    Write-Host "    Session dir : $SessionDir"
    Write-Host "    Log file    : $LogFile"
    Write-Host "    Status      : $PSScriptRoot\install-startup.ps1 status"
    Write-Host "    Remove      : $PSScriptRoot\install-startup.ps1 uninstall"
  }
  'uninstall' {
    if (Test-Path $LauncherPath) {
      Write-Step "Removing $LauncherPath"
      Remove-Item -Path $LauncherPath -Force
    } else {
      Write-Host "Nothing to remove at $LauncherPath"
    }
    $procs = Get-ControllerProcess
    foreach ($p in $procs) { Write-Step "Stopping controller pid $($p.ProcessId)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "Your WhatsApp session in $SessionDir was left untouched."
  }
  'status' {
    $procs = Get-ControllerProcess
    if ($procs) {
      foreach ($p in $procs) { Write-Host "running  pid $($p.ProcessId)" -ForegroundColor Green }
    } else {
      Write-Host "not running" -ForegroundColor Yellow
    }
    try {
      $s = Invoke-RestMethod -Uri 'http://127.0.0.1:47825/status' -TimeoutSec 3
      Write-Host "controller state: $($s.state)  session: $($s.sessionDir)"
    } catch {
      Write-Host "controller not answering on 127.0.0.1:47825" -ForegroundColor Yellow
    }
    if (Test-Path $LauncherPath) { Write-Host "startup entry: $LauncherPath" } else { Write-Host "startup entry: not installed" -ForegroundColor Yellow }
  }
  'restart' {
    $procs = Get-ControllerProcess
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    if (Test-Path $LauncherPath) { Start-Process -FilePath $LauncherPath | Out-Null; Write-Step 'Restarted via startup launcher' }
    else { throw 'not installed - run: install-startup.ps1 install' }
    Start-Sleep -Seconds 5
    & $PSCommandPath status
  }
}