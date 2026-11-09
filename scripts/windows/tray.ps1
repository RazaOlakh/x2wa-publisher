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

# Ensure any console window hosting this script is hidden immediately
try {
  $win32Def = @'
using System;
using System.Runtime.InteropServices;
public class Win32Window {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();
}
'@
  if (-not ([System.Management.Automation.PSTypeName]'Win32Window').Type) {
    Add-Type -TypeDefinition $win32Def -ErrorAction SilentlyContinue
  }
  $consoleHandle = [Win32Window]::GetConsoleWindow()
  if ($consoleHandle -and $consoleHandle -ne [IntPtr]::Zero) {
    [Win32Window]::ShowWindowAsync($consoleHandle, 0) | Out-Null
  }
} catch {}

# Prevent duplicate tray icon instances
$currentPid = $PID
$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'pwsh.exe') -and
    $_.ProcessId -ne $currentPid -and
    $_.CommandLine -and
    $_.CommandLine -like "*tray.ps1*" -and
    $_.CommandLine -notlike "*Get-CimInstance*" -and
    $_.CommandLine -notlike "*Select-String*"
  }
if ($existing) {
  exit 0
}

$Port = 47825
$StatusUri = "http://127.0.0.1:$Port/status"
$DataRoot = Join-Path $env:LOCALAPPDATA 'x-whatsapp-poster'
$SessionDir = Join-Path $DataRoot 'whatsapp-session'
$LogFile = Join-Path $DataRoot 'controller.log'
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { (Get-Location).Path }
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
$StartupScript = Join-Path $ScriptDir 'install-startup.ps1'

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
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*x-whatsapp-poster*" -or $_.CommandLine -like "*whatsapp-session*" -or $_.CommandLine -like "*$SessionDir*") }
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

function Reconnect-Controller {
  try {
    $notify.Text = 'X -> WhatsApp Controller: reconnecting...'
    $notify.Icon = New-StateIcon (Get-StateColor 'reconnecting')
  } catch {}
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/auth/reconnect" -Method POST -Body '{"force":true}' -ContentType 'application/json' -TimeoutSec 3 -ErrorAction Stop | Out-Null
  } catch {
    Restart-Controller
  }
}

function Restart-Controller {
  try {
    $notify.Text = 'X -> WhatsApp Controller: restarting...'
    $notify.Icon = New-StateIcon (Get-StateColor 'starting')
  } catch {}
  foreach ($p in @(Get-ControllerProcess)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($p in @(Get-SessionChromeProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  $lockFile = Join-Path $SessionDir 'controller.lock'
  if (Test-Path -LiteralPath $lockFile) { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue }

  $env:X2WA_RESTARTING_FROM_TRAY = '1'
  $fullRestartCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"`$env:X2WA_RESTARTING_FROM_TRAY='1'; & '$StartupScript' restart -SkipTray`""
  try {
    $ws = New-Object -ComObject WScript.Shell
    $ws.Run($fullRestartCmd, 0, $false) | Out-Null
  } catch {
    $restartCmd = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"`$env:X2WA_RESTARTING_FROM_TRAY='1'; & '$StartupScript' restart -SkipTray`""
    Start-Process powershell.exe -ArgumentList $restartCmd -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
  }
}

function Stop-Controller {
  foreach ($p in @(Get-ControllerProcess)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($p in @(Get-SessionChromeProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Open-Logs {
  if (-not (Test-Path -LiteralPath $LogFile)) {
    $parent = Split-Path -Parent $LogFile
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force -ErrorAction SilentlyContinue | Out-Null }
    "" | Out-File -FilePath $LogFile -Encoding utf8 -ErrorAction SilentlyContinue
  }
  Start-Process -FilePath notepad -ArgumentList "`"$LogFile`"" -ErrorAction SilentlyContinue | Out-Null
}

function Open-SessionFolder {
  if (-not (Test-Path -LiteralPath $SessionDir)) {
    New-Item -ItemType Directory -Path $SessionDir -Force -ErrorAction SilentlyContinue | Out-Null
  }
  Start-Process -FilePath explorer -ArgumentList "`"$SessionDir`"" -ErrorAction SilentlyContinue | Out-Null
}

function Open-Settings {
  $chrome = Find-Chrome
  if ($chrome -and (Test-Path -LiteralPath $chrome)) {
    Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions' -ErrorAction SilentlyContinue | Out-Null
  } else {
    Start-Process -FilePath 'chrome.exe' -ArgumentList 'chrome://extensions' -ErrorAction SilentlyContinue | Out-Null
  }
}

function Get-StateColor {
  param([string]$state)
  switch ($state) {
    'ready'         { return [System.Drawing.Color]::FromArgb(90, 200, 90) }
    'starting'      { return [System.Drawing.Color]::FromArgb(240, 180, 40) }
    'authenticated' { return [System.Drawing.Color]::FromArgb(240, 180, 40) }
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
  $hIcon = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($hIcon)
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
  if ($notify) {
    $notify.Visible = $false
    $notify.Dispose()
  }
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
$miReconnect = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Reconnect Controller'
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Reconnect / Restart Controller (Full)'
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Disconnect / Stop Controller'
$miSettings = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Open Settings / Dashboard'
$miLogs = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'View Logs'
$miSession = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Open Session Folder'
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Exit'
foreach ($mi in @($miReconnect, $miRestart, $miStop, $miSettings, $miLogs, $miSession, $miExit)) { $menu.Items.Add($mi) | Out-Null }
$notify.ContextMenuStrip = $menu

# In PowerShell Windows Forms, native event delegates ($item.add_Click and $timer.add_Tick)
# are required so that menu actions execute immediately on the UI thread while
# [System.Windows.Forms.Application]::Run() is pumping the Windows message loop.
# Register-ObjectEvent places events on the PowerShell engine event queue which is
# blocked during Application::Run().
$miReconnect.add_Click({ Reconnect-Controller })
$miRestart.add_Click({ Restart-Controller })
$miStop.add_Click({ Stop-Controller })
$miSettings.add_Click({ Open-Settings })
$miLogs.add_Click({ Open-Logs })
$miSession.add_Click({ Open-SessionFolder })
$miExit.add_Click({ Exit-Tray })

# Handle process exit to prevent ghost notification icons
Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PsEngineEvent]::Exiting) -Action {
  if ($notify) {
    $notify.Visible = $false
    $notify.Dispose()
  }
} -ErrorAction SilentlyContinue | Out-Null

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ Update-Tray })
# Timer tick registration: EventName Tick
Register-ObjectEvent -InputObject $timer -EventName Tick -Action { Update-Tray } -ErrorAction SilentlyContinue | Out-Null
$timer.Start()
Update-Tray

# Keep the tray icon resident until Exit-Tray calls Application.Exit().
[System.Windows.Forms.Application]::Run()
