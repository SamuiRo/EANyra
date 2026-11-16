/**
 * Collection adapters, one per platform in catalog.js.
 *
 * A collector only fetches and normalizes. The orchestrator owns sessions,
 * pacing, persistence (by the catalog's `output`), run bookkeeping and errors.
 *
 *   collect({ account, entry, session, runtime, repos }) →
 *     { records: RawPost[]|RawSignal[], scrapedAt?: Date, warning?: string,
 *       keepWatermark?: boolean, onSaved?: (saved: number) => Promise<void> }
 *   warning marks a successful but incomplete collection (shown per run);
 *   keepWatermark leaves last_scraped_at unchanged (nothing was read);
 *   onSaved runs after persistence with the number of new records.
 *
 * runtime: { credentials, twitterSession(name), telegramScraper(name) }
 * repos:   { postRepo, signalRepo, stateRepo, linkedinImports }
 */

import { LINKEDIN, SCRAPER, TELEGRAM } from '../config/app.config.js';
import { print } from '../shared/utils.js';
import { PLATFORM_IDS } from './catalog.js';
import { createScraper as createTwitterScraper } from './twitter/index.js';
import { createScraper as createGithubScraper } from './github/index.js';
import { createScraper as createLinkedinImporter } from './linkedin/index.js';

export const COLLECTORS = Object.freeze({
  twitter: {
    async collect({ account, session, runtime, repos }) {
      const isInitial = !account.last_scraped_at ||
        await repos.postRepo.oldestPostDate(account.id, 'twitter') === null;
      const target = isInitial ? SCRAPER.initialPostsPerAccount : SCRAPER.postsPerAccount;
      print(`  → ${isInitial ? 'INITIAL harvest' : 'daily top-up'} (target: ${target} posts)`, 'system');

      const browserSession = await runtime.twitterSession(session);
      const page = await browserSession.newPage();
      try {
        return { records: await createTwitterScraper(page, target).scrapeAccount(account.username) };
      } finally {
        await page.close();
      }
    },
  },

  github: {
    async collect({ account, session, runtime, repos }) {
      const token = runtime.credentials.githubToken(session);
      if (!token) {
        throw Object.assign(new Error(
          `No GitHub token for session "${session}". Run \`npm run nyra -- secrets set github ${session}\`.`,
        ), { code: 'GITHUB_TOKEN_MISSING' });
      }
      const prefix = `${account.username}/`;
      // Persisted baseline wins: it also covers READMEs that never changed yet.
      const readmeShas = {
        ...await repos.signalRepo.getGithubReadmeShas(account.username),
        ...(repos.stateRepo ? await repos.stateRepo.getAll('github_readme', prefix) : {}),
      };
      const scraper = createGithubScraper(token, readmeShas);
      const records = await scraper.scrapeAccount(account.username);
      await repos.stateRepo?.setMany('github_readme',
        Object.entries(scraper.readmeShas).filter(([key, sha]) => key.startsWith(prefix) && sha));
      return { records };
    },
  },

  linkedin: {
    async collect({ account, entry, repos }) {
      const importer = createLinkedinImporter(LINKEDIN.importsDir, {
        sharesFile: entry?.import_file ?? LINKEDIN.sharesFile,
      });
      const history = repos.linkedinImports;
      let result;
      try {
        result = await importer.read(account.username);
      } catch (error) {
        const failed = importer.lastFile;
        if (history && failed?.exists) {
          await history.record({ accountId: account.id, fileName: failed.name, sha256: failed.sha256, bytes: failed.bytes, status: 'failed', error: error.message });
        }
        throw error;
      }
      const { file, posts } = result;

      if (!file.exists) {
        return {
          records: [], keepWatermark: true,
          warning: `No LinkedIn export ${file.name} in ${LINKEDIN.importsDir}. Download it (LinkedIn → Settings → Data privacy → ` +
            `Get a copy of your data → Posts) and run \`npm run nyra -- linkedin import <Shares.csv> --account ${account.username}\`.`,
        };
      }

      // The same export again: nothing new to read.
      const last = await history?.lastImported(account.id);
      if (last && last.sha256 === file.sha256) {
        print(`  → ${file.name} unchanged since ${new Date(last.imported_at).toISOString().slice(0, 10)}; skipped.`, 'system');
        return { records: [] };
      }

      // A post can belong to one account only: rows already owned by another
      // account mean two accounts point at the same export file.
      const owners = history ? await history.foreignOwners(account.id, posts.map(post => post.platform_id).filter(Boolean)) : new Map();
      const records = posts.filter(post => !owners.has(String(post.platform_id)));
      const conflicts = posts.length - records.length;
      const newestPostAt = records.reduce((newest, post) => (post.posted_at && (!newest || post.posted_at > newest) ? post.posted_at : newest), null);

      return {
        records,
        ...(conflicts ? {
          warning: `${conflicts} post(s) in ${file.name} already belong to ${[...new Set(owners.values())].map(u => `linkedin/${u}`).join(', ')}; ` +
            'give each LinkedIn account its own "import_file" in accounts.json.',
        } : {}),
        onSaved: async saved => history?.record({
          accountId: account.id, fileName: file.name, sha256: file.sha256, bytes: file.bytes,
          status: 'imported', rows: posts.length, newPosts: saved, conflicts, newestPostAt,
        }),
      };
    },
  },

  telegram: {
    async collect({ account, session, runtime, repos }) {
      const startedAt = new Date();
      const since = account.last_scraped_at ?? await repos.postRepo.newestPostDate(account.id, 'telegram');
      print(
        `  -> ${since === null ? `INITIAL harvest (target: ${TELEGRAM.initialPostsPerAccount} posts)` : 'daily top-up'} (polling mode)`,
        'system',
      );
      const scraper = await runtime.telegramScraper(session);
      const stored = await repos.stateRepo?.get('telegram_backfill', account.username);
      const result = await scraper.collect(account.username, {
        since,
        initialLimit: TELEGRAM.initialPostsPerAccount,
        backfill: stored ? JSON.parse(stored) : null,
      });
      // An unread older interval is kept as a checkpoint instead of being
      // skipped when the watermark moves forward.
      if (result.backfill) await repos.stateRepo?.setMany('telegram_backfill', [[account.username, JSON.stringify(result.backfill)]]);
      else if (stored) await repos.stateRepo?.delete('telegram_backfill', account.username);
      const records = result.posts;
      // last_scraped_at is the polling watermark for Telegram.
      return {
        records,
        scrapedAt: telegramBaselineTimestamp(records, startedAt, since),
        ...(result.backfill ? {
          warning: `Incomplete: older messages before #${result.backfill.before_id} (since ${result.backfill.since}) ` +
            'exceed TELEGRAM_MAX_PAGES_PER_ACCOUNT and will be read on the next runs.',
        } : {}),
      };
    },
  },
});

/** Throws at import time if the catalog and the adapters drift apart. */
for (const id of PLATFORM_IDS) {
  if (!COLLECTORS[id]) throw new Error(`Platform "${id}" is in the catalog but has no collector.`);
}

export function telegramBaselineTimestamp(rawPosts, fallback, previousBoundary = null) {
  const latestPostAt = rawPosts.reduce((latest, post) => {
    if (!(post.posted_at instanceof Date)) return latest;
    return latest === null || post.posted_at > latest ? post.posted_at : latest;
  }, null);

  if (previousBoundary) {
    const previous = previousBoundary instanceof Date ? previousBoundary : new Date(previousBoundary);
    if (!Number.isNaN(previous.getTime())) {
      return latestPostAt && latestPostAt > previous ? latestPostAt : fallback;
    }
  }
  return latestPostAt ?? fallback;
}
