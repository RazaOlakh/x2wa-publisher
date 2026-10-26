// Static checks for the Windows startup path.
//
// There is no Windows host in this environment, so runtime behaviour is
// NOT verified here - these checks lock down the launcher's contract so a
// change cannot silently break it:
//   * the script's own structure (verbs, prerequisites, paths)
//   * the batch launcher it generates: absolute Node/Chrome paths,
//     documented session dir, quote balance around paths with spaces,
//     duplicate-process guard, log output, clear launch-failure reporting
//
//   node scripts/windows/startup.test.js
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + String(extra).slice(0, 140) : ''}`); }
}

const PS1 = path.join(__dirname, 'install-startup.ps1');
const src = fs.readFileSync(PS1, 'utf8');

console.log('install-startup.ps1 structure');
{
  const verbs = [...src.matchAll(/^\s*'(install|uninstall|status|restart)'\s*\{/gm)].map((m) => m[1]);
  check('declares install/uninstall/status/restart', ['install', 'uninstall', 'status', 'restart'].every((v) => verbs.includes(v)), verbs.join(','));

  const param = src.match(/\[ValidateSet\(([^)]+)\)\][\s\S]{0,80}?\[string\]\$Action\s*=\s*'([a-z]+)'/);
  check('action is parameterised', Boolean(param), param && param[0].slice(0, 60));
  check('parameter covers all four actions', param && param[1].includes('install') && param[1].includes('uninstall') && param[1].includes('status') && param[1].includes('restart'));

  check('per-user Startup folder, not a scheduled task', /GetFolderPath\('Startup'\)/.test(src));
  check('no administrator privileges requested', !/#Requires\s+-RunAsAdministrator/.test(src) && !/Start-Process.*-Verb\s+RunAs/.test(src));
  check('no scheduled-task registration', !/Register-ScheduledTask|schtasks/i.test(src));
  check('no credentials stored', !/-Credential|Get-Credential/i.test(src));

  check('checks for node on PATH at install', /Get-Command node/.test(src));
  check('resolves the supervisor next to the controller', /\$SupervisorJs\s*=\s*Join-Path\s+\$ControllerDir\s+'src\\supervisor\.js'/.test(src));
  check('status/restart/uninstall find the supervisor too', /-like\s+"\*\$SupervisorJs\*"/.test(src));
  check('reports missing node with a clear error', /Node\.js 18\+ not found/.test(src));
  check('checks dependencies are installed', /node_modules\\whatsapp-web\.js/.test(src));
  check('checks ffmpeg presence', /ffmpeg/.test(src));
  check('warns when ffmpeg missing', /Write-Warning.*ffmpeg|ffmpeg.*Write-Warning/s.test(src));
  check('uninstall leaves the session untouched', /session .*left untouched/i.test(src));
  check('restart requires an installed launcher', /not installed - run/.test(src));

  // Balanced braces / quotes are a cheap structural smoke test.
  const braces = (src.match(/\{/g) || []).length - (src.match(/\}/g) || []).length;
  check('braces balanced', braces === 0, braces);
  const hereOpen = (src.match(/@"/g) || []).length;
  const hereClose = (src.match(/"@/g) || []).length;
  check('here-string closed', hereOpen === hereClose, { hereOpen, hereClose });
}

console.log('generated launcher contract');
{
  const m = src.match(/\$body = @"(.*?)"@/s);
  check('launcher body is a here-string', Boolean(m));
  const body = m[1];

  // Substitute the values PowerShell expands when it writes the launcher.
  const subs = {
    $Port: '47825',
    $LogFile: 'C:\\Users\\t\\AppData\\Local\\x-whatsapp-poster\\controller.log',
    $nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    $chromeExe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    $SessionDir: 'C:\\Users\\t\\AppData\\Local\\x-whatsapp-poster\\whatsapp-session',
    $TmpRoot: 'C:\\Users\\t\\AppData\\Local\\x-whatsapp-poster\\tmp',
    // Expanded at install time so the launcher carries absolute paths.
    $ControllerJs: 'C:\\Users\\t\\Documents\\My Projects\\x2wa\\controller\\src\\server.js',
    $SupervisorJs: 'C:\\Users\\t\\Documents\\My Projects\\x2wa\\controller\\src\\supervisor.js',
  };
  let gen = body;
  for (const [k, v] of Object.entries(subs)) gen = gen.split(k).join(v);

  check('no unexpanded PowerShell variables', !/\$\w/.test(gen), (gen.match(/\$\w/g) || []).join(','));
  check('quotes balanced (paths with spaces stay quoted)', (gen.match(/"/g) || []).length % 2 === 0, (gen.match(/"/g) || []).length);
  check('node path is absolute and quoted', gen.includes('"C:\\Program Files\\nodejs\\node.exe"'));
  check('supervisor path is quoted for spaces', gen.includes('"C:\\Users\\t\\Documents\\My Projects\\x2wa\\controller\\src\\supervisor.js"'), (gen.match(/start .*/) || [''])[0]);
  check('starts the supervisor so a stopped controller is restarted', /start "x2wa-controller" \/min "[^"]*node\.exe" "[^"]*supervisor\.js"/.test(gen), (gen.match(/start .*/) || [''])[0]);
  check('does not start the controller directly (no supervision then)', !gen.includes('"C:\\Users\\t\\Documents\\My Projects\\x2wa\\controller\\src\\server.js"'));
  check('chrome path is passed through', /set "CHROME_PATH=C:/.test(gen));

  check('session dir is the documented LOCALAPPDATA path', gen.includes('SESSION_DIR=C:\\Users\\t\\AppData\\Local\\x-whatsapp-poster\\whatsapp-session'));
  check('same session dir on every launch (not per-run temp)', !/RANDOM|%RANDOM%|GetTempPath/i.test(gen));
  check('tmp root set', /set "TMP_ROOT=/.test(gen));
  check('port set', /set "CONTROLLER_PORT=47825"/.test(gen));

  check('duplicate-process guard present', /netstat[\s\S]{0,80}LISTENING/.test(gen) && /already running on port 47825/.test(gen));
  check('missing node reported clearly', /node\.exe not found/.test(gen) && /exit \/b 1/.test(gen));
  check('log file receives output', gen.includes('%X2WA_LOG%'));
  check('stdout/stderr appended to log', />> "%X2WA_LOG%" 2>&1/.test(gen));
  // `echo text>>file` is legal but fragile (a trailing digit is read as a fd).
  check('echo redirection is spaced, not glued to the text', !/\S>>\s*"%X2WA_LOG%"/.test(gen), gen.match(/echo .*>>.*/g));
  check('launch failure recorded after start', /did not answer on port 47825/.test(gen));
  check('creates its data directory', /if not exist "%LOCALAPPDATA%\\x-whatsapp-poster" mkdir/.test(gen));
  check('starts detached/minimised', /start "x2wa-controller" \/min/.test(gen));
  check('binds only loopback (health check is 127.0.0.1)', gen.includes('http://127.0.0.1:47825/health'));
  check('never stores credentials', !/-Credential|Get-Credential|password/i.test(gen));
}

console.log('silent VBScript launcher contract');
{
  // The Startup-folder entry is a VBScript wrapper that runs the real runner
  // hidden (window style 0) and does not wait, so nothing is shown at logon.
  check('creates a silent VBScript launcher in the Startup folder', /Set-Content -LiteralPath \$VbsLauncherPath/.test(src));
  check('the wrapper lives in Startup and the runner beside the data',
    /\$VbsLauncherPath\s*=\s*Join-Path \$StartupDir/.test(src) && /\$CmdLauncherPath\s*=\s*Join-Path \$DataRoot/.test(src));
  check('runs the runner hidden with window style 0', /WshShell\.Run\s+"""\$CmdLauncherPath""",\s*0,\s*False/.test(src));
  check('sets the working directory to the controller', /WshShell\.CurrentDirectory\s*=\s*"\$ControllerDir"/.test(src));
  check('removes a legacy .cmd from the Startup folder', /LegacyCmdPath/.test(src) && /Remove-Item -LiteralPath \$LegacyCmdPath/.test(src));
  check('uninstalls the wrapper and the runner', /Remove-Item -LiteralPath \$VbsLauncherPath/.test(src) && /Remove-Item -LiteralPath \$CmdLauncherPath/.test(src));
  check('status reports the silent entry', /\$VbsLauncherPath \(silent\)/.test(src));
  check('restart starts the wrapper when present', /\$toStart\s*=\s*if \(Test-Path -LiteralPath \$VbsLauncherPath\) \{ \$VbsLauncherPath \}/.test(src));
}

console.log('cross-platform session path agrees with the controller');
{
  const platform = require(path.join(__dirname, '..', '..', 'controller', 'src', 'platform.js'));
  const savedLocal = process.env.LOCALAPPDATA;
  const savedPl = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.LOCALAPPDATA = 'C:\\Users\\t\\AppData\\Local';
  const winSession = platform.sessionDir().replace(/\\/g, '/');
  Object.defineProperty(process, 'platform', { value: savedPl, configurable: true });
  if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
  check('controller resolves the same Windows session dir the launcher sets',
    winSession === 'C:/Users/t/AppData/Local/x-whatsapp-poster/whatsapp-session', winSession);
}

console.log('HKCU Run registry entry contract');
{
  check('writes the VBScript path to HKCU Run on install', /Set-ItemProperty -Path \$runKey -Name \$ServiceName/.test(src));
  check('uses wscript.exe to launch the VBScript', /wscript\.exe.*\$VbsLauncherPath/.test(src));
  check('removes the registry value on uninstall', /Remove-ItemProperty.*HKCU.*Run.*-Name \$ServiceName/.test(src));
  check('status reports the registry run value', /Get-ItemProperty.*HKCU.*Run.*\$ServiceName/.test(src));
}

console.log('session-browser cleanup contract');
{
  check('defines Get-SessionChromeProcesses to find stray Chrome', /function Get-SessionChromeProcesses/.test(src));
  check('filters by the session directory in the command line', /Where-Object\s*{ \$_.CommandLine -and \$_.CommandLine -like "\*\$SessionDir\*" }/.test(src));
  check('uninstall kills session browsers', /foreach.*Get-SessionChromeProcesses.*Stop-Process -Id \$p.ProcessId/.test(src));
  check('restart kills session browsers too', /foreach.*Get-SessionChromeProcesses.*Stop-Process -Id \$p.ProcessId/.test(src));
}

console.log('start action contract');
{
  check('implements a start action', /'start'\s*\{/.test(src));
  check('returns early if already running', /if.*Get-ControllerProcess\).*already running/s.test(src));
  check('launches via wscript.exe or cmd.exe', /wscript\.exe.*\$toStart|cmd\.exe.*\/c.*\$toStart/.test(src));
  check('uses Invoke-CimMethod for detached launch', /Invoke-CimMethod.*Win32_Process.*Create/.test(src));
  check('falls back to Start-Process', /Start-Process -FilePath \$toStart/.test(src));
}

console.log('detached launch and wait contract');
{
  check('restart waits for termination before relaunching', /for.*\$i = 0.*-lt 10.*if.*-not.*Get-ControllerProcess.*break/s.test(src));
  check('ping 127.0.0.1 -n 9 used for wait in launcher', /ping 127.0.0.1 -n 9 >nul/.test(src));
}

console.log('rerun-connection.ps1 contract');
{
  const rerun = fs.readFileSync(path.join(__dirname, 'rerun-connection.ps1'), 'utf8');
  check('checks /status endpoint', /http:\/\/127.0.0.1:\$Port\/status/.test(rerun));
  check('restarts if not ready', /restart/.test(rerun) && /state -ne 'ready'/.test(rerun));
  check('waits for ready or qr', /state -eq 'ready'|state -eq 'qr'/.test(rerun));
  check('prints QR action required message', /QR scan required/.test(rerun));
  check('handles missing console gracefully', /\[Console\]::KeyAvailable/.test(rerun) && /catch \{\}/.test(rerun));
}

console.log('create-desktop-shortcut.ps1 contract');
{
  const shortcut = fs.readFileSync(path.join(__dirname, 'create-desktop-shortcut.ps1'), 'utf8');
  check('creates a .lnk on the Desktop', /\[Environment\]::GetFolderPath\('Desktop'\)/.test(shortcut) && /CreateShortcut/.test(shortcut));
  check('targets rerun-connection.ps1', /rerun-connection\.ps1/.test(shortcut));
  check('uses Chrome icon if available', /chrome\.exe/.test(shortcut) && /IconLocation/.test(shortcut));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nWINDOWS STARTUP STATIC CHECKS PASSED');
process.exit(failures ? 1 : 0);