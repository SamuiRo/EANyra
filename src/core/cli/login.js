/**
 * Interactive Twitter/X login helper.
 *
 *   npm run login                       → session "default"
 *   npm run login -- --session brand-a  → session "brand-a"
 *
 * Opens a normal headful Chrome window (core/browser/loginWindow.js, shared
 * with the web UI). After login only the storage state is kept, encrypted in
 * the vault; the temporary profile is deleted.
 */

import readline from 'node:readline';
import { Command } from 'commander';

import { openLoginWindow } from '../browser/loginWindow.js';
import { Credentials, DEFAULT_SESSION } from '../secrets/Credentials.js';
import { assertSessionName } from '../secrets/Vault.js';
import { banner, print } from '../../shared/utils.js';

function waitForEnter(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error('Interactive login requires a terminal. Use `npm run import-cookies` instead.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const { session } = new Command()
    .name('login')
    .description('Log into X in a browser window and store the session in the encrypted vault.')
    .option('--session <name>', 'Session name referenced by accounts.json "session"', DEFAULT_SESSION)
    .parse()
    .opts();
  assertSessionName(session);

  banner('EANyra - Login Helper', `Interactive Twitter/X authentication · session "${session}"`);
  print('X may reject Playwright-controlled browsers. Cookie import is the recommended session setup.', 'warning');
  print(`Fallback: npm run import-cookies -- --session ${session}`, 'info');

  const credentials = await Credentials.open({ interactive: true });
  if (!credentials.encrypted) {
    print('No encrypted vault yet: cookies will be saved to the plaintext cookie cache. Run `npm run nyra -- vault init` first to encrypt them.', 'warning');
  }

  const window = await openLoginWindow();
  try {
    print('Log in in the browser with the account for this session, including any email/2FA challenge.', 'system');
    print('Wait until the home feed is visible, then return to this terminal.', 'system');
    await waitForEnter('Press ENTER after login is complete: ');

    const state = await window.context.storageState();
    if (!state.cookies.some(cookie => cookie.name === 'auth_token')) {
      throw new Error(
        'No auth_token cookie was found. Login was not completed. ' +
        `You can retry or use \`npm run import-cookies -- --session ${session}\`.`,
      );
    }

    await credentials.saveTwitterState(session, state);
    print(`X session "${session}" saved${credentials.encrypted ? ' to the encrypted vault' : ''} (${state.cookies.length} cookies).`, 'success');
    if (session !== DEFAULT_SESSION) {
      print(`Reference it from X accounts in accounts.json: "session": "${session}".`, 'info');
    }
  } finally {
    await window.close();
  }
}

main().catch(error => {
  print(`Login failed: ${error.message}`, 'error');
  process.exitCode = 1;
});
