import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The collector reads the imports folder from configuration at import time.
const importsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-li-imports-'));
process.env.LINKEDIN_IMPORTS_DIR = importsDir;
process.on('exit', () => rmSync(importsDir, { recursive: true, force: true }));

const { Sequelize, QueryTypes } = await import('sequelize');
const { registerModels } = await import('../src/core/teapot/models/index.js');
const { SchemaMigrator } = await import('../src/core/teapot/SchemaMigrator.js');
const { ScraperOrchestrator } = await import('../src/core/orchestrator/ScraperOrchestrator.js');
const { Credentials } = await import('../src/core/secrets/Credentials.js');
const { LinkedinImportRepository } = await import('../src/core/teapot/repositories/LinkedinImportRepository.js');
const { parseLinkedinDate, normalizeShareCommentary, parseCsvString } = await import('../src/platforms/linkedin/csvParser.js');

const HEADER = 'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\r\n';
const row = (id, date, text) => `${date},https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A${id},${text},,,MEMBER_NETWORK\r\n`;

async function setup(t, accounts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-li-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of await fs.readdir(importsDir)) await fs.rm(path.join(importsDir, name));
  const accountsConfigPath = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsConfigPath, JSON.stringify(accounts));
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  t.after(() => sequelize.close());
  const models = registerModels(sequelize);
  await new SchemaMigrator(sequelize).migrate();
  const orchestrator = new ScraperOrchestrator(models, {
    notify: false, credentials: new Credentials({ legacy: { telegram: {} } }),
    accountsConfigPath, lockPath: path.join(dir, 'lock'), pause: async () => {},
  });
  const outcomes = async () => sequelize.query(
    'SELECT username, status, records_saved, error FROM scraper_run_accounts ORDER BY id', { type: QueryTypes.SELECT });
  return { sequelize, models, orchestrator, outcomes, history: new LinkedinImportRepository(sequelize) };
}

test('LinkedIn export dates are UTC, not local time', () => {
  assert.equal(parseLinkedinDate('2026-11-01 10:00:00').toISOString(), '2026-11-01T10:00:00.000Z');
  assert.equal(parseLinkedinDate('2026-11-01 10:00').toISOString(), '2026-11-01T10:00:00.000Z');
  assert.equal(parseLinkedinDate(''), null);
  assert.equal(parseLinkedinDate('not a date'), null);
});

test('LinkedIn per-line quote wrapping is removed from multi-line posts', () => {
  // Raw export shape: every line of ShareCommentary is wrapped in doubled quotes.
  const raw = HEADER + '2026-05-05 09:28:21,https://x,"First line.""\r\n""""\r\n""Say ""hi"" here.""\r\n""""\r\n""#ai","","",MEMBER_NETWORK\r\n';
  const [row0] = parseCsvString(raw);
  assert.equal(normalizeShareCommentary(row0.ShareCommentary), 'First line.\n\nSay "hi" here.\n\n#ai');
  // A trailing wrapped empty line disappears.
  assert.equal(normalizeShareCommentary('One"\n"Two"\n"'), 'One\nTwo');
  // Text without the wrapper is left alone.
  assert.equal(normalizeShareCommentary('Plain "quoted" text'), 'Plain "quoted" text');
  assert.equal(normalizeShareCommentary('Line one\n"Quoted line"'), 'Line one\n"Quoted line"');
});

test('imports are recorded, unchanged files are skipped and new exports imported', async t => {
  const { models, orchestrator, history } = await setup(t, [{ username: 'me', platform: 'linkedin', import_file: 'Shares-me.csv' }]);
  const file = path.join(importsDir, 'Shares-me.csv');
  await fs.writeFile(file, HEADER + row(1, '2026-11-01 10:00:00', 'One') + row(2, '2026-11-02 11:00:00', 'Two'));

  await orchestrator.run({ platform: 'linkedin' });
  let [latest] = await history.history();
  assert.deepEqual([latest.status, latest.rows, latest.new_posts, latest.conflicts], ['imported', 2, 2, 0]);
  assert.equal(new Date(latest.newest_post_at).toISOString(), '2026-11-02T11:00:00.000Z');
  const post = await models.Post.findOne({ where: { platform_id: '1' } });
  assert.equal(post.posted_at.toISOString(), '2026-11-01T10:00:00.000Z');

  await orchestrator.run({ platform: 'linkedin' });          // same file
  assert.equal((await history.history()).length, 1);

  await fs.appendFile(file, row(3, '2026-11-03 12:00:00', 'Three'));   // a newer export
  await orchestrator.run({ platform: 'linkedin' });
  [latest] = await history.history();
  assert.deepEqual([latest.rows, latest.new_posts], [3, 1]);
  assert.equal(await models.Post.count(), 3);
});

test('two accounts on one export: the second gets no foreign posts and a clear warning', async t => {
  const { models, orchestrator, outcomes, history } = await setup(t, [
    { username: 'alpha', platform: 'linkedin', import_file: 'Shares.csv' },
    { username: 'beta', platform: 'linkedin', import_file: 'Shares.csv' },
  ]);
  await fs.writeFile(path.join(importsDir, 'Shares.csv'), HEADER + row(7, '2026-11-01 10:00:00', 'Seven'));
  const run = await orchestrator.run({ platform: 'linkedin' });
  assert.equal(run.status, 'success');
  const owners = await models.Post.findAll({ include: [{ model: models.Account, as: 'account' }] });
  assert.deepEqual(owners.map(post => post.account.username), ['alpha']);
  const beta = (await outcomes()).find(o => o.username === 'beta');
  assert.equal(beta.status, 'partial');
  assert.match(beta.error, /1 post\(s\) in Shares\.csv already belong to linkedin\/alpha; give each LinkedIn account its own "import_file"/);
  const betaImport = (await history.history({ username: 'beta' }))[0];
  assert.deepEqual([betaImport.rows, betaImport.new_posts, betaImport.conflicts], [1, 0, 1]);
});

test('a missing export keeps freshness; a broken export is a recorded error', async t => {
  const { models, orchestrator, outcomes, history } = await setup(t, [{ username: 'me', platform: 'linkedin', import_file: 'Shares-me.csv' }]);
  await orchestrator.run({ platform: 'linkedin' });
  const account = await models.Account.findOne({ where: { username: 'me' } });
  assert.equal(account.last_scraped_at, null, 'nothing was read, so the account must not look fresh');
  assert.equal(account.last_error, null);
  assert.match((await outcomes())[0].error, /No LinkedIn export Shares-me\.csv .* linkedin import <Shares\.csv> --account me/);

  await fs.writeFile(path.join(importsDir, 'Shares-me.csv'), 'Name,Email\r\nx,y\r\n');
  const run = await orchestrator.run({ platform: 'linkedin' });
  assert.equal(run.status, 'failed');
  await account.reload();
  assert.match(account.last_error, /no ShareLink\/ShareCommentary columns/);
  assert.equal((await history.history())[0].status, 'failed');
});
