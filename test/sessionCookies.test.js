import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  normalizeCookie,
  restoreCachedTwitterAuth,
  saveCookieCache,
} from '../src/core/browser/sessionCookies.js';

test('normalizes browser-exported cookie fields for Playwright', () => {
  const cookie = normalizeCookie({
    name: 'auth_token',
    value: 'secret',
    domain: '.x.com',
    expirationDate: 1_790_854_041,
    httpOnly: true,
    secure: true,
    sameSite: 'no_restriction',
  });

  assert.deepEqual(cookie, {
    name: 'auth_token',
    value: 'secret',
    domain: '.x.com',
    path: '/',
    expires: 1_790_854_041,
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  });
});

test('restores cached Twitter auth when the persistent profile loses it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-cookies-'));
  const cookiePath = path.join(directory, 'cookies.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await saveCookieCache([normalizeCookie({
    name: 'auth_token',
    value: 'secret',
    domain: '.x.com',
    expirationDate: 1_790_854_041,
  })], cookiePath);

  let cookies = [];
  const context = {
    cookies: async () => cookies,
    addCookies: async addedCookies => {
      cookies = addedCookies;
    },
  };

  assert.equal(await restoreCachedTwitterAuth(context, cookiePath), true);
  assert.equal(cookies.some(cookie => cookie.name === 'auth_token'), true);
  assert.equal(await restoreCachedTwitterAuth(context, cookiePath), false);
});
