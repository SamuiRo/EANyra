import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContextFileService } from '../src/core/services/ContextFileService.js';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-ctx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const contextDir = path.join(dir, 'context');
  const templatesDir = path.join(dir, 'templates');
  for (const folder of ['projects', 'personas']) {
    await fs.mkdir(path.join(contextDir, folder), { recursive: true });
    await fs.mkdir(path.join(templatesDir, folder), { recursive: true });
  }
  await fs.writeFile(path.join(templatesDir, 'voice.example.yaml'), '# template\ntone: ""\n');
  await fs.writeFile(path.join(templatesDir, 'personas', '_template.yaml'), 'slug: "my-persona"\nname: "Persona"\naccounts:\n  - "twitter/brand_x"\n');
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify([{ username: 'brand_x', platform: 'twitter' }, { username: 'anime', platform: 'twitter' }]));
  return { contextDir, service: new ContextFileService({ contextDir, accountsConfigPath, templatesDir }) };
}

test('files are listed and a missing top-level file starts from its template', async t => {
  const { contextDir, service } = await setup(t);
  await fs.writeFile(path.join(contextDir, 'projects', 'eanyra.yaml'), 'name: EANyra\n');
  await fs.writeFile(path.join(contextDir, 'projects', '_template.yaml'), 'x: 1\n');
  const files = await service.list();
  assert.deepEqual(files.map(f => [f.path, f.exists]), [
    ['voice.yaml', false], ['bio.yaml', false], ['platforms.yaml', false], ['projects/eanyra.yaml', true],
  ]);
  assert.deepEqual(await service.read('voice.yaml'), { path: 'voice.yaml', exists: false, content: '# template\ntone: ""\n' });
});

test('validation reports YAML syntax by line and schema problems by field', async t => {
  const { service } = await setup(t);
  const syntax = await service.validate('voice.yaml', 'tone: calm\nlikes: [unclosed\n');
  assert.equal(syntax.ok, false);
  assert.match(syntax.errors[0], /^YAML syntax/);
  assert.deepEqual(await service.validate('platforms.yaml', 'twitter:\n  max_length: lots\n'),
    { ok: false, errors: ['twitter.max_length must be a positive whole number'], warnings: [] });
  const warn = await service.validate('platforms.yaml', 'twitter:\n  frequency: daily\n');
  assert.equal(warn.ok, true);
  assert.match(warn.warnings[0], /did you mean "posting_frequency"/);
  assert.deepEqual((await service.validate('projects/tool.yaml', 'slug: other\n')).errors, ['slug "other" must match the filename "tool.yaml"']);
});

test('personas are checked against accounts.json and against each other', async t => {
  const { contextDir, service } = await setup(t);
  await fs.writeFile(path.join(contextDir, 'personas', 'brand.yaml'), 'slug: brand\naccounts:\n  - "twitter/brand_x"\n');
  assert.match((await service.validate('personas/anime.yaml', 'slug: anime\naccounts:\n  - "twitter/brand_x"\n')).errors[0],
    /belongs to both "brand" and "anime"/);
  assert.match((await service.validate('personas/anime.yaml', 'slug: anime\naccounts:\n  - "twitter/ghost"\n')).errors[0],
    /not found in accounts\.json/);
  assert.equal((await service.validate('personas/anime.yaml', 'slug: anime\naccounts:\n  - "twitter/anime"\n')).ok, true);
  // Editing a persona never conflicts with its own previous version.
  assert.equal((await service.validate('personas/brand.yaml', 'slug: brand\naccounts:\n  - "twitter/brand_x"\n')).ok, true);
});

test('saving refuses invalid content, keeps comments, and creates/trashes items safely', async t => {
  const { contextDir, service } = await setup(t);
  await service.write('platforms.yaml', '# my rules\ntwitter:\n  max_length: 280 # keep short\n');
  await assert.rejects(service.write('platforms.yaml', 'twitter:\n  max_length: lots\n'), error => error.status === 400 && /Not saved/.test(error.message));
  assert.equal(await fs.readFile(path.join(contextDir, 'platforms.yaml'), 'utf8'), '# my rules\ntwitter:\n  max_length: 280 # keep short\n');

  const created = await service.create('persona', 'gaming');
  assert.match(created.content, /^slug: "gaming"/m);
  await service.write(created.path, created.content);
  await assert.rejects(service.create('persona', 'gaming'), /already exists/);
  await assert.rejects(service.create('persona', 'Bad Name'), /kebab-case/);
  await assert.rejects(service.create('secret', 'x'), /project or persona/);

  const removed = await service.remove('personas/gaming.yaml');
  assert.match(removed.trashed, /^\.trash\/personas-gaming\.\d+\.yaml$/);
  await assert.rejects(fs.access(path.join(contextDir, 'personas', 'gaming.yaml')));
  await assert.rejects(service.remove('voice.yaml'), /Only project and persona/);

  for (const evil of ['../secrets.vault', 'projects/../../x.yaml', 'projects/a/b.yaml', 'C:\\x.yaml', 'voice.yml']) {
    await assert.rejects(service.read(evil), /Unknown context file/, evil);
    await assert.rejects(service.write(evil, 'x: 1'), /Unknown context file/, evil);
  }
});
