import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Sequelize } from 'sequelize';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { UserContextRepository } from '../src/core/teapot/repositories/UserContextRepository.js';
import {
  parseAccountRef,
  parsePersona,
  assertExclusiveMembership,
  mergePersonaContext,
} from '../src/config/personaConfig.js';

const serverPath = fileURLToPath(new URL('../src/core/mcp/start.js', import.meta.url));
const configured = new Set(['twitter/business', 'twitter/anime_fan', 'telegram/brand_channel']);

test('persona files are validated against accounts.json and their own filename', () => {
  assert.deepEqual(parseAccountRef('Twitter/@Anime_Fan'), { platform: 'twitter', username: 'anime_fan' });
  assert.deepEqual(parseAccountRef('@Anime_Fan', 'twitter'), { platform: 'twitter', username: 'anime_fan' });
  assert.throws(() => parseAccountRef('anime_fan'), /needs a platform/);
  assert.throws(() => parseAccountRef('myspace/x'), /Unsupported platform/);

  const persona = parsePersona({ name: 'Anime', accounts: ['twitter/Anime_Fan'] }, 'anime', configured);
  assert.equal(persona.slug, 'anime');
  assert.equal(persona.projects, null);
  for (const [data, pattern] of [
    [{ slug: 'other', accounts: ['twitter/anime_fan'] }, /must match the filename/],
    [{ accounts: [] }, /at least one/],
    [{ accounts: ['twitter/unknown'] }, /not found in accounts.json/],
    [{ accounts: ['twitter/anime_fan', 'twitter/@Anime_Fan'] }, /listed twice/],
    [{ accounts: ['twitter/anime_fan'], voice: ['casual'] }, /voice must be a mapping/],
    [{ accounts: ['twitter/anime_fan'], projects: 'eanyra' }, /projects must be a list/],
  ]) {
    assert.throws(() => parsePersona(data, 'anime', configured), pattern);
  }
  assert.throws(() => assertExclusiveMembership([
    parsePersona({ accounts: ['twitter/business'] }, 'brand', configured),
    parsePersona({ accounts: ['twitter/business'] }, 'anime', configured),
  ]), /belongs to both "brand" and "anime"/);
});

test('persona context overrides global defaults key by key and limits projects', () => {
  const global = {
    voice: { tone: 'Technical', taboo: ['No unverified facts'] },
    bio: { twitter: { short: 'Builder', full: null }, linkedin: { short: 'Engineer' } },
    platforms: { twitter: { max_length: 280, language: 'uk', style: 'precise' } },
    projects: [{ slug: 'eanyra' }, { slug: 'other' }],
  };
  const anime = parsePersona({
    accounts: ['twitter/anime_fan'], voice: { tone: 'Casual' }, bio: { twitter: { short: 'Anime fan' } },
    platforms: { twitter: { language: 'en' } }, projects: [],
  }, 'anime', configured);
  const merged = mergePersonaContext(global, anime);
  assert.deepEqual(merged.voice, { tone: 'Casual', taboo: ['No unverified facts'] });
  assert.deepEqual(merged.bio.twitter, { short: 'Anime fan', full: null });
  assert.deepEqual(merged.bio.linkedin, { short: 'Engineer' });
  assert.deepEqual(merged.platforms.twitter, { max_length: 280, language: 'en', style: 'precise' });
  assert.deepEqual(merged.projects, []);
  assert.deepEqual(merged.persona.accounts, ['twitter/anime_fan']);

  const brand = parsePersona({ accounts: ['twitter/business'], projects: ['eanyra'] }, 'brand', configured);
  assert.deepEqual(mergePersonaContext(global, brand).projects, [{ slug: 'eanyra' }]);
  const all = parsePersona({ accounts: ['twitter/business'] }, 'brand', configured);
  assert.equal(mergePersonaContext(global, all).projects.length, 2);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-personas-'));
  const storage = path.join(dir, 'test.sqlite');
  const accountsPath = path.join(dir, 'accounts.json');
  const contextDir = path.join(dir, 'context');
  await fs.mkdir(path.join(contextDir, 'personas'), { recursive: true });
  await fs.writeFile(accountsPath, JSON.stringify([
    { username: 'business', platform: 'twitter' },
    { username: 'anime_fan', platform: 'twitter' },
    { username: 'brand_channel', platform: 'telegram' },
  ]));
  await fs.writeFile(path.join(contextDir, 'voice.yaml'), 'tone: "Technical"\ntaboo: ["No unverified facts"]\n');
  const writePersona = (slug, yaml) => fs.writeFile(path.join(contextDir, 'personas', `${slug}.yaml`), yaml);
  await writePersona('brand', 'name: "Brand"\naccounts: ["twitter/business", "telegram/brand_channel"]\n');
  await writePersona('anime', 'name: "Anime"\ntopics: ["anime"]\naccounts: ["twitter/Anime_Fan"]\nvoice:\n  tone: "Casual"\nprojects: []\n');
  await fs.writeFile(path.join(contextDir, 'personas', '_template.yaml'), 'accounts: ["twitter/nobody"]\n');

  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  // Anything holding the database open must close before the directory goes.
  const closers = [];
  t.after(async () => {
    for (const close of closers) await close();
    await sequelize.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const accounts = await models.Account.bulkCreate([
    { username: 'business', platform: 'twitter' },
    { username: 'anime_fan', platform: 'twitter' },
    { username: 'brand_channel', platform: 'telegram' },
  ]);
  for (const [index, account] of accounts.entries()) {
    await models.Post.create({
      account_id: account.id, platform: account.platform, platform_id: `post-${index}`, text: `Post by ${account.username}`,
    });
  }
  const repo = new UserContextRepository(models, contextDir, accountsPath);
  return { dir, storage, accountsPath, contextDir, models, repo, writePersona, sequelize, closers };
}

test('context sync stores personas, rejects conflicts without partial writes, and removes deleted files', async t => {
  const { repo, models, writePersona, contextDir } = await fixture(t);
  let result = await repo.sync();
  assert.deepEqual(result.errors, []);
  assert.ok(result.updated.includes('persona.brand') && result.updated.includes('persona.anime'));
  assert.deepEqual((await repo.getKey('persona.anime')).accounts, [{ platform: 'twitter', username: 'anime_fan' }]);

  await writePersona('anime', 'accounts: ["twitter/business"]\n');
  result = await repo.sync();
  assert.match(result.errors.join(), /belongs to both/);
  // The stored anime persona is untouched by the invalid edit.
  assert.equal((await repo.getKey('persona.anime')).voice.tone, 'Casual');

  await fs.rm(path.join(contextDir, 'personas', 'anime.yaml'));
  result = await repo.sync();
  assert.deepEqual(result.errors, []);
  assert.equal(await repo.getKey('persona.anime'), null);
  assert.equal(await models.UserContext.count({ where: { key: 'persona.brand' } }), 1);
});

test('MCP resolves a persona from the target account and scopes posts to it', { timeout: 30000 }, async t => {
  const { dir, storage, accountsPath, contextDir, repo, sequelize, closers } = await fixture(t);
  assert.deepEqual((await repo.sync()).errors, []);
  await sequelize.close();
  const env = { ...process.env, INSTANCE_DIR: dir, DB_PATH: storage, DATA_DIR: dir, ACCOUNTS_CONFIG_PATH: accountsPath,
    CONTEXT_DIR: contextDir, MCP_TRANSPORT: 'stdio', TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', TELEGRAM_SESSION: '', GITHUB_TOKEN: '' };
  const client = new Client({ name: 'personas', version: '1.0' });
  closers.push(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: os.tmpdir(), env, stderr: 'pipe' }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError, body: JSON.parse(result.content[0].text) };
  };

  assert.match(client.getInstructions(), /personas_list/);
  const list = (await call('personas_list', {})).body;
  assert.deepEqual(list.personas.map(persona => persona.slug), ['anime', 'brand']);
  assert.deepEqual(list.personas[0].talks_about_projects, []);
  assert.equal(list.personas[1].talks_about_projects, 'all active projects');
  assert.deepEqual(list.accounts_without_persona, []);

  const overview = (await call('context_get', {})).body;
  assert.deepEqual(overview.personas.map(persona => persona.slug), ['anime', 'brand']);
  assert.match(overview.note, /call context_get/);
  assert.equal(overview['persona.anime'], undefined);

  const anime = (await call('context_get', { account: '@Anime_Fan', platform: 'twitter' })).body;
  assert.equal(anime.persona.slug, 'anime');
  assert.deepEqual(anime.voice, { tone: 'Casual', taboo: ['No unverified facts'] });
  assert.deepEqual(anime.projects, []);
  assert.equal((await call('context_get', { account: 'telegram/brand_channel' })).body.persona.slug, 'brand');
  assert.match((await call('context_get', { persona: 'anime', account: 'twitter/business' })).body.error, /belongs to "brand"/);
  assert.match((await call('context_get', { persona: 'missing' })).body.error, /Known personas: anime, brand/);

  const brandPosts = (await call('posts_get', { persona: 'brand', limit: 50 })).body;
  assert.deepEqual(brandPosts.posts.map(post => post.account).sort(), ['brand_channel', 'business']);
  const sampled = (await call('posts_get', { persona: 'anime', type: 'sample', limit: 10 })).body;
  assert.deepEqual(sampled.posts.map(post => post.account), ['anime_fan']);
  assert.equal((await call('posts_search', { query: 'Post by', persona: 'anime' })).body.count, 1);
  assert.deepEqual((await call('posts_stats', { persona: 'brand', days: 0 })).body.stats.map(row => row.username).sort(),
    ['brand_channel', 'business']);
  const listed = (await call('accounts_list', {})).body.accounts;
  assert.equal(listed.find(row => row.username === 'anime_fan').persona, 'anime');
  assert.ok(!(await call('signals_get', { persona: 'brand' })).error);

  // Collecting a persona selects its accounts. Telegram has no credentials here,
  // so the worker fails fast instead of opening a real network session.
  const job = (await call('scraper_run', { persona: 'brand', platform: 'telegram' })).body;
  assert.equal(job.persona, 'brand');
  assert.deepEqual(job.accounts, ['telegram/brand_channel']);
  let finished;
  for (let i = 0; i < 150 && (!finished || finished.status === 'running'); i++) {
    if (finished) await new Promise(resolve => setTimeout(resolve, 100));
    finished = (await call('scraper_job_get', { job_id: job.job_id })).body;
  }
  assert.equal(finished.status, 'failed');
  assert.match(finished.error ?? finished.result?.error_message ?? '', /brand_channel/);
  assert.match((await call('scraper_run', { persona: 'brand', accounts: ['twitter/business'] })).body.error, /either persona/);
  assert.match((await call('scraper_run', { persona: 'anime', platform: 'telegram' })).body.error, /no telegram accounts/);
});
