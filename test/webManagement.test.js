import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountConfigService } from '../src/core/services/AccountConfigService.js';
import { SessionLogins, cookiesToState } from '../src/core/services/SessionLogins.js';
import { Credentials } from '../src/core/secrets/Credentials.js';
import { Vault } from '../src/core/secrets/Vault.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-webm-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const future = Math.floor(Date.now() / 1000) + 30 * 86400;
const xCookies = [
  { name: 'auth_token', value: 'secret', domain: '.x.com', path: '/', expirationDate: future, httpOnly: true, secure: true, sameSite: 'no_restriction' },
  { name: 'ct0', value: 'csrf', domain: '.x.com', path: '/' },
  { name: 'SID', value: 'google', domain: '.google.com', path: '/' },
];

test('accounts.json edits are validated as a whole and keep fields the UI does not know', async t => {
  const file = path.join(await tempDir(t), 'accounts.json');
  await fs.writeFile(file, JSON.stringify([{ username: 'brand_x', platform: 'twitter', note: 'kept by hand' }]));
  const service = new AccountConfigService({ filePath: file });

  await service.save({ platform: 'telegram', username: '@Brand_Channel', display_name: 'Channel', publish_enabled: true, bot: 'news' });
  await service.save({ platform: 'twitter', username: 'brand_x', display_name: 'Brand', session: 'brand-a', active: false });
  let entries = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(entries[0], { username: 'brand_x', platform: 'twitter', note: 'kept by hand', display_name: 'Brand', session: 'brand-a', active: false });
  assert.equal(entries[1].username, 'brand_channel');

  // Rename keeps the entry's place and settings; empty values reset to defaults.
  await service.save({ platform: 'twitter', username: 'brand_new', session: '', active: null }, { originalKey: 'twitter/brand_x' });
  entries = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(entries[0], { username: 'brand_new', platform: 'twitter', note: 'kept by hand', display_name: 'Brand' });

  await service.setArchived('twitter/brand_new', true);
  assert.equal((await service.list())[0].archive, true);
  await service.setArchived('twitter/brand_new', false);
  assert.equal((await service.list())[0].archive, undefined);

  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(service.save({ platform: 'twitter', username: 'other', bot: 'x' }), /bot is supported only for Telegram/);
  await assert.rejects(service.save({ platform: 'telegram', username: 'brand_channel' }, { originalKey: 'twitter/brand_new' }), /Duplicate account/);
  await assert.rejects(service.save({ platform: 'discord', username: 'feedback' }), /numeric channel id/);
  await assert.rejects(service.save({ platform: 'myspace', username: 'x' }), /Unknown platform/);
  await assert.rejects(service.setArchived('twitter/ghost', true), /not in accounts\.json/);
  assert.equal(await fs.readFile(file, 'utf8'), before, 'a rejected edit never touches the file');
});

test('cookie exports keep only X cookies and need a valid auth_token', () => {
  const state = cookiesToState(JSON.stringify(xCookies));
  assert.deepEqual(state.cookies.map(c => c.name), ['auth_token', 'ct0']);
  assert.equal(state.cookies[0].sameSite, 'None');
  assert.deepEqual(cookiesToState({ cookies: xCookies }).cookies.length, 2);
  assert.throws(() => cookiesToState('not json'), /must be JSON/);
  assert.throws(() => cookiesToState('[]'), /No cookies/);
  assert.throws(() => cookiesToState(JSON.stringify([xCookies[1]])), /no auth_token/);
  assert.throws(() => cookiesToState(JSON.stringify([{ ...xCookies[0], expirationDate: 1000 }])), /expired/);
});

test('X logins: cookies or a browser window, saved encrypted', async t => {
  const dir = await tempDir(t);
  const vault = await new Vault(path.join(dir, 'secrets.vault')).create('correct horse battery');
  const credentials = new Credentials({ vault });
  let loggedIn = false;
  let closed = 0;
  const logins = new SessionLogins({
    getCredentials: async () => credentials,
    openWindow: async () => ({
      context: { storageState: async () => ({ cookies: loggedIn ? [{ name: 'auth_token', value: 'w', domain: '.x.com' }] : [], origins: [] }) },
      close: async () => { closed++; },
    }),
  });

  assert.deepEqual(await logins.importCookies('brand-a', JSON.stringify(xCookies)), { kind: 'twitter', name: 'brand-a', cookies: 2 });
  assert.equal(vault.get('twitter', 'brand-a').cookies[0].value, 'secret');
  await assert.rejects(logins.importCookies('Bad Name', '[]'), /Invalid session name/);

  const started = await logins.startTwitter('brand-b');
  assert.equal(started.status, 'waiting');
  await assert.rejects(logins.startTwitter('brand-b'), /already in progress/);
  await assert.rejects(logins.finishTwitter(started.id), /Not logged in yet/);
  loggedIn = true;
  const done = await logins.finishTwitter(started.id);
  assert.equal(done.status, 'done');
  assert.equal(closed, 1, 'the login window closes after saving');
  assert.equal(vault.get('twitter', 'brand-b').cookies[0].value, 'w');
  await assert.rejects(logins.finishTwitter(started.id), /already done/);

  const abandoned = await logins.startTwitter('brand-c');
  assert.equal((await logins.cancel(abandoned.id)).status, 'cancelled');
  assert.equal(closed, 2);
  assert.equal(vault.get('twitter', 'brand-c'), null);
});

test('Telegram QR login shows the QR, asks for 2FA, retries a wrong password and saves the session', async t => {
  const dir = await tempDir(t);
  const vault = await new Vault(path.join(dir, 'secrets.vault')).create('correct horse battery');
  await vault.set('telegram-api', 'default', { api_id: 1, api_hash: 'a'.repeat(32) });
  const credentials = new Credentials({ vault });
  const passwords = [];
  const logins = new SessionLogins({
    getCredentials: async () => credentials,
    // Fake GramJS flow: QR → 2FA (wrong, then right) → session.
    telegramLogin: async ({ config, renderQr, readPassword }) => {
      assert.equal(config.apiId, 1);
      await renderQr({ token: Buffer.from('qr-token') });
      passwords.push(await readPassword('my hint'));
      passwords.push(await readPassword('my hint'));
      return { session: '1SessionFromQr==' };
    },
  });
  const wait = async (id, status) => {
    for (let i = 0; i < 100; i++) {
      const state = logins.status(id);
      if (state.status === status) return state;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`never reached ${status}: ${logins.status(id).status}`);
  };

  const { id } = await logins.startTelegram('work');
  const asking = await wait(id, 'password');
  assert.equal(asking.hint, 'my hint');
  assert.throws(() => logins.telegramPassword(id, ''), /Enter the password/);
  logins.telegramPassword(id, 'wrong');
  const retry = await wait(id, 'password');
  assert.match(retry.message, /Wrong password/);
  logins.telegramPassword(id, 'right');
  await wait(id, 'done');
  assert.deepEqual(passwords, ['wrong', 'right']);
  assert.equal(vault.get('telegram', 'work').session, '1SessionFromQr==');
});

test('a cancelled Telegram login stops waiting and saves nothing; QR codes are SVG', async t => {
  const dir = await tempDir(t);
  const vault = await new Vault(path.join(dir, 'secrets.vault')).create('correct horse battery');
  const credentials = new Credentials({ vault });
  const logins = new SessionLogins({
    getCredentials: async () => credentials,
    telegramLogin: async ({ renderQr, signal }) => {
      await renderQr({ token: Buffer.from('abc') });
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    },
  });
  const { id } = await logins.startTelegram('ops');
  for (let i = 0; i < 50 && logins.status(id).status !== 'qr'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(logins.status(id).qr_svg, /^<svg/);
  assert.equal((await logins.cancel(id)).status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(logins.status(id).status, 'cancelled');
  assert.equal(vault.get('telegram', 'ops'), null);
});
