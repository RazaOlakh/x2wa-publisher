<#
.SYNOPSIS
  Optional: registers the controller as a Windows service, supervised by NSSM.

.DESCRIPTION
  The recommended way to run the controller on Windows is the per-user silent
  launcher (install-startup.ps1): it runs in the logged-in user's session,
  which is the context where headless Chromium and the WhatsApp session are
  known to work, and it needs no administrator rights.

  This script is the alternative for a machine that wants OS-level supervision:
  a real Windows service that starts at boot, restarts when it exits, and has
  a status. It uses NSSM (Non-Sucking Service Manager) and the same in-process
  supervisor the launcher runs, so crash recovery and WhatsApp reconnection are
  unchanged.

  IMPORTANT: this script is NOT run automatically and is NOT verified on a
  physical Windows host in this environment. It must be checked on a real
  Windows machine before being relied on. See the README's Windows section.

  The service runs as the logged-in user by default, never LocalSystem, because
  the WhatsApp LocalAuth session lives under %LOCALAPPDATA% of that user; a
  service running as LocalSystem would look under the system profile and not
  find the existing session.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 install
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 status
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 uninstall
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status', 'start', 'stop', 'restart')]
  [string]$Action = 'install',
  [string]$NssmPath = 'nssm',
  [string]$ServiceName = 'x2wa-controller'
)

$ErrorActionPreference = 'Stop'

$ControllerDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\controller')).Path
$SupervisorJs  = Join-Path $ControllerDir 'src\supervisor.js'
$NodeExe       = (Get-Command node -ErrorAction SilentlyContinue).Source
$DataRoot      = Join-Path $env:LOCALAPPDATA 'x-whatsapp-poster'
$LogFile       = Join-Path $DataRoot 'controller.log'
$ErrLog        = Join-Path $DataRoot 'controller.err.log'
# Rotate the log at 2 MB, keeping one rotated copy.
$RotateBytes   = 2097152

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Test-Prerequisites {
  if (-not (Get-Command $NssmPath -ErrorAction SilentlyContinue)) {
    throw "NSSM not found ('$NssmPath'). Download nssm.exe from https://nssm.cc, put it on PATH, or pass -NssmPath 'C:\path\to\nssm.exe'."
  }
  if (-not $NodeExe) { throw "Node.js 18+ not found in PATH." }
  if (-not (Test-Path -LiteralPath $SupervisorJs)) { throw "supervisor not found at $SupervisorJs" }
  if (-not (Test-Path -LiteralPath (Join-Path $ControllerDir 'node_modules\whatsapp-web.js'))) {
    throw "controller dependencies missing - run: (cd '$ControllerDir'; npm install)"
  }
}

function Get-ServiceAccount {
  # The password is entered through the credential prompt and handed straight
  # to NSSM; it is never written to the script, the console, or a log.
  $cred = Get-Credential -Message "Windows account to run the controller (your account, so it can read $DataRoot)"
  if (-not $cred) { throw "no account given" }
  $user = $cred.UserName
  if ($user -match 'SYSTEM|LOCAL SERVICE|NETWORK SERVICE') {
    Write-Warning "Running the service as $user will not find the WhatsApp session in $DataRoot (that is per-user). Expect a fresh QR scan."
  }
  return @{ UserName = $user; Password = $cred.GetNetworkCredential().Password }
}

function Invoke-Nssm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NssmArgs)
  & $NssmPath @NssmArgs
  if ($LASTEXITCODE -ne 0) { throw "nssm $($NssmArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

switch ($Action) {
  'install' {
    Test-Prerequisites
    if (-not (Test-Path -LiteralPath $DataRoot)) { New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null }
    $acct = Get-ServiceAccount

    Invoke-Nssm install $ServiceName $NodeExe $SupervisorJs
    Invoke-Nssm set $ServiceName AppDirectory $ControllerDir
    Invoke-Nssm set $ServiceName AppStdout $LogFile
    Invoke-Nssm set $ServiceName AppStderr $ErrLog
    Invoke-Nssm set $ServiceName AppRotateFiles 1
    Invoke-Nssm set $ServiceName AppRotateBytes $RotateBytes
    Invoke-Nssm set $ServiceName AppRestartDelay 10000
    Invoke-Nssm set $ServiceName AppExit Default Restart
    Invoke-Nssm set $ServiceName ObjectName $acct.UserName $acct.Password

    Write-Step "Service '$ServiceName' installed (runs the supervisor; restarts when it exits)."
    Write-Host "    Account   : $($acct.UserName)"
    Write-Host "    Directory : $ControllerDir"
    Write-Host "    Logs      : $LogFile , $ErrLog (rotated at 2 MB)"
    Write-Host "    Start it  : $PSCommandPath start"
    Write-Host "    Verify    : $PSCommandPath status ; Get-Content '$LogFile' -Tail 30"
  }
  'uninstall' {
    Invoke-Nssm stop $ServiceName
    Invoke-Nssm remove $ServiceName confirm
    Write-Step "Service '$ServiceName' removed. Your WhatsApp session in $DataRoot was left untouched."
  }
  'status' {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) { Write-Host "service: $($svc.Status) ($($svc.StartType))" -ForegroundColor Green }
    else { Write-Host "service: not installed" -ForegroundColor Yellow }
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$SupervisorJs*" }
    if ($procs) { foreach ($p in $procs) { Write-Host "running  pid $($p.ProcessId)" -ForegroundColor Green } }
    else { Write-Host "not running" -ForegroundColor Yellow }
    try {
      $s = Invoke-RestMethod -Uri 'http://127.0.0.1:47825/status' -TimeoutSec 3
      Write-Host "controller state: $($s.state)"
    } catch { Write-Host "controller not answering on 127.0.0.1:47825" -ForegroundColor Yellow }
  }
  'start'   { Invoke-Nssm start $ServiceName;   Write-Step "started" }
  'stop'    { Invoke-Nssm stop $ServiceName;    Write-Step "stopped" }
  'restart' { Invoke-Nssm restart $ServiceName; Write-Step "restarted" }
}
