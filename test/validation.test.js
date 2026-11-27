import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize } from 'sequelize';

import {
  validateVoice, validateBio, validatePlatforms, validateProject, ContextValidationError,
} from '../src/config/contextSchema.js';
import { parsePersona } from '../src/config/personaConfig.js';
import { validatePosts, validateSignals, describeRejected } from '../src/core/teapot/recordValidation.js';
import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { UserContextRepository } from '../src/core/teapot/repositories/UserContextRepository.js';
import { ScraperOrchestrator } from '../src/core/orchestrator/ScraperOrchestrator.js';
import { Credentials } from '../src/core/secrets/Credentials.js';

const errorsOf = fn => {
  try {
    fn();
    return [];
  } catch (error) {
    assert.ok(error instanceof ContextValidationError, error.message);
    return error.errors;
  }
};

test('context files report wrong types with the exact field', () => {
  assert.deepEqual(errorsOf(() => validateVoice({ tone: 'calm', likes: 'short posts', taboo: ['x', 3] })),
    ['likes must be a list (one "- item" per line)', 'taboo[1] must be text']);
  assert.deepEqual(errorsOf(() => validatePlatforms({ twitter: { max_length: '280', language: 'Ukrainian' }, telegram: 'weekly' })),
    ['twitter.max_length must be a positive whole number', 'twitter.language must be a language code such as "uk" or "en"', 'telegram must be a mapping of rules']);
  assert.deepEqual(errorsOf(() => validateBio({ twitter: ['a'] })), ['twitter must be text or a mapping with short/full']);
  assert.deepEqual(errorsOf(() => validateVoice(['not', 'a', 'mapping'])), ['voice must be a YAML mapping (key: value lines)']);
  // Empty files are allowed and simply contribute nothing.
  assert.deepEqual(validateVoice(null), { value: {}, warnings: [] });
});

test('unknown keys and unreadable cadence warn without blocking', () => {
  const platforms = validatePlatforms({
    twitter: { frequency: 'daily', posting_frequency: 'whenever inspired', max_length: 280, language: 'uk' },
  });
  assert.deepEqual(platforms.warnings, [
    'twitter.frequency is not a known field and is ignored by EANyra (did you mean "posting_frequency"?)',
    'twitter.posting_frequency "whenever inspired" is not understood by the content plan; use e.g. "daily", "3 posts per week" or "щодня"',
  ]);
  assert.deepEqual(validateVoice({ examples: 'x' }).warnings, ['examples is not a known field and is ignored by EANyra (did you mean "example_post"?)']);
  assert.deepEqual(validateBio({ twitter: 'Short bio', linkedin: { short: 'x', full: null } }).warnings, []);
  assert.deepEqual(validatePlatforms({ telegram: { posting_frequency: '3 рази на тиждень', avoid: ['hype'] } }).warnings, []);
});

test('projects check slug, status and links', () => {
  assert.deepEqual(errorsOf(() => validateProject({
    slug: 'other', status: 'done', links: { site: 'ftp://x', repo: 'https://github.com/x/y', docs: null }, tech_stack: 'node',
  }, 'eanyra')), [
    'status must be one of active, paused, archived',
    'links.site must be an http(s) URL or null',
    'tech_stack must be a list (one "- item" per line)',
    'slug "other" must match the filename "eanyra.yaml"',
  ]);
  assert.deepEqual(errorsOf(() => validateProject({}, 'My Project')), ['the filename "My Project.yaml" must be lowercase kebab-case']);
  const ok = validateProject({ name: 'EANyra', status: 'active', content_angles: [] }, 'eanyra');
  assert.deepEqual(ok.warnings, ['content_angles is empty; the agent has no hooks for this project']);
});

test('persona overrides follow the same rules', () => {
  const base = { slug: 'brand', accounts: ['twitter/brand_x'] };
  assert.throws(() => parsePersona({ ...base, platforms: { twitter: { max_length: 'long' } } }, 'brand'), /platforms\.twitter\.max_length/);
  assert.throws(() => parsePersona({ ...base, voice: { likes: 'x' } }, 'brand'), /voice\.likes must be a list/);
  const persona = parsePersona({ ...base, platforms: { twitter: { cadence: 'daily' } }, colour: 'red', projects: [] }, 'brand');
  assert.deepEqual(persona.warnings, [
    'platforms.twitter.cadence is not a known field and is ignored by EANyra (did you mean "posting_frequency"?)',
    'colour is not a known persona field and is ignored',
  ]);
});

test('a file with errors is not synced; old shared files are reported and not used', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-ctx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'projects'));
  const accounts = path.join(dir, 'accounts.json');
  await fs.writeFile(accounts, '[]');
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const repo = new UserContextRepository(models, dir, accounts);

  // Rows from the old shared files are removed; the files only produce a warning.
  await models.UserContext.create({ key: 'voice', value: { tone: 'old' } });
  await fs.writeFile(path.join(dir, 'voice.yaml'), 'tone: calm\n');
  await fs.writeFile(path.join(dir, 'projects', 'tool.yaml'), 'slug: tool\nstatus: active\n');
  let result = await repo.sync();
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join(), /voice\.yaml: not used any more/);
  assert.equal(await repo.getKey('voice'), null);
  assert.equal(await models.Project.count(), 1);

  await fs.writeFile(path.join(dir, 'projects', 'tool.yaml'), 'slug: tool\nstatus: shipped\n');
  result = await repo.sync();
  assert.deepEqual(result.errors, ['projects/tool.yaml: status must be one of active, paused, archived']);
  assert.equal((await models.Project.findOne()).status, 'active', 'the previous version stays');
});

test('malformed records are dropped with a reason and the rest are kept', () => {
  const { valid, rejected } = validatePosts([
    { platform: 'linkedin', platform_id: '1', text: 'ok', likes: -5, views: 'n/a' },
    { platform: 'linkedin', platform_id: null, text: 'no id' },
    { platform: 'linkedin', platform_id: '  ', text: 'blank id' },
    { platform: 'twitter', platform_id: '2', text: 'wrong platform' },
    { platform: 'linkedin', platform_id: '3', posted_at: 'yesterday-ish' },
    { platform: 'linkedin', platform_id: 1, text: 'duplicate, newer' },
  ], 'linkedin');
  assert.deepEqual(valid.map(post => [post.platform_id, post.text, post.likes, post.views]), [['1', 'duplicate, newer', 0, null]]);
  assert.equal(describeRejected(rejected),
    'Skipped 4 invalid record(s): missing platform_id (×2); platform "twitter" does not match the account (linkedin); invalid posted_at');

  const signals = validateSignals([
    { source: 'github', source_id: 'r1', signal_type: 'release', title: 'x'.repeat(600) },
    { source: 'github', source_id: '', signal_type: 'release', title: 't' },
    { source: 'github', source_id: 'r2', signal_type: 'release', title: '' },
  ]);
  assert.equal(signals.valid[0].title.length, 512);
  assert.deepEqual(signals.rejected.map(r => r.reason), ['missing source_id', 'missing title']);
  assert.equal(describeRejected([]), null);
});

test('one bad record no longer fails the whole account', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-rec-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify([{ username: 'me', platform: 'linkedin' }]));
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const orchestrator = new ScraperOrchestrator(models, {
    notify: false, // never send real alerts from tests
    credentials: new Credentials({ legacy: { telegram: {} } }),
    accountsConfigPath, lockPath: path.join(dir, 'lock'), pause: async () => {},
    collectors: {
      linkedin: { collect: async () => ({ records: [
        { platform: 'linkedin', platform_id: '10', text: 'good' },
        { platform: 'linkedin', platform_id: null, text: 'broken row' },
      ] }) },
    },
  });
  const run = await orchestrator.run();
  assert.equal(run.status, 'success');
  assert.equal(await models.Post.count(), 1);
  const [outcome] = await sequelize.query('SELECT status, error FROM scraper_run_accounts', { type: Sequelize.QueryTypes.SELECT });
  assert.equal(outcome.status, 'partial');
  assert.match(outcome.error, /Skipped 1 invalid record\(s\): missing platform_id/);
});
