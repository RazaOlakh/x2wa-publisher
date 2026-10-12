<#
.SYNOPSIS
  Checks and reruns the X -> WhatsApp controller connection if stopped.
#>
[CmdletBinding()]
param(
  [switch]$Force
)

$Port = 47825
$StartupScript = Join-Path $PSScriptRoot 'install-startup.ps1'

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   X -> WhatsApp Connection Manager     " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

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

Write-Host "Restarting controller and cleaning up stale processes..." -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File $StartupScript restart

Write-Host ""
Write-Host "Checking connection status..." -ForegroundColor Cyan

$ready = $false
$lastState = $null
for ($i = 1; $i -le 15; $i++) {
  Start-Sleep -Seconds 1
  $s = Get-ControllerStatus
  if ($s) {
    $lastState = $s.state
    if ($s.state -eq 'ready') {
      $ready = $true
      Write-Host ""
      Write-Host "========================================" -ForegroundColor Green
      Write-Host "  [SUCCESS] Controller is Ready!        " -ForegroundColor Green
      Write-Host "========================================" -ForegroundColor Green
      if ($s.me -and $s.me._serialized) {
        Write-Host "  Account : $($s.me._serialized)" -ForegroundColor Green
      }
      Write-Host "  State   : $($s.state)" -ForegroundColor Green
      Write-Host "  Session : $($s.sessionDir)"
      break
    } elseif ($s.state -eq 'qr') {
      Write-Host ""
      Write-Host "[ACTION REQUIRED] QR scan required! Open the extension popup in Chrome to pair." -ForegroundColor Yellow
      break
    } else {
      Write-Host -NoNewline "."
    }
  } else {
    Write-Host -NoNewline "."
  }
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
