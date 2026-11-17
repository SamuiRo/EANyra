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
  await fs.writeFile(path.join(templatesDir, 'personas', '_template.yaml'), 'slug: "my-persona"\nname: "Persona"\naccounts:\n  - "twitter/brand_x"\n');
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify([{ username: 'brand_x', platform: 'twitter' }, { username: 'anime', platform: 'twitter' }]));
  return { contextDir, service: new ContextFileService({ contextDir, accountsConfigPath, templatesDir }) };
}

test('files are listed; the old shared files only while they exist', async t => {
  const { contextDir, service } = await setup(t);
  await fs.writeFile(path.join(contextDir, 'projects', 'eanyra.yaml'), 'name: EANyra\n');
  await fs.writeFile(path.join(contextDir, 'projects', '_template.yaml'), 'x: 1\n');
  assert.deepEqual((await service.list()).map(f => f.path), ['projects/eanyra.yaml']);
  await assert.rejects(service.read('voice.yaml'), error => error.status === 404 && /not used any more/.test(error.message));
  await fs.writeFile(path.join(contextDir, 'voice.yaml'), 'tone: calm\n');
  assert.deepEqual((await service.list()).map(f => [f.path, f.kind]), [['voice.yaml', 'legacy'], ['projects/eanyra.yaml', 'project']]);
});

test('an account is moved between personas and comments in the files stay', async t => {
  const { contextDir, service } = await setup(t);
  await fs.writeFile(path.join(contextDir, 'personas', 'brand.yaml'), 'slug: brand\n# my accounts\naccounts:\n  - "twitter/brand_x" # main\n  - "twitter/anime"\n');
  await fs.writeFile(path.join(contextDir, 'personas', 'fun.yaml'), 'slug: fun\naccounts: []\n');
  assert.deepEqual(await service.accountPersonas(), { 'twitter/brand_x': 'brand', 'twitter/anime': 'brand' });

  assert.deepEqual(await service.setAccountPersona('twitter/anime', 'fun'), { account: 'twitter/anime', persona: 'fun', changed: true });
  assert.deepEqual(await service.accountPersonas(), { 'twitter/brand_x': 'brand', 'twitter/anime': 'fun' });
  const brand = await fs.readFile(path.join(contextDir, 'personas', 'brand.yaml'), 'utf8');
  assert.match(brand, /# my accounts/);
  assert.match(brand, /"twitter\/brand_x" # main/);
  assert.doesNotMatch(brand, /anime/);

  // The last account may leave a persona; "none" removes it from every persona.
  await service.setAccountPersona('twitter/brand_x', null);
  assert.deepEqual(await service.accountPersonas(), { 'twitter/anime': 'fun' });
  assert.equal((await service.setAccountPersona('twitter/anime', 'fun')).changed, false);
  await assert.rejects(service.setAccountPersona('twitter/anime', 'ghost'), error => error.status === 404);
  await assert.rejects(service.setAccountPersona('twitter/nobody', 'fun'), /not found in accounts\.json/);
  assert.deepEqual(await service.accountPersonas(), { 'twitter/anime': 'fun' }, 'a failed move changes nothing');
});

test('the old shared files move into each persona without overriding it', async t => {
  const { contextDir, service } = await setup(t);
  await assert.rejects(service.migrateLegacy(), error => error.status === 409);
  await fs.writeFile(path.join(contextDir, 'voice.yaml'), 'tone: calm\ntaboo: ["No fake facts"]\n');
  await fs.writeFile(path.join(contextDir, 'platforms.yaml'), 'twitter:\n  max_length: 280\n  language: uk\nlinkedin:\n  max_length: 3000\n');
  await assert.rejects(service.migrateLegacy(), /Create a persona first/);
  await fs.writeFile(path.join(contextDir, 'personas', 'brand.yaml'), 'slug: brand # keep\naccounts: ["twitter/brand_x"]\nvoice:\n  tone: bold\nplatforms:\n  twitter:\n    language: en\n');

  const result = await service.migrateLegacy();
  assert.deepEqual(result.updated, ['personas/brand.yaml']);
  assert.equal(result.trashed.length, 2);
  await assert.rejects(fs.access(path.join(contextDir, 'voice.yaml')));
  const text = await fs.readFile(path.join(contextDir, 'personas', 'brand.yaml'), 'utf8');
  assert.match(text, /slug: brand # keep/);
  const { parse } = await import('yaml');
  const persona = parse(text);
  assert.deepEqual(persona.voice, { tone: 'bold', taboo: ['No fake facts'] });
  assert.deepEqual(persona.platforms, { twitter: { language: 'en', max_length: 280 } }, 'only the platforms of its accounts');
  assert.equal((await service.validate('personas/brand.yaml', text)).ok, true);
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
