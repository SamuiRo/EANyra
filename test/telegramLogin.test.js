import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import dotenv from 'dotenv';
import { loginTelegram, telegramLoginUrl, renderTelegramQr } from '../src/platforms/telegram/TelegramLogin.js';
import { saveTelegramSession, updateTelegramSessionEnv } from '../src/platforms/telegram/sessionEnv.js';
import { askSecret, askText } from '../src/shared/prompt.js';

const config = { apiId: 12345, apiHash: 'test-api-hash', session: 'old-session' };

function fakeClient() {
  const events = [];
  return {
    events,
    async connect() { events.push('connect'); },
    async checkAuthorization() { return true; },
    session: { save: () => '1testSessionBase64==' },
    async disconnect() { events.push('disconnect'); },
    async destroy() { events.push('destroy'); },
  };
}

test('QR login starts fresh, handles refreshed tokens and 2FA and closes the client', async () => {
  const client = fakeClient();
  const tokens = [];
  let receivedConfig;
  let hint;
  client.signInUserWithQrCode = async (credentials, callbacks) => {
    assert.deepEqual(credentials, { apiId: config.apiId, apiHash: config.apiHash });
    await callbacks.qrCode({ token: Buffer.from([251, 255, 0]), expires: 123 });
    await callbacks.qrCode({ token: Buffer.from([1, 2, 3]), expires: 153 });
    assert.equal(await callbacks.password('test hint'), ' password with spaces ');
    assert.equal(await callbacks.onError({ errorMessage: 'PASSWORD_HASH_INVALID' }), false);
    assert.equal(await callbacks.onError({ errorMessage: 'FLOOD_WAIT_60' }), true);
    return { id: 1 };
  };
  const result = await loginTelegram({
    config,
    createClient: async value => { receivedConfig = value; return client; },
    renderQr: async qr => { tokens.push(telegramLoginUrl(qr.token)); },
    readPassword: async value => { hint = value; return ' password with spaces '; },
    readPhone: () => { throw new Error('QR must not request a phone number'); },
    readCode: () => { throw new Error('QR must not request a verification code'); },
    log: () => {},
  });
  assert.equal(receivedConfig.session, '');
  assert.equal(tokens[0], 'tg://login?token=-_8A');
  assert.equal(tokens.length, 2);
  assert.equal(hint, 'test hint');
  assert.equal(result.session, '1testSessionBase64==');
  assert.deepEqual(client.events, ['connect', 'disconnect', 'destroy']);
});

test('phone fallback uses phone auth instead of QR', async () => {
  const client = fakeClient();
  client.signInUser = async (_credentials, callbacks) => {
    assert.equal(await callbacks.phoneNumber(), '+380000000000');
    assert.equal(await callbacks.phoneCode(), '12345');
    return { id: 2 };
  };
  const result = await loginTelegram({
    config, method: 'phone', createClient: async () => client,
    readPhone: async () => '+380000000000', readCode: async () => '12345',
  });
  assert.equal(result.user.id, 2);
  assert.deepEqual(client.events, ['connect', 'disconnect', 'destroy']);
});

test('login validates credentials before connection and refuses unconfirmed authorization', async () => {
  await assert.rejects(loginTelegram({ config: { apiId: 0 }, createClient: () => { throw new Error('Must not connect'); } }), /TELEGRAM_API_ID/);
  await assert.rejects(loginTelegram({ config, method: 'invalid' }), /method/);
  const client = fakeClient();
  client.signInUserWithQrCode = async () => ({ id: 1 });
  client.checkAuthorization = async () => false;
  await assert.rejects(loginTelegram({ config, createClient: async () => client, log: () => {} }), /confirm authorization/);
  assert.deepEqual(client.events, ['connect', 'disconnect', 'destroy']);
});

test('failed connection and cancelled QR auth clean up clients', async () => {
  const failed = fakeClient();
  failed.connect = async () => { throw new Error('connection refused'); };
  await assert.rejects(loginTelegram({ config, createClient: async () => failed }), /connection refused/);
  assert.deepEqual(failed.events, ['disconnect', 'destroy']);
  const client = fakeClient();
  const controller = new AbortController();
  client.signInUserWithQrCode = async () => {
    controller.abort(new Error('cancelled-test'));
    return new Promise(() => {});
  };
  await assert.rejects(loginTelegram({ config, signal: controller.signal, createClient: async () => client, log: () => {} }), /cancelled-test/);
  assert.deepEqual(client.events, ['connect', 'disconnect', 'destroy']);
});

test('QR rendering stays local and produces a terminal image without printing a login URI', async () => {
  const chunks = [];
  await renderTelegramQr({ token: Buffer.from('test-qr-token') }, { write: chunk => chunks.push(chunk) });
  assert.ok(chunks.join('').length > 100);
  assert.equal(chunks.join('').includes('tg://login'), false);
  assert.throws(() => telegramLoginUrl(Buffer.alloc(0)), /empty QR/);
});

test('session environment update preserves unrelated settings and removes duplicate session keys', () => {
  const raw = '# keep this comment\r\nTELEGRAM_BOT_TOKEN="test-token"\r\nTELEGRAM_API_HASH=hash\r\nTELEGRAM_SESSION=old\r\nexport TELEGRAM_SESSION=older\r\nOTHER="spaces and # literals"\r\n';
  const updated = updateTelegramSessionEnv(raw, '1NewSession==');
  const values = dotenv.parse(updated);
  assert.equal(values.TELEGRAM_SESSION, '1NewSession==');
  assert.equal(values.TELEGRAM_BOT_TOKEN, 'test-token');
  assert.equal(values.OTHER, 'spaces and # literals');
  assert.equal((updated.match(/^TELEGRAM_SESSION=/gm) ?? []).length, 1);
  assert.ok(updated.includes('# keep this comment\r\n'));
  assert.equal(dotenv.parse(updateTelegramSessionEnv('OTHER=keep\n', '1NewSession==')).OTHER, 'keep');
  assert.throws(() => updateTelegramSessionEnv(raw, 'bad\nINJECTED=1'), /invalid session/);
});

test('session save replaces only TELEGRAM_SESSION in the environment file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-session-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, '.env');
  await fs.writeFile(envFile, 'TELEGRAM_BOT_TOKEN=test-token\n');
  await saveTelegramSession('1SessionSaved==', envFile);
  assert.deepEqual(dotenv.parse(await fs.readFile(envFile)), {
    TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_SESSION: '1SessionSaved==',
  });
  assert.deepEqual(await fs.readdir(dir), ['.env']);
});

test('secret prompt hides 2FA input, preserves spaces, and handles Ctrl+C', async () => {
  const input = new PassThrough();
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
  const answer = askSecret('2FA password: ', { input, output: stream });
  input.write(' password with spaces \r');
  assert.equal(await answer, ' password with spaces ');
  assert.ok(output.includes('2FA password: '));
  assert.equal(output.includes('password with spaces'), false);
  const cancelledInput = new PassThrough();
  const cancelled = askSecret('Password: ', { input: cancelledInput, output: stream });
  cancelledInput.write('\x03');
  await assert.rejects(cancelled, /abort/i);
  const textInput = new PassThrough();
  const phone = askText('Phone: ', { input: textInput, output: stream });
  textInput.write(' +380000000000 \n');
  assert.equal(await phone, '+380000000000');
});
