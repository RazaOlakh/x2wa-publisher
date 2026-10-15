// Static checks for the optional Windows service (NSSM) installer.
//
// There is no Windows host and no NSSM in this environment, so the service is
// NOT registered or run here. These checks lock down the script's contract so
// a change cannot silently break it, and so the important safety properties
// hold: it is opt-in, it needs NSSM, it runs the supervisor with an explicit
// working directory and rotated logs, it restarts on exit, it keeps the
// account (and therefore the per-user WhatsApp session) rather than
// LocalSystem, and it never logs the password.
//
//   node scripts/windows/service.test.js
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + String(extra).slice(0, 140) : ''}`); }
}

const PS1 = path.join(__dirname, 'install-service.ps1');
const src = fs.readFileSync(PS1, 'utf8');

console.log('install-service.ps1 structure');
{
  const verbs = [...src.matchAll(/^\s*'(install|uninstall|status|start|stop|restart)'\s*\{/gm)].map((m) => m[1]);
  check('declares install/uninstall/status/start/stop/restart',
    ['install', 'uninstall', 'status', 'start', 'stop', 'restart'].every((v) => verbs.includes(v)), verbs.join(','));

  const param = src.match(/\[ValidateSet\(([^)]+)\)\][\s\S]{0,120}?\[string\]\$Action\s*=\s*'([a-z]+)'/);
  check('action is parameterised', Boolean(param), param && param[0].slice(0, 60));
  check('parameter covers every action', param && ['install', 'uninstall', 'status', 'start', 'stop', 'restart'].every((v) => param[1].includes(v)));

  check('explicitly opt-in: installs nothing unless asked', /'install'\s*\{[\s\S]*?Invoke-Nssm install/.test(src));
  check('requires NSSM before installing', /Get-Command \$NssmPath/.test(src) && /nssm\.cc/.test(src));
  check('checks the controller dependencies', /node_modules\\whatsapp-web\.js/.test(src));
  check('checks the supervisor exists', /\$SupervisorJs/.test(src));
  check('never logs the password', !/Write-(Host|Output|Step|Warning|Error).*\$acct\.Password|Out-File.*\$acct\.Password/.test(src));
  check('never stores credentials', !/-Credential\s+\$|ConvertTo-SecureString|password\s*=\s*['"]/i.test(src));
  check('uses a credential prompt for the account', /Get-Credential/.test(src));
  check('warns when the account cannot see the session', /will not find the WhatsApp session/.test(src));
  check('leaves the session untouched on uninstall', /session in \$DataRoot was left untouched/.test(src));

  // Balanced braces / quotes are a cheap structural smoke test.
  const braces = (src.match(/\{/g) || []).length - (src.match(/\}/g) || []).length;
  check('braces balanced', braces === 0, braces);
  const hereOpen = (src.match(/@"/g) || []).length;
  const hereClose = (src.match(/"@/g) || []).length;
  check('here-string closed', hereOpen === hereClose, { hereOpen, hereClose });
}

console.log('generated service settings');
{
  check('explicit working directory', /Invoke-Nssm set \$ServiceName AppDirectory \$ControllerDir/.test(src));
  check('stdout and stderr go to log files', /AppStdout \$LogFile/.test(src) && /AppStderr \$ErrLog/.test(src));
  check('log rotation configured', /AppRotateFiles/.test(src) && /AppRotateBytes \$RotateBytes/.test(src));
  check('restart delay configured', /AppRestartDelay \d+/.test(src));
  check('restarts when the process exits', /AppExit Default Restart/.test(src));
  check('runs the supervisor, not the controller directly', /Invoke-Nssm install \$ServiceName \$NodeExe \$SupervisorJs/.test(src));
  check('account set on the service (so the per-user session is found)', /Invoke-Nssm set \$ServiceName ObjectName \$acct\.UserName \$acct\.Password/.test(src));
  check('health/status check binds only loopback', src.includes("'http://127.0.0.1:47825/status'"));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nWINDOWS SERVICE STATIC CHECKS PASSED');
process.exit(failures ? 1 : 0);
