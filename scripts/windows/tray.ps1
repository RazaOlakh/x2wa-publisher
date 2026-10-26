<#
.SYNOPSIS
  System tray companion for the X -> WhatsApp Channel Poster controller.

.DESCRIPTION
  Adds a notification-area (system tray) icon that monitors the controller's
  localhost status endpoint and offers quick desktop actions, so the user can
  watch the connection, restart / disconnect the controller, open the settings
  or dashboard, view the log, open the session folder or exit - without
  dropping to PowerShell one-liners or the Chrome extension popup.

  The icon polls http://127.0.0.1:47825/status on a timer and reflects the
  controller state (ready / starting / reconnecting / qr / stopped / error) in
  its colour and tooltip.

  Runs per-user - no administrator rights. The runtime is Windows only (WinForms
  NotifyIcon); the static contract it is checked against lives in tray.test.js.

.NOTES
  Start it alongside the controller, e.g. from a shortcut in the Startup
  folder or manually with:

    powershell -ExecutionPolicy Bypass -File tray.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$Port = 47825
$StatusUri = "http://127.0.0.1:$Port/status"
$DataRoot = Join-Path $env:LOCALAPPDATA 'x-whatsapp-poster'
$SessionDir = Join-Path $DataRoot 'whatsapp-session'
$LogFile = Join-Path $DataRoot 'controller.log'
$StartupScript = Join-Path $PSScriptRoot 'install-startup.ps1'

function Get-ControllerStatus {
  try { return Invoke-RestMethod -Uri $StatusUri -TimeoutSec 3 -ErrorAction Stop } catch { return $null }
}

function Get-ControllerProcess {
  # The supervisor runs the controller, so a running controller is either the
  # supervisor (node supervisor.js) or the controller it is supervising
  # (node server.js). Match both.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*controller\src\server.js*" -or $_.CommandLine -like "*controller\src\supervisor.js*") }
}

function Get-SessionChromeProcesses {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$SessionDir*" }
}

function Find-Chrome {
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return 'C:\Program Files\Google\Chrome\Application\chrome.exe'
}

function Restart-Controller {
  foreach ($p in @(Get-ControllerProcess)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($p in @(Get-SessionChromeProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 10; $i++) { if (-not (Get-ControllerProcess)) { break }; Start-Sleep -Seconds 1 }
  Start-Sleep -Seconds 2
  & powershell -NoProfile -ExecutionPolicy Bypass -File $StartupScript restart | Out-Null
}

function Stop-Controller {
  foreach ($p in @(Get-ControllerProcess)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($p in @(Get-SessionChromeProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Open-Logs {
  if (Test-Path -LiteralPath $LogFile) { Start-Process -FilePath notepad -ArgumentList $LogFile -ErrorAction SilentlyContinue | Out-Null }
}

function Open-SessionFolder {
  if (Test-Path -LiteralPath $SessionDir) { Start-Process -FilePath explorer -ArgumentList $SessionDir -ErrorAction SilentlyContinue | Out-Null }
}

function Open-Settings {
  $chrome = Find-Chrome
  if (-not ($chrome -and (Test-Path -LiteralPath $chrome))) { return }
  Start-Process -FilePath $chrome -ArgumentList @('--new-window', 'chrome://extensions') -ErrorAction SilentlyContinue | Out-Null
}

function Get-StateColor {
  param([string]$state)
  switch -Lower $state {
    'ready'        { return [System.Drawing.Color]::FromArgb(90, 200, 90) }
    'qr'           { return [System.Drawing.Color]::FromArgb(240, 180, 40) }
    'reconnecting' { return [System.Drawing.Color]::FromArgb(240, 180, 40) }
    default        { return [System.Drawing.Color]::FromArgb(220, 60, 60) }
  }
}

function New-StateIcon {
  param([System.Drawing.Color]$background)
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse(0, 0, 32, 32)
  $brush = New-Object System.Drawing.SolidBrush $background
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $g.Dispose()
  $icon = New-Object System.Drawing.Icon -ArgumentList @($bmp, 32, 32)
  $bmp.Dispose()
  return $icon
}

function Update-Tray {
  try {
    $s = Get-ControllerStatus
    $state = if ($s) { [string]$s.state } else { 'stopped' }
    $notify.Text = "X -> WhatsApp Controller: $state"
    $notify.Icon = New-StateIcon (Get-StateColor $state)
  } catch {
    # A tray must never take the polling loop down with it.
  }
}

function Exit-Tray {
  if ($timer) { $timer.Stop() }
  if ($notify) { $notify.Visible = $false; $notify.Dispose() }
  if ($script:winForms) { [System.Windows.Forms.Application]::Exit() }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:winForms = [System.Windows.Forms.Application]
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-StateIcon (Get-StateColor 'stopped')
$notify.Text = 'X -> WhatsApp Controller: stopped'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Reconnect / Restart Controller'
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Disconnect / Stop Controller'
$miSettings = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Open Settings / Dashboard'
$miLogs = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'View Logs'
$miSession = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Open Session Folder'
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Exit'
foreach ($mi in @($miRestart, $miStop, $miSettings, $miLogs, $miSession, $miExit)) { $menu.Items.Add($mi) | Out-Null }
$notify.ContextMenuStrip = $menu

Register-ObjectEvent -InputObject $miRestart -EventName Click -Action { Restart-Controller } | Out-Null
Register-ObjectEvent -InputObject $miStop -EventName Click -Action { Stop-Controller } | Out-Null
Register-ObjectEvent -InputObject $miSettings -EventName Click -Action { Open-Settings } | Out-Null
Register-ObjectEvent -InputObject $miLogs -EventName Click -Action { Open-Logs } | Out-Null
Register-ObjectEvent -InputObject $miSession -EventName Click -Action { Open-SessionFolder } | Out-Null
Register-ObjectEvent -InputObject $miExit -EventName Click -Action { Exit-Tray } | Out-Null

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
Register-ObjectEvent -InputObject $timer -EventName Tick -Action { Update-Tray } | Out-Null
$timer.Start()
Update-Tray

# Keep the tray icon resident until Exit-Tray calls Application.Exit().
[System.Windows.Forms.Application]::Run()
