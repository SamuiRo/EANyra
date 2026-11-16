import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseCipherListing, protectInstance, protectionStatus, efsAvailable } from '../src/core/instance/fileProtection.js';

const LISTING = [
  '',
  ' Listing S:\\EANyra\\instance\\',
  ' New files added to this directory will be encrypted.',
  '',
  'E accounts.json',
  'U data',
  '',
  ' Список S:\\EANyra\\instance\\data\\',   // a localized header still works
  ' Нові файли в цьому каталозі не будуть зашифровані.',
  '',
  'E pot.sqlite',
  'U pot.sqlite-wal',
  'U cookies.json',
].join('\r\n');

/** Fake cipher.exe: records arguments and answers with canned output. */
function fakeSpawn(outputs, calls) {
  return (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const { output = '', code = 0 } = outputs(args) ?? {};
    setImmediate(() => { child.stdout.emit('data', output); child.emit('close', code); });
    return child;
  };
}

test('cipher listings are parsed by path and E/U markers, independent of the UI language', () => {
  assert.deepEqual(parseCipherListing(LISTING), [
    { path: path.join('S:\\EANyra\\instance\\', 'accounts.json'), encrypted: true },
    { path: path.join('S:\\EANyra\\instance\\', 'data'), encrypted: false },
    { path: path.join('S:\\EANyra\\instance\\data\\', 'pot.sqlite'), encrypted: true },
    { path: path.join('S:\\EANyra\\instance\\data\\', 'pot.sqlite-wal'), encrypted: false },
    { path: path.join('S:\\EANyra\\instance\\data\\', 'cookies.json'), encrypted: false },
  ]);
  assert.deepEqual(parseCipherListing('E stray line without a header'), []);
  assert.equal(efsAvailable('win32'), true);
  assert.equal(efsAvailable('linux'), false);
});

test('status ignores SQLite side files and checks the root .env', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-efs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, '.env');
  await fs.writeFile(envFile, 'X=1');
  const calls = [];
  const spawnImpl = fakeSpawn(args => (args[0] === envFile
    ? { output: ` Listing C:\\somewhere\\\r\n\r\nU .env\r\n` }
    : { output: LISTING }), calls);
  const status = await protectionStatus({ instanceDir: 'S:\\EANyra\\instance', envFile, spawnImpl });
  assert.equal(status.total, 5);
  assert.equal(status.encrypted.length, 2);
  assert.deepEqual(status.plaintext.map(p => path.basename(p)), ['data', 'cookies.json', '.env']);
  assert.deepEqual(calls[0], ['cipher.exe', '/s:S:\\EANyra\\instance']);
});

test('protect encrypts files and folders recursively and reports locked files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-efs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, '.env');
  await fs.writeFile(envFile, 'X=1');
  const calls = [];
  const spawnImpl = fakeSpawn(args => (args.includes(envFile)
    ? { output: 'Encrypting files in ...\r\n.env [OK]\r\n' }
    : { output: 'pot.sqlite [ERR]\r\npot.sqlite: The process cannot access the file because it is being used by another process.\r\n', code: 1 }), calls);
  const result = await protectInstance({ instanceDir: 'S:\\EANyra\\instance', envFile, spawnImpl });
  assert.deepEqual(calls, [
    ['cipher.exe', '/e', '/a', '/s:S:\\EANyra\\instance'],
    ['cipher.exe', '/e', '/a', envFile],
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed[1], /being used by another process/);
});
