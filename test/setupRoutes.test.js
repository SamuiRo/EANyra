import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Vault } from '../src/core/secrets/Vault.js';
import { getVault } from '../src/core/secrets/vaultAccess.js';
import { buildSetupRoutes } from '../src/web/setupRoutes.js';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-setup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const vaultFile = path.join(dir, 'secrets.vault');
  const state = { created: 0, remembered: 0 };
  const routes = buildSetupRoutes({
    vaultFile, onCreated: () => { state.created += 1; },
    importLegacy: async vault => { await vault.set('github', 'default', { token: 'from-env' }); return ['GITHUB_TOKEN → github/default']; },
    keyStore: { available: () => true, remember: async () => { state.remembered += 1; } },
  });
  return { vaultFile, state, create: body => routes['POST /api/setup/vault']({ body }) };
}

test('the vault is created from the browser once, with legacy secrets imported', async t => {
  const { vaultFile, state, create } = await setup(t);
  await assert.rejects(create({ password: 'short', repeat: 'short' }), error => error.status === 400);
  await assert.rejects(create({ password: 'long enough pass', repeat: 'something else!' }), error => error.status === 400 && /match/.test(error.message));
  await assert.rejects(fs.access(vaultFile));

  assert.deepEqual(await create({ password: 'long enough pass', repeat: 'long enough pass', remember: true }),
    { created: true, imported: ['GITHUB_TOKEN → github/default'], remembered: true });
  assert.deepEqual(state, { created: 1, remembered: 1 });
  // Unlocked for this process, so the rest of the web UI works at once.
  assert.equal((await getVault({ interactive: false, filePath: vaultFile })).get('github', 'default').token, 'from-env');
  await new Vault(vaultFile).unlock('long enough pass');

  await assert.rejects(create({ password: 'another password', repeat: 'another password' }), error => error.status === 409);
  assert.equal(state.created, 1);
});
