import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Sequelize } from 'sequelize';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { registerModels } from '../src/core/teapot/models/index.js';
import { SchemaMigrator } from '../src/core/teapot/SchemaMigrator.js';
import { UserContextRepository } from '../src/core/teapot/repositories/UserContextRepository.js';
import { ExportRepository } from '../src/core/teapot/repositories/ExportRepository.js';
import { ContextFileService } from '../src/core/services/ContextFileService.js';
import { ContentService } from '../src/core/services/ContentService.js';
import { sequelizeExecutor } from '../src/core/services/sql.js';
import { validateAccounts } from '../src/config/accountConfig.js';
import {
  parsePersona, assertPersonaLinks, disclosureTaboo, mergePersonaContext, withoutIsolatedProjects,
} from '../src/config/personaConfig.js';

const serverPath = fileURLToPath(new URL('../src/core/mcp/start.js', import.meta.url));
const srcUrl = pathToFileURL(fileURLToPath(new URL('../src/', import.meta.url))).href;
const configured = new Set(['twitter/example_public', 'twitter/example_linked', 'twitter/example_hidden']);

// Rule 1: new fields, their defaults and validation

test('type, disclosure and linked_to are parsed with safe defaults', () => {
  const plain = parsePersona({ accounts: ['twitter/example_public'], projects: [] }, 'example-public', configured);
  assert.equal(plain.type, null);
  assert.equal(plain.disclosure, 'public');
  assert.deepEqual(plain.linked_to, []);
  assert.deepEqual(plain.warnings, []);

  const linked = parsePersona({
    accounts: ['twitter/example_linked'], type: 'fan', disclosure: 'linked', linked_to: ['example-public', 'example-public'], projects: [],
  }, 'example-linked', configured);
  assert.equal(linked.type, 'fan');
  assert.deepEqual(linked.linked_to, ['example-public']);

  for (const [data, pattern] of [
    [{ type: 'robot' }, /type must be one of: person, brand, fan, faceless/],
    [{ disclosure: 'secret' }, /disclosure must be one of: public, linked, isolated/],
    [{ disclosure: 'linked', linked_to: 'example-public' }, /linked_to must be a list/],
    [{ disclosure: 'linked', linked_to: ['Not A Slug'] }, /linked_to must be a list/],
    [{ disclosure: 'linked', linked_to: ['example-linked'] }, /cannot contain the persona itself/],
  ]) {
    assert.throws(() => parsePersona({ accounts: ['twitter/example_linked'], projects: [], ...data }, 'example-linked', configured), pattern);
  }
  const ignored = parsePersona({ accounts: [], projects: [], linked_to: ['example-public'] }, 'example-other', configured);
  assert.deepEqual(ignored.linked_to, [], 'linked_to only applies to linked personas');
  assert.match(ignored.warnings.join(), /linked_to is used only with disclosure: linked/);
  const lonely = parsePersona({ accounts: [], projects: [], disclosure: 'linked' }, 'example-other', configured);
  assert.match(lonely.warnings.join(), /linked_to is empty/);
});

test('linked_to must name existing, non-isolated personas', () => {
  const make = (slug, data) => parsePersona({ accounts: [], projects: [], ...data }, slug, configured);
  const hidden = make('example-hidden', { disclosure: 'isolated' });
  const pub = make('example-public', {});
  assert.doesNotThrow(() => assertPersonaLinks([pub, make('example-linked', { disclosure: 'linked', linked_to: ['example-public'] })]));
  assert.throws(() => assertPersonaLinks([pub, make('example-linked', { disclosure: 'linked', linked_to: ['example-ghost'] })]),
    /links to unknown persona "example-ghost"/);
  assert.throws(() => assertPersonaLinks([hidden, make('example-linked', { disclosure: 'linked', linked_to: ['example-hidden'] })]),
    /isolated personas cannot be linked/);
});

// Rule 2: projects default to none

test('an omitted projects list means no projects, also for rows synced before the change', () => {
  const persona = parsePersona({ accounts: ['twitter/example_public'] }, 'example-public', configured);
  assert.deepEqual(persona.projects, []);
  assert.match(persona.warnings.join(), /projects is not set/);
  const global = { projects: [{ slug: 'example-project' }] };
  assert.deepEqual(mergePersonaContext(global, persona).projects, []);
  assert.deepEqual(mergePersonaContext(global, { ...persona, projects: null }).projects, []);
});

async function contextDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-isolation-'));
  // Anything holding the database open (MCP clients) closes before the directory goes.
  const closers = [];
  t.after(async () => {
    for (const close of closers) await close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const context = path.join(dir, 'context');
  await fs.mkdir(path.join(context, 'personas'), { recursive: true });
  await fs.mkdir(path.join(context, 'projects'), { recursive: true });
  return { dir, context, closers };
}

test('context sync writes the old implicit project list into persona files from before the change, once', async t => {
  const { dir, context } = await contextDir(t);
  const accounts = path.join(dir, 'accounts.json');
  await fs.writeFile(accounts, JSON.stringify([{ username: 'example_public', platform: 'twitter' }]));
  await fs.writeFile(path.join(context, 'projects', 'example-one.yaml'), 'slug: example-one\nstatus: active\n');
  await fs.writeFile(path.join(context, 'projects', 'example-two.yaml'), 'slug: example-two\nstatus: active\n');
  await fs.writeFile(path.join(context, 'projects', 'example-old.yaml'), 'slug: example-old\nstatus: archived\n');
  const legacyFile = path.join(context, 'personas', 'example-legacy.yaml');
  await fs.writeFile(legacyFile, '# Kept comment\nname: "Legacy"\naccounts: ["twitter/example_public"]\n');
  // A file that already uses the new fields keeps the new default.
  await fs.writeFile(path.join(context, 'personas', 'example-new.yaml'), 'name: "New"\ndisclosure: public\naccounts: []\n');

  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const repo = new UserContextRepository(models, context, accounts);

  const first = await repo.sync();
  assert.deepEqual(first.errors, []);
  assert.match(first.warnings.join('\n'), /example-legacy\.yaml: projects was not set; wrote the 2 active project/);
  const written = await fs.readFile(legacyFile, 'utf8');
  assert.match(written, /# Kept comment/);
  assert.match(written, /projects:\n\s+- example-one\n\s+- example-two/);
  assert.deepEqual((await repo.getKey('persona.example-legacy')).projects, ['example-one', 'example-two']);
  assert.deepEqual((await repo.getKey('persona.example-new')).projects, []);
  assert.match(first.warnings.join('\n'), /example-new\.yaml: projects is not set/);

  const second = await repo.sync();
  assert.deepEqual(second.errors, []);
  assert.doesNotMatch(second.warnings.join('\n'), /wrote the/);
  assert.equal(await fs.readFile(legacyFile, 'utf8'), written);

  // Linking to an isolated persona blocks the sync and keeps the stored personas.
  await fs.writeFile(path.join(context, 'personas', 'example-hidden.yaml'), 'disclosure: isolated\naccounts: []\nprojects: []\n');
  await fs.writeFile(path.join(context, 'personas', 'example-new.yaml'),
    'disclosure: linked\nlinked_to: [example-hidden]\naccounts: []\nprojects: []\n');
  const third = await repo.sync();
  assert.match(third.errors.join(), /isolated personas cannot be linked/);
  assert.equal((await repo.getKey('persona.example-new')).disclosure, 'public');

  // The web editor applies the same cross-file rule.
  const files = new ContextFileService({ contextDir: context, accountsConfigPath: accounts });
  const validation = await files.validate('personas/example-new.yaml', 'disclosure: linked\nlinked_to: [example-hidden]\naccounts: []\nprojects: []\n');
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(), /isolated personas cannot be linked/);
});

// Rule 4: linked taboo (and isolated personas are never named elsewhere)

test('disclosure adds taboo rules and never names an isolated persona', () => {
  const make = (slug, data) => parsePersona({ projects: [], ...data }, slug, configured);
  const pub = make('example-public', { name: 'Example Public', accounts: ['twitter/example_public'] });
  const other = make('example-other', { name: 'Example Other', accounts: [] });
  const hidden = make('example-hidden', { name: 'Example Hidden', disclosure: 'isolated', accounts: ['twitter/example_hidden'] });
  const linked = make('example-linked', {
    name: 'Example Linked', type: 'brand', disclosure: 'linked', linked_to: ['example-public'], accounts: ['twitter/example_linked'],
    voice: { taboo: ['Own rule'] },
  });
  const all = [pub, other, hidden, linked];

  assert.deepEqual(disclosureTaboo(pub, all), []);
  const context = mergePersonaContext({ projects: [] }, linked, all);
  const [first, ...rest] = context.voice.taboo.slice(1);
  assert.equal(context.voice.taboo[0], 'Own rule');
  assert.match(first, /except "Example Public" \(example-public, twitter\/example_public\)/);
  assert.deepEqual(rest, ['Never mention "Example Other" (example-other).']);
  assert.doesNotMatch(JSON.stringify(context), /example-hidden|Example Hidden/);
  assert.equal(context.persona.type, 'brand');
  assert.match(context.persona.speaks_as, /brand or team/);
  assert.deepEqual(linked.voice.taboo, ['Own rule'], 'the stored voice is not changed');

  assert.match(disclosureTaboo(hidden, all)[0], /any other persona, account or project/);
  assert.deepEqual(withoutIsolatedProjects(
    [{ slug: 'example-shared' }, { slug: 'example-secret' }, { slug: 'example-free' }],
    [{ ...pub, projects: ['example-shared'] }, { ...hidden, projects: ['example-secret', 'example-shared'] }],
  ).map(project => project.slug), ['example-shared', 'example-free']);
});

// Rules 3 and 5 through the real stdio MCP server

const ACCOUNTS = [
  { username: 'example_public', platform: 'twitter' },
  { username: 'example_public_channel', platform: 'telegram', publish_enabled: true },
  { username: 'example_linked', platform: 'twitter' },
  { username: 'example_hidden', platform: 'twitter' },
  { username: 'example_hidden_channel', platform: 'telegram', publish_enabled: true },
  { username: 'example_loose', platform: 'twitter' },
];

async function fixture(t) {
  const { dir, context, closers } = await contextDir(t);
  const storage = path.join(dir, 'test.sqlite');
  const accountsPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsPath, JSON.stringify(ACCOUNTS));
  const write = (rel, text) => fs.writeFile(path.join(context, rel), text);
  await write('projects/example-shared.yaml', 'slug: example-shared\nname: Shared\nstatus: active\n');
  await write('projects/example-secret.yaml', 'slug: example-secret\nname: Secret\nstatus: active\n');
  await write('personas/example-public.yaml', 'name: "Example Public"\ntype: brand\n' +
    'accounts: ["twitter/example_public", "telegram/example_public_channel"]\nprojects: [example-shared]\n');
  await write('personas/example-linked.yaml', 'name: "Example Linked"\ntype: person\ndisclosure: linked\nlinked_to: [example-public]\n' +
    'accounts: ["twitter/example_linked"]\nprojects: []\n');
  await write('personas/example-hidden.yaml', 'name: "Example Hidden"\ntype: faceless\ndisclosure: isolated\n' +
    'accounts: ["twitter/example_hidden", "telegram/example_hidden_channel"]\nprojects: [example-secret]\n');

  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const rows = {};
  for (const entry of ACCOUNTS) {
    rows[entry.username] = await models.Account.create({ username: entry.username, platform: entry.platform, last_scraped_at: new Date() });
    await models.Post.create({ account_id: rows[entry.username].id, platform: entry.platform, platform_id: `p-${entry.username}`,
      text: `Post by ${entry.username}`, posted_at: new Date() });
  }
  await models.Signal.bulkCreate([
    { account_id: rows.example_hidden.id, source: 'note', source_id: 's1', signal_type: 'idea', title: 'Hidden account idea' },
    { source: 'note', source_id: 's2', signal_type: 'idea', title: 'Hidden bound idea', metadata: { persona: 'example-hidden' } },
    { source: 'note', source_id: 's3', signal_type: 'idea', title: 'Free idea' },
    { account_id: rows.example_public.id, source: 'note', source_id: 's4', signal_type: 'idea', title: 'Public idea' },
  ]);
  const repo = new UserContextRepository(models, context, accountsPath);
  assert.deepEqual((await repo.sync()).errors, []);
  const now = new Date().toISOString();
  const draft = (persona, platform, account, text, status = 'draft') => sequelize.query(
    `INSERT INTO drafts (persona, platform, account, text, status, signal_ids, created_by, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', 'ai', ?, ?, ?)`,
    { replacements: [persona, platform, account, text, status, status === 'published' ? now : null, now, now] });
  await draft('example-hidden', 'telegram', 'example_hidden_channel', 'Hidden channel text', 'published'); // 1
  await draft('example-public', 'twitter', 'example_public', 'Public draft'); // 2
  await draft('example-public', 'telegram', 'example_hidden_channel', 'Misfiled text'); // 3
  await draft(null, 'telegram', 'example_public_channel', 'Draft without persona'); // 4
  await draft('example-public', 'telegram', 'example_public_channel', 'Good public post'); // 5
  await draft('example-hidden', 'twitter', 'example_hidden', 'Hidden waiting draft'); // 6

  const env = { ...process.env, INSTANCE_DIR: dir, DB_PATH: storage, DATA_DIR: dir, ACCOUNTS_CONFIG_PATH: accountsPath,
    CONTEXT_DIR: context, MCP_TRANSPORT: 'stdio', TELEGRAM_PUBLISH_TRANSPORT: 'bot', TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', TELEGRAM_SESSION: '', GITHUB_TOKEN: '' };
  return { dir, env, sequelize, models, closers };
}

async function connect(closers, env) {
  const client = new Client({ name: 'isolation', version: '1.0' });
  closers.push(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: os.tmpdir(), env, stderr: 'pipe' }));
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text }; }
    return { error: Boolean(result.isError), body };
  };
}

test('an agent never sees an isolated persona or its data without naming it', { timeout: 60000 }, async t => {
  const { env, sequelize, models, closers } = await fixture(t);

  // The Markdown export is read by agents too (export_get).
  const exportRepo = new ExportRepository(models);
  const exported = await exportRepo.getPosts({ days: 30 });
  assert.ok(!exported.some(post => post.username.startsWith('example_hidden')));
  assert.equal(exported.length, 4);
  assert.deepEqual((await exportRepo.getPosts({ days: 30, persona: 'example-hidden' })).map(post => post.username).sort(),
    ['example_hidden', 'example_hidden_channel']);
  assert.deepEqual((await exportRepo.getSignals({ days: 30 })).map(signal => signal.title).sort(), ['Free idea', 'Public idea']);
  assert.deepEqual((await exportRepo.getSignals({ days: 30, persona: 'example-hidden' })).map(signal => signal.title).sort(),
    ['Hidden account idea', 'Hidden bound idea']);
  const exportContext = await exportRepo.getContext({});
  assert.deepEqual(exportContext.personas.sort(), ['example-linked', 'example-public']);
  assert.deepEqual(exportContext.projects.map(project => project.slug), ['example-shared']);
  const hiddenExport = await exportRepo.getContext({ persona: 'example-hidden' });
  assert.deepEqual(hiddenExport.projects.map(project => project.slug), ['example-secret']);
  assert.match(hiddenExport.voice.taboo.join(), /any other persona/);
  await sequelize.close();

  const call = await connect(closers, env);
  const hidden = /example-hidden|example_hidden|Example Hidden|example-secret|Hidden/;

  const list = (await call('personas_list')).body;
  assert.deepEqual(list.personas.map(p => p.slug), ['example-linked', 'example-public']);
  assert.deepEqual(list.accounts_without_persona, ['twitter/example_loose']);
  assert.equal(list.personas[1].type, 'brand');
  assert.deepEqual(list.personas[0].linked_to, ['example-public']);
  assert.doesNotMatch(JSON.stringify(list), hidden);

  const overview = (await call('context_get')).body;
  assert.doesNotMatch(JSON.stringify(overview), hidden);
  assert.deepEqual(overview.projects.map(project => project.slug), ['example-shared']);

  const byAccount = await call('context_get', { account: 'twitter/example_hidden' });
  assert.equal(byAccount.error, true);
  assert.match(byAccount.body.error, /restricted: pass its persona slug/);
  assert.doesNotMatch(byAccount.body.error, /example-hidden/);
  const named = (await call('context_get', { persona: 'example-hidden' })).body;
  assert.equal(named.persona.disclosure, 'isolated');
  assert.deepEqual(named.projects.map(project => project.slug), ['example-secret']);
  assert.match(named.voice.taboo.join(), /any other persona, account or project/);
  assert.equal((await call('context_get', { persona: 'example-hidden', account: 'twitter/example_hidden' })).body.persona.slug, 'example-hidden');
  assert.doesNotMatch((await call('context_get', { persona: 'example-ghost' })).body.error, hidden);

  const linked = (await call('context_get', { persona: 'example-linked' })).body;
  assert.match(linked.voice.taboo[0], /except "Example Public"/);
  assert.doesNotMatch(JSON.stringify(linked), hidden);

  for (const [name, args, pick] of [
    ['posts_get', { limit: 50 }, body => body.posts.map(post => post.account)],
    ['posts_get', { limit: 50, type: 'sample' }, body => body.posts.map(post => post.account)],
    ['posts_search', { query: 'Post by' }, body => body.posts.map(post => post.account)],
    ['posts_stats', { days: 0 }, body => body.stats.map(row => row.username)],
    ['accounts_list', {}, body => body.accounts.map(row => row.username)],
    ['signals_get', { limit: 50 }, body => body.signals.map(signal => signal.title)],
    ['drafts_list', {}, body => body.map(draft => `${draft.persona}:${draft.account}:${draft.text}`)],
    ['content_plan_get', {}, body => body.personas.flatMap(group => [group.persona?.slug, ...group.accounts.map(item => item.account)])],
  ]) {
    const result = await call(name, args);
    assert.ok(!result.error, `${name}: ${result.body.error}`);
    const values = pick(result.body);
    assert.ok(values.length, `${name} returns the visible data`);
    assert.doesNotMatch(JSON.stringify(values), /example-hidden|example_hidden/, `${name} without persona hides the isolated persona`);
  }
  assert.ok((await call('signals_get', { limit: 50 })).body.signals.some(signal => signal.title === 'Free idea'));
  assert.equal((await call('content_performance_get')).body.published, 0);

  // Naming the persona returns its data.
  assert.deepEqual((await call('posts_get', { persona: 'example-hidden', limit: 50 })).body.posts.map(post => post.account).sort(),
    ['example_hidden', 'example_hidden_channel']);
  assert.equal((await call('posts_search', { query: 'Post by', persona: 'example-hidden' })).body.count, 2);
  assert.equal((await call('posts_stats', { persona: 'example-hidden', days: 0 })).body.stats.length, 2);
  assert.ok((await call('accounts_list', { persona: 'example-hidden' })).body.accounts.every(row => row.persona === 'example-hidden'));
  assert.deepEqual((await call('signals_get', { persona: 'example-hidden', limit: 50 })).body.signals.map(signal => signal.title).sort(),
    ['Hidden account idea', 'Hidden bound idea']);
  assert.equal((await call('drafts_list', { persona: 'example-hidden' })).body.length, 2);
  assert.equal((await call('content_plan_get', { persona: 'example-hidden' })).body.personas[0].persona.slug, 'example-hidden');
  assert.equal((await call('content_performance_get', { persona: 'example-hidden' })).body.published, 1);

  // Rule 5: drafts follow the account's persona.
  const mismatch = await call('draft_create', { platform: 'twitter', account: 'twitter/example_public', persona: 'example-linked', text: 'x' });
  assert.match(mismatch.body.error, /belongs to persona "example-public", not "example-linked"/);
  const masked = await call('draft_create', { platform: 'twitter', account: 'twitter/example_hidden', persona: 'example-public', text: 'x' });
  assert.match(masked.body.error, /belongs to another persona, not "example-public"/);
  const loose = await call('draft_create', { platform: 'twitter', account: 'example_loose', persona: 'example-public', text: 'x' });
  assert.match(loose.body.error, /belongs to no persona/);
  assert.equal((await call('draft_create', { platform: 'twitter', account: 'example_linked', text: 'Mine' })).body.persona, 'example-linked');

  const misfiled = await call('draft_prepare_telegram', { id: 3 });
  assert.match(misfiled.body.error, /written for persona "example-public", but telegram\/example_hidden_channel belongs to another persona/);
  assert.match((await call('draft_prepare_telegram', { id: 4 })).body.error, /written without a persona/);
  const prepared = await call('draft_prepare_telegram', { id: 5 });
  assert.ok(!prepared.error, prepared.body.error);
  assert.equal(prepared.body.status, 'draft');

  const raw = { request_id: 'example_raw_1', account: 'example_public_channel', text: 'A fresh public post' };
  const noPersona = await call('telegram_post_prepare', raw);
  assert.equal(noPersona.error, true);
  assert.match(noPersona.body.error, /persona/);
  assert.match((await call('telegram_post_prepare', { ...raw, persona: 'example-linked' })).body.error,
    /belongs to another persona, not "example-linked"/);
  assert.match((await call('telegram_post_prepare', { ...raw, account: 'example_hidden_channel', persona: 'example-public' })).body.error,
    /belongs to another persona/);
  assert.match((await call('telegram_post_prepare', { ...raw, persona: 'example-public', text: '  Hidden channel text ' })).body.error,
    /This text is draft 1, written for another persona/);
  const ok = await call('telegram_post_prepare', { ...raw, persona: 'example-public' });
  assert.ok(!ok.error, ok.body.error);
  assert.equal(ok.body.status, 'draft');
});

test('the author web UI scope sees isolated personas; MCP clients never pass it', { timeout: 60000 }, async t => {
  const { env, sequelize } = await fixture(t);
  await sequelize.close();
  // A separate process: the MCP database module reads DB_PATH when it loads.
  const script = `
    const { callTool, AUTHOR, AGENT } = await import(${JSON.stringify(`${srcUrl}core/mcp/toolRegistry.js`)});
    const { buildContextTools } = await import(${JSON.stringify(`${srcUrl}core/mcp/context.js`)});
    const { postTools } = await import(${JSON.stringify(`${srcUrl}core/mcp/tools/posts.js`)});
    const tools = new Map([...buildContextTools(), ...postTools].map(tool => [tool.name, tool]));
    const slugs = async scope => (await callTool(tools.get('personas_list'), {}, scope)).personas.map(p => p.slug);
    const posts = async scope => (await callTool(tools.get('posts_get'), { limit: 50 }, scope)).posts.length;
    process.stdout.write(JSON.stringify({
      author: await slugs(AUTHOR), agent: await slugs(AGENT), fallback: await slugs(undefined),
      authorPosts: await posts(AUTHOR), agentPosts: await posts(AGENT),
    }));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env, cwd: os.tmpdir() });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.author, ['example-hidden', 'example-linked', 'example-public']);
  assert.deepEqual(result.agent, ['example-linked', 'example-public']);
  assert.deepEqual(result.fallback, ['example-linked', 'example-public'], 'no scope means agent');
  assert.equal(result.authorPosts, 6);
  assert.equal(result.agentPosts, 4);
});

test('ContentService applies the same rules for the web UI', async t => {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const personas = [
    { slug: 'example-public', name: 'Public', disclosure: 'public', linked_to: [], projects: [], voice: {}, bio: {}, platforms: {},
      accounts: [{ platform: 'telegram', username: 'example_public_channel' }] },
    { slug: 'example-hidden', name: 'Hidden', disclosure: 'isolated', linked_to: [], projects: [], voice: {}, bio: {}, platforms: {},
      accounts: [{ platform: 'telegram', username: 'example_hidden_channel' }] },
  ];
  const content = new ContentService(sequelizeExecutor(sequelize), {
    loadAccounts: async () => validateAccounts(ACCOUNTS), loadPersonas: async () => personas, loadGlobalContext: async () => ({ projects: [] }),
  });
  await content.createDraft({ platform: 'telegram', account: 'example_hidden_channel', text: 'Hidden' });
  await content.createDraft({ platform: 'telegram', account: 'example_public_channel', text: 'Public' });
  assert.deepEqual((await content.listDrafts({})).map(d => d.persona), ['example-public']);
  assert.deepEqual((await content.listDrafts({}, { author: true })).map(d => d.persona).sort(), ['example-hidden', 'example-public']);
  assert.deepEqual((await content.contentPlan({}, { author: true })).personas.map(g => g.persona?.slug ?? null).sort(),
    ['example-hidden', 'example-public', null]);
  // The persona checks hold for the author too.
  await assert.rejects(content.assertTelegramPost({ persona: 'example-public', account: 'example_hidden_channel', text: 'Public' }),
    /belongs to another persona/);
  await assert.rejects(content.assertTelegramPost({ persona: 'example-public', account: 'example_public_channel', text: 'Hidden' }),
    /written for another persona/);
  await assert.rejects(content.assertTelegramPost({ account: 'example_public_channel', text: 'x' }), /persona is required/);
  assert.deepEqual(await content.assertTelegramPost({ persona: 'example-public', account: '@example_public_channel', text: 'Public' }),
    { persona: 'example-public', account: 'example_public_channel' });
});
