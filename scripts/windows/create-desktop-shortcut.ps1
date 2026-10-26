<#
.SYNOPSIS
  Creates a desktop shortcut to rerun the X -> WhatsApp connection if stopped.
#>
$ErrorActionPreference = 'Stop'

$DesktopPath = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path -LiteralPath $DesktopPath)) {
  throw "Desktop folder not found at: $DesktopPath"
}

$TargetScript = (Resolve-Path (Join-Path $PSScriptRoot 'rerun-connection.ps1')).Path
$ShortcutPath = Join-Path $DesktopPath 'Rerun X2WA Connection.lnk'

# Find Chrome icon if available, otherwise use shell32 icon
$chromeIcon = @(
  (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$iconLocation = if ($chromeIcon) { "$chromeIcon,0" } else { "shell32.dll,238" }

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$TargetScript`""
$Shortcut.WorkingDirectory = $PSScriptRoot
$Shortcut.Description = "Rerun or check X -> WhatsApp connection if stopped"
$Shortcut.IconLocation = $iconLocation
$Shortcut.Save()

Write-Host "==> Desktop shortcut created successfully!" -ForegroundColor Green
Write-Host "    Shortcut : $ShortcutPath"
Write-Host "    Target   : $TargetScript"
Write-Host "    Icon     : $iconLocation"
