/**
 * Windows DPAPI wrapper (CurrentUser scope) through PowerShell.
 *
 * Used for "remember on this device": the vault key is stored encrypted by
 * Windows for the current OS user, so background processes (MCP, scheduler)
 * can unlock the vault without the master password living in a config file.
 * Data travels through stdin/stdout, never through command-line arguments.
 */

import { spawn } from 'node:child_process';

const ENTROPY = 'eanyra-vault-dpapi-v1';

export const dpapiAvailable = () => process.platform === 'win32';

function script(operation) {
  return [
    'Add-Type -AssemblyName System.Security;',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());',
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}');`,
    `$out = [Security.Cryptography.ProtectedData]::${operation}($data, $entropy, 'CurrentUser');`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join(' ');
}

function run(operation, inputBase64) {
  if (!dpapiAvailable()) return Promise.reject(new Error('Windows DPAPI is available only on Windows.'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script(operation)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`Windows DPAPI ${operation} failed${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}.`));
    });
    child.stdin.end(inputBase64);
  });
}

export const dpapiProtect = base64 => run('Protect', base64);
export const dpapiUnprotect = base64 => run('Unprotect', base64);
