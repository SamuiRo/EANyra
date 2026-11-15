/**
 * Import X cookies exported from a normal browser into one session.
 *
 *   npm run import-cookies                                  → default file, session "default"
 *   npm run import-cookies -- path/to/cookies.json --session brand-a
 *   npm run import-cookies -- --session brand-a --delete-source
 *
 * The cookies are validated in a throwaway browser context and then stored
 * encrypted in the vault. --delete-source removes the plaintext export file.
 */

import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { Command } from 'commander';

import { BROWSER, TWITTER } from '../../config/app.config.js';
import { readCookieFile } from '../browser/sessionCookies.js';
import { Credentials, DEFAULT_SESSION } from '../secrets/Credentials.js';
import { assertSessionName } from '../secrets/Vault.js';
import { print } from '../../shared/utils.js';

async function main() {
  const program = new Command()
    .name('import-cookies')
    .argument('[file]', 'Cookie export (JSON array)', BROWSER.cookiesImportPath)
    .option('--session <name>', 'Session name referenced by accounts.json "session"', DEFAULT_SESSION)
    .option('--delete-source', 'Delete the plaintext cookie file after a successful import')
    .parse();
  const [file] = program.processedArgs;
  const { session, deleteSource } = program.opts();
  assertSessionName(session);

  print(`Reading cookies from: ${file}`, 'system');
  const cookies = await readCookieFile(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      `${file} not found. Export x.com cookies there, or pass a path: ` +
      'npm run import-cookies -- <path-to-cookies.json> --session <name>',
    );
  });

  const credentials = await Credentials.open();
  if (!credentials.encrypted) {
    print('No encrypted vault yet: cookies go to the plaintext cookie cache. Run `npm run nyra -- vault init` first to encrypt them.', 'warning');
  }

  const browser = await chromium.launch({ headless: true });
  let state;
  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const accepted = await context.cookies(TWITTER.baseUrl);
    if (!accepted.some(cookie => cookie.name === 'auth_token')) {
      throw new Error('auth_token is not valid for x.com. Check its domain and expiration.');
    }
    state = await context.storageState();
  } finally {
    await browser.close();
  }

  await credentials.saveTwitterState(session, state);
  print(`Imported ${cookies.length} cookies into X session "${session}"${credentials.encrypted ? ' (encrypted vault)' : ''}.`, 'success');

  if (deleteSource) {
    await fs.unlink(file);
    print(`Deleted plaintext source file ${file}.`, 'success');
  } else {
    print(`The source file ${file} is still plaintext. Delete it, or re-run with --delete-source.`, 'warning');
  }
  if (session !== DEFAULT_SESSION) {
    print(`Reference it from X accounts in accounts.json: "session": "${session}".`, 'info');
  }
  print('Session is ready for `npm run scrape:twitter`.', 'info');
}

main().catch(error => {
  print(`Cookie import failed: ${error.message}`, 'error');
  process.exitCode = 1;
});
