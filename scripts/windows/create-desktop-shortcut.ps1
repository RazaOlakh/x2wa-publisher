<#
.SYNOPSIS
  Creates a clean desktop shortcut to launch, connect, or restart the X -> WhatsApp controller and tray companion silently (2-in-1).
#>
[CmdletBinding()]
param(
  [string]$Name = 'X - WhatsApp Controller'
)

$ErrorActionPreference = 'Stop'

$DesktopPath = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path -LiteralPath $DesktopPath)) {
  throw "Desktop folder not found at: $DesktopPath"
}

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { (Get-Location).Path }
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }

$TargetScript = (Resolve-Path (Join-Path $ScriptDir 'rerun-connection.ps1')).Path
$DataRoot = Join-Path $env:LOCALAPPDATA 'x-whatsapp-poster'
if (-not (Test-Path -LiteralPath $DataRoot)) {
  New-Item -ItemType Directory -Path $DataRoot -Force -ErrorAction SilentlyContinue | Out-Null
}

# Ensure official duotone icon (x2wa.ico) exists in both repo and DataRoot
$icoPath = Join-Path $ScriptDir 'x2wa.ico'
$dataIcoPath = Join-Path $DataRoot 'x2wa.ico'

if (-not (Test-Path -LiteralPath $icoPath) -and (Test-Path -LiteralPath $dataIcoPath)) {
  Copy-Item -LiteralPath $dataIcoPath -Destination $icoPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $icoPath)) {
  $pngPath = (Resolve-Path (Join-Path $ScriptDir '..\..\extension\icons\icon-128.png') -ErrorAction SilentlyContinue).Path
  if ($pngPath -and (Test-Path -LiteralPath $pngPath)) {
    try {
      Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
      $bmp = [System.Drawing.Bitmap]::FromFile($pngPath)
      $hIcon = $bmp.GetHicon()
      $icon = [System.Drawing.Icon]::FromHandle($hIcon)
      $fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
      $icon.Save($fs)
      $fs.Close()
      $bmp.Dispose()
      $icon.Dispose()
    } catch {}
  }
}

if (Test-Path -LiteralPath $icoPath) {
  try { Copy-Item -LiteralPath $icoPath -Destination $dataIcoPath -Force -ErrorAction SilentlyContinue } catch {}
}

# Install runner scripts permanently to DataRoot so git branch changes never break desktop shortcut
$dataRerunScript = Join-Path $DataRoot 'rerun-connection.ps1'
$dataTrayScript  = Join-Path $DataRoot 'tray.ps1'
try { Copy-Item -LiteralPath $TargetScript -Destination $dataRerunScript -Force -ErrorAction SilentlyContinue } catch {}
$traySource = Join-Path $ScriptDir 'tray.ps1'
if (Test-Path -LiteralPath $traySource) {
  try { Copy-Item -LiteralPath $traySource -Destination $dataTrayScript -Force -ErrorAction SilentlyContinue } catch {}
}

# Generate silent VBScript launcher wrapper
$VbsWrapper = Join-Path $ScriptDir 'rerun-connection.vbs'
$dataVbsWrapper = Join-Path $DataRoot 'rerun-connection.vbs'

$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appData = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
psScript = appData & "\x-whatsapp-poster\rerun-connection.ps1"
If Not fso.FileExists(psScript) Then
  psScript = "$TargetScript"
End If
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """ -Silent", 0, False
"@

Set-Content -LiteralPath $VbsWrapper -Value $vbsContent -Encoding ASCII
try { Set-Content -LiteralPath $dataVbsWrapper -Value $vbsContent -Encoding ASCII } catch {}

# Find Chrome icon if available, otherwise use shell32 icon
$chromeIcon = @(
  (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$iconLocation = if (Test-Path -LiteralPath $dataIcoPath) {
  "$dataIcoPath,0"
} elseif (Test-Path -LiteralPath $icoPath) {
  "$icoPath,0"
} elseif ($chromeIcon) {
  "$chromeIcon,0"
} else {
  "shell32.dll,238"
}

$cleanName = $Name.Replace('->', 'to').Replace('>', '').Trim()
$ShortcutPath = Join-Path $DesktopPath "$cleanName.lnk"

# Remove any duplicate or legacy desktop shortcuts (ensure only 1 single 2-in-1 icon exists)
$legacyShortcuts = @(
  (Join-Path $DesktopPath 'Rerun X2WA Connection.lnk'),
  (Join-Path $DesktopPath 'X to WhatsApp Controller.lnk')
) | Where-Object { $_ -ne $ShortcutPath }

foreach ($legacy in $legacyShortcuts) {
  if (Test-Path -LiteralPath $legacy) {
    Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue
  }
}

$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscriptExe)) { $wscriptExe = 'wscript.exe' }

$targetVbs = if (Test-Path -LiteralPath $dataVbsWrapper) { $dataVbsWrapper } else { $VbsWrapper }

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $wscriptExe
$Shortcut.Arguments = "`"$targetVbs`""
$Shortcut.WorkingDirectory = $ScriptDir
$Shortcut.Description = "Launch and connect X -> WhatsApp Controller and Tray companion (2-in-1)"
$Shortcut.IconLocation = $iconLocation
$Shortcut.WindowStyle = 7
$Shortcut.Save()

Write-Host "==> Single 2-in-1 desktop shortcut created successfully!" -ForegroundColor Green
Write-Host "    Shortcut : $ShortcutPath"
Write-Host "    Target   : $wscriptExe -> $targetVbs"
Write-Host "    Script   : $dataRerunScript -Silent"
Write-Host "    Icon     : $iconLocation"
