<#
.SYNOPSIS
  Checks and reruns the X -> WhatsApp controller and tray companion connection (2-in-1).
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$Silent
)

if ($Silent) {
  try {
    $win32Def = @'
using System;
using System.Runtime.InteropServices;
public class Win32Rerun {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();
}
'@
    if (-not ([System.Management.Automation.PSTypeName]'Win32Rerun').Type) {
      Add-Type -TypeDefinition $win32Def -ErrorAction SilentlyContinue
    }
    $consoleHandle = [Win32Rerun]::GetConsoleWindow()
    if ($consoleHandle -and $consoleHandle -ne [IntPtr]::Zero) {
      [Win32Rerun]::ShowWindowAsync($consoleHandle, 0) | Out-Null
    }
  } catch {}
}

function Show-Notification {
  param(
    [string]$Title,
    [string]$Message,
    [string]$IconType = 'Info'
  )
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $iconCandidates = @(
      (Join-Path $PSScriptRoot 'x2wa.ico'),
      (Join-Path $env:LOCALAPPDATA 'x-whatsapp-poster\x2wa.ico')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    if ($iconCandidates) {
      $ni.Icon = New-Object System.Drawing.Icon($iconCandidates[0])
    } else {
      $ni.Icon = [System.Drawing.SystemIcons]::Information
    }
    $tipIcon = switch ($IconType) {
      'Warning' { [System.Windows.Forms.ToolTipIcon]::Warning }
      'Error'   { [System.Windows.Forms.ToolTipIcon]::Error }
      default   { [System.Windows.Forms.ToolTipIcon]::Info }
    }
    $ni.Visible = $true
    $ni.ShowBalloonTip(3000, $Title, $Message, $tipIcon)
    Start-Sleep -Seconds 3
    $ni.Visible = $false
    $ni.Dispose()
  } catch {}
}

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { (Get-Location).Path }
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
$Port = 47825
$StartupScript = Join-Path $ScriptDir 'install-startup.ps1'

if (-not $Silent) {
  Write-Host ""
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host "   X -> WhatsApp Connection Manager     " -ForegroundColor Cyan
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host ""
}

function Get-ControllerStatus {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 3 -ErrorAction Stop
  } catch {
    return $null
  }
}

$status = Get-ControllerStatus
$needsRestart = $Force -or ($null -eq $status) -or ($status.state -ne 'ready')

if (-not $needsRestart) {
  if ($Silent) {
    # Ensure tray companion is running too
    & powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $StartupScript start | Out-Null
    Show-Notification -Title "X -> WhatsApp Controller" -Message "Controller is already connected and ready." -IconType 'Info'
    exit 0
  }
  Write-Host "[OK] Controller is already running and connected!" -ForegroundColor Green
  Write-Host "  State   : $($status.state)" -ForegroundColor Green
  if ($status.me -and $status.me._serialized) {
    Write-Host "  Account : $($status.me._serialized)" -ForegroundColor Green
  }
  Write-Host "  Session : $($status.sessionDir)"
  Write-Host ""
  Write-Host "Press [R] within 5 seconds to force a reconnect, or any other key to exit..." -ForegroundColor Yellow

  $hasConsole = $false
  try { $hasConsole = [Console]::KeyAvailable -or $true } catch { $hasConsole = $false }

  $keyPressed = $null
  if ($hasConsole) {
    $startTime = [DateTime]::Now
    while (([DateTime]::Now - $startTime).TotalSeconds -lt 5) {
      try {
        if ([Console]::KeyAvailable) {
          $keyPressed = [Console]::ReadKey($true).Key
          break
        }
      } catch { break }
      Start-Sleep -Milliseconds 100
    }
  } else {
    Start-Sleep -Seconds 1
  }

  if ($keyPressed -ne [ConsoleKey]::R) {
    Write-Host "Connection is healthy. Exiting..." -ForegroundColor Gray
    Start-Sleep -Seconds 1
    exit 0
  }
  Write-Host "Reconnection requested..." -ForegroundColor Yellow
}

if ($Silent) {
  & powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $StartupScript restart | Out-Null
} else {
  Write-Host "Restarting controller and cleaning up stale processes..." -ForegroundColor Cyan
  & powershell -NoProfile -ExecutionPolicy Bypass -File $StartupScript restart
  Write-Host ""
  Write-Host "Checking connection status..." -ForegroundColor Cyan
}

$ready = $false
$lastState = $null
for ($i = 1; $i -le 15; $i++) {
  Start-Sleep -Seconds 1
  $s = Get-ControllerStatus
  if ($s) {
    $lastState = $s.state
    if ($s.state -eq 'ready') {
      $ready = $true
      if ($Silent) {
        $acct = if ($s.me -and $s.me._serialized) { " ($($s.me._serialized))" } else { "" }
        Show-Notification -Title "X -> WhatsApp Controller" -Message "Controller connected and ready!$acct" -IconType 'Info'
      } else {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "  [SUCCESS] Controller is Ready!        " -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        if ($s.me -and $s.me._serialized) {
          Write-Host "  Account : $($s.me._serialized)" -ForegroundColor Green
        }
        Write-Host "  State   : $($s.state)" -ForegroundColor Green
        Write-Host "  Session : $($s.sessionDir)"
      }
      break
    } elseif ($s.state -eq 'qr') {
      if ($Silent) {
        Show-Notification -Title "X -> WhatsApp Controller" -Message "QR scan required! Open the extension popup in Chrome to pair." -IconType 'Warning'
      } else {
        Write-Host ""
        Write-Host "[ACTION REQUIRED] QR scan required! Open the extension popup in Chrome to pair." -ForegroundColor Yellow
      }
      break
    } else {
      if (-not $Silent) { Write-Host -NoNewline "." }
    }
  } else {
    if (-not $Silent) { Write-Host -NoNewline "." }
  }
}

if ($Silent) {
  if (-not $ready -and $lastState -ne 'qr') {
    $msg = if ($lastState) { "Reported state: $lastState. Check tray icon." } else { "Controller did not respond on port $Port." }
    Show-Notification -Title "X -> WhatsApp Controller" -Message $msg -IconType 'Warning'
  }
  exit 0
}

if (-not $ready -and $lastState -ne 'qr') {
  Write-Host ""
  if ($lastState) {
    Write-Host "[WARNING] Controller is running but reported state: $lastState" -ForegroundColor Yellow
  } else {
    Write-Host "[ERROR] Controller did not respond on port $Port." -ForegroundColor Red
  }
}

Write-Host ""
if ($hasConsole) {
  Write-Host "Press any key to close this window..."
  try { $null = [Console]::ReadKey($true) } catch {}
} else {
  Start-Sleep -Seconds 2
}
