// Static checks for the Windows system tray companion.
//
// There is no Windows host in this environment, so runtime behaviour is NOT
// verified here - these checks lock down the tray script's contract so a
// change cannot silently break it:
//   * powershell version guards, error preference
//   * localhost status endpoint polling on a timer
//   * state -> colour mapping and tooltip text
//   * context menu actions mapped to real functions
//   * disconnect / restart / settings / logs / session folder / exit
//
//   node scripts/windows/tray.test.js
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + String(extra).slice(0, 140) : ''}`); }
}

const PS1 = path.join(__dirname, 'tray.ps1');
const src = fs.readFileSync(PS1, 'utf8');

console.log('tray.ps1 structure');
{
  check('is a plain script (no admin privileges required)', !/#Requires\s+-RunAsAdministrator/.test(src));
  check('stops on errors', /\$ErrorActionPreference\s*=\s*'Stop'/.test(src));
  check('polling interval is set', /\$timer\.Interval\s*=\s*5000/.test(src));
  check('status endpoint polled', /http:\/\/127\.0\.0\.1:\$Port\/status/.test(src));
  check('data root under LOCALAPPDATA', /\$DataRoot\s*=\s*Join-Path \$env:LOCALAPPDATA 'x-whatsapp-poster'/.test(src));
  check('session dir is the documented LOCALAPPDATA path', /\$SessionDir\s*=\s*Join-Path \$DataRoot 'whatsapp-session'/.test(src));
  check('log file under the data root', /\$LogFile\s*=\s*Join-Path \$DataRoot 'controller\.log'/.test(src));
  check('status helper reads the endpoint', /function Get-ControllerStatus/.test(src));
  check('never crashes the polling loop', /catch \{[\s\S]{0,40}\}/.test(src));
}

console.log('state colour mapping');
{
  check('ready is green', /'ready'\s*\{ return \[System\.Drawing\.Color\]::FromArgb\(90, 200, 90\) \}/.test(src));
  check('qr / reconnecting is amber', /'qr'/.test(src) && /'reconnecting'/.test(src) && /FromArgb\(240, 180, 40\)/.test(src));
  check('any other state is red', /default\s*\{ return \[System\.Drawing\.Color\]::FromArgb\(220, 60, 60\) \}/.test(src));
}

console.log('context menu actions');
{
  check('Reconnect / Restart Controller', /Reconnect\s*\/\s*Restart Controller/.test(src) && /Restart-Controller/.test(src));
  check('Disconnect / Stop Controller', /Disconnect\s*\/\s*Stop Controller/.test(src) && /Stop-Controller/.test(src));
  check('Open Settings / Dashboard', /Open Settings\s*\/\s*Dashboard/.test(src) && /Open-Settings/.test(src));
  check('View Logs', /View Logs/.test(src) && /Open-Logs/.test(src));
  check('Open Session Folder', /Open Session Folder/.test(src) && /Open-SessionFolder/.test(src));
  check('Exit', /Exit/.test(src) && /Exit-Tray/.test(src));
  check('restart kills session browsers too', /Get-SessionChromeProcesses[\s\S]{0,120}Stop-Process/.test(src));
  check('settings open Chrome extensions', /chrome:\/\/extensions/.test(src));
  check('view logs opens the controller log', /Start-Process[\s\S]{0,40}notepad/.test(src) && /Open-Logs/.test(src));
  check('session folder opens in explorer', /Start-Process[\s\S]{0,40}explorer/.test(src));
  check('exit stops the timer', /\$timer\.Stop\(\s*\)/.test(src));
  check('exit disposes the icon', /\$notify\.Visible\s*=\s*\$false/.test(src) && /\$notify\.Dispose\(\)/.test(src));
}

console.log('tray icon and polling');
{
  check('creates a NotifyIcon', /New-Object System\.Windows\.Forms\.NotifyIcon/.test(src));
  check('sets a tooltip with the state', /\$notify\.Text\s*=/.test(src));
  check('draws an ellipse icon from a colour', /AddEllipse\(0, 0, 32, 32\)/.test(src));
  check('polls on a timer tick', /EventName\s+Tick/.test(src));
  check('initial icon is a state icon', /New-StateIcon \(Get-StateColor 'stopped'\)/.test(src));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nWINDOWS TRAY STATIC CHECKS PASSED');
process.exit(failures ? 1 : 0);
