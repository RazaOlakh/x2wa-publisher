<#
.SYNOPSIS
  Creates a clean desktop shortcut to launch and connect the X -> WhatsApp controller silently.
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

$TargetScript = (Resolve-Path (Join-Path $PSScriptRoot 'rerun-connection.ps1')).Path

# Ensure official duotone icon (x2wa.ico) is generated from extension PNG
$icoPath = Join-Path $PSScriptRoot 'x2wa.ico'
if (-not (Test-Path -LiteralPath $icoPath)) {
  $pngPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\extension\icons\icon-128.png') -ErrorAction SilentlyContinue).Path
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

# Generate silent VBScript launcher wrapper
$VbsWrapper = Join-Path $PSScriptRoot 'rerun-connection.vbs'
$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & "$TargetScript" & """ -Silent", 0, False
"@
Set-Content -LiteralPath $VbsWrapper -Value $vbsContent -Encoding ASCII

# Find Chrome icon if available, otherwise use shell32 icon
$chromeIcon = @(
  (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$iconLocation = if (Test-Path -LiteralPath $icoPath) {
  "$icoPath,0"
} elseif ($chromeIcon) {
  "$chromeIcon,0"
} else {
  "shell32.dll,238"
}

$cleanName = $Name.Replace('->', 'to').Replace('>', '').Trim()
$ShortcutPath = Join-Path $DesktopPath "$cleanName.lnk"
$targets = @($ShortcutPath, (Join-Path $DesktopPath 'Rerun X2WA Connection.lnk'))
$WshShell = New-Object -ComObject WScript.Shell

foreach ($scPath in $targets) {
  $Shortcut = $WshShell.CreateShortcut($scPath)
  $Shortcut.TargetPath = "wscript.exe"
  $Shortcut.Arguments = "`"$VbsWrapper`""
  $Shortcut.WorkingDirectory = $PSScriptRoot
  $Shortcut.Description = "Launch and connect X -> WhatsApp Controller silently"
  $Shortcut.IconLocation = $iconLocation
  $Shortcut.WindowStyle = 7
  $Shortcut.Save()
}

Write-Host "==> Clean desktop shortcut created successfully!" -ForegroundColor Green
Write-Host "    Shortcut : $ShortcutPath"
Write-Host "    Target   : wscript.exe -> $VbsWrapper"
Write-Host "    Script   : $TargetScript -Silent"
Write-Host "    Icon     : $iconLocation"
