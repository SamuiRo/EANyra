/**
 * The AI content loop on top of collected data:
 *
 *   signals (GitHub, manual ideas) ──► drafts (per persona/platform/account)
 *        ▲                                   │ review in the web UI
 *        └── marked used on publication ◄────┘ publish: Telegram (bot/MTProto)
 *                                              or manually (X, LinkedIn) + URL
 *
 * plus a content plan that compares each account's real posting rhythm with
 * the persona's `posting_frequency`.
 *
 * Shared by MCP tools and the web UI through a SQL executor (see sql.js).
 */

import { createHash, randomUUID } from 'node:crypto';

import { PLATFORM_CATALOG } from '../../platforms/catalog.js';
import { mergePersonaContext, isIsolated } from '../../config/personaConfig.js';
import { normalizeAccount } from '../../config/accountConfig.js';
import { parseJson } from './sql.js';
import { linkPublishedDrafts, platformIdFromUrl } from './draftLinks.js';
import { parseFrequency } from '../../shared/frequency.js';

export { parseFrequency };

export const DRAFT_STATUSES = ['draft', 'approved', 'published', 'discarded'];
/** Soft limits shown as warnings; Telegram's is enforced by its API. */
const LENGTH_LIMITS = { twitter: 280, linkedin: 3000, telegram: 4096 };
const HARD_LIMITS = { telegram: 4096, threads: 500 };
const COUNTS = ['likes', 'reposts', 'replies', 'views'];
const MAX_TEXT = 20_000;
const DAY = 864e5;

export class ContentService {
  /**
   * @param {import('./sql.js').Executor} db
   * @param {{
   *   loadAccounts: () => Promise<object[]>,        validated accounts.json entries
   *   loadPersonas: () => Promise<object[]>,        synced personas
   *   loadGlobalContext: () => Promise<object>,     voice/bio/platforms/projects
   *   now?: () => Date,
   * }} deps
   */
  constructor(db, { loadAccounts, loadPersonas, loadGlobalContext, now = () => new Date() }) {
    this.db = db;
    this.loadAccounts = loadAccounts;
    this.loadPersonas = loadPersonas;
    this.loadGlobalContext = loadGlobalContext;
    this.now = now;
  }

  // ── Drafts ────────────────────────────────────────────────────────────────

  async createDraft({ platform, account, persona, text, signal_ids = [], notes = null, created_by = 'ai' }) {
    const target = await this.#resolveTarget({ platform, account, persona });
    const body = assertText(text, target.platform);
    const signals = await this.#assertSignals(signal_ids);
    const ts = this.#ts();
    if (!['ai', 'user'].includes(created_by)) throw new Error('created_by must be ai or user.');
    const { lastID } = await this.db.run(
      `INSERT INTO drafts (persona, platform, account, text, status, signal_ids, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      [target.persona, target.platform, target.account, body, JSON.stringify(signals), notes, created_by, ts, ts],
    );
    return this.getDraft(lastID);
  }

  async getDraft(id) {
    await this.reconcileTelegram();
    const row = await this.db.get(`${DRAFT_SELECT} WHERE d.id = ?`, [assertId(id)]);
    if (!row) throw Object.assign(new Error(`Unknown draft ${id}.`), { status: 404 });
    const draft = formatDraft(row);
    if (draft.signal_ids.length) {
      draft.signals = await this.db.all(
        `SELECT id, source, signal_type, title, url, used_for_content FROM signals WHERE id IN (${draft.signal_ids.map(() => '?').join(', ')})`,
        draft.signal_ids,
      );
    }
    return draft;
  }

  /**
   * `scope` is the second tool-handler argument: `{ author: true }` from
   * the web UI. Without it (an agent) and without persona, drafts of isolated
   * personas are left out.
   */
  async listDrafts({ status, persona, platform, account, limit = 50 } = {}, scope) {
    await this.reconcileTelegram();
    const conds = [];
    const params = [];
    if (!persona) this.#excludeHidden(await this.#hidden(scope), conds, params);
    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      conds.push(`d.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (persona) { conds.push('d.persona = ?'); params.push(persona); }
    if (platform) { conds.push('d.platform = ?'); params.push(platform); }
    if (account) { conds.push('d.account = ?'); params.push(account); }
    const rows = await this.db.all(
      `${DRAFT_SELECT} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY CASE d.status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 WHEN 'published' THEN 2 ELSE 3 END, d.updated_at DESC
       LIMIT ?`,
      [...params, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(formatDraft);
  }

  async updateDraft(id, { text, notes, status, signal_ids }) {
    const draft = await this.getDraft(id);
    if (draft.status === 'published') throw new Error('A published draft cannot be changed.');
    if (status !== undefined && !['draft', 'approved', 'discarded'].includes(status)) {
      throw new Error('status can be set to draft, approved or discarded. Use draft_mark_published after publishing.');
    }
    if (text !== undefined && draft.telegram?.status && !['draft', 'failed'].includes(draft.telegram.status)) {
      throw new Error('This draft is already being sent to Telegram; its text can no longer change.');
    }
    const fields = [];
    const params = [];
    if (text !== undefined) { fields.push('text = ?'); params.push(assertText(text, draft.platform)); }
    if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
    if (status !== undefined) { fields.push('status = ?'); params.push(status); }
    if (signal_ids !== undefined) { fields.push('signal_ids = ?'); params.push(JSON.stringify(await this.#assertSignals(signal_ids))); }
    if (!fields.length) return draft;
    fields.push('updated_at = ?');
    params.push(this.#ts());
    await this.db.run(`UPDATE drafts SET ${fields.join(', ')} WHERE id = ?`, [...params, draft.id]);
    return this.getDraft(draft.id);
  }

  /**
   * Record a publication the author confirmed (manual X/LinkedIn posting, or a
   * Telegram post made outside EANyra). Marks the source signals as used.
   */
  async markPublished(id, { url = null } = {}) {
    const draft = await this.getDraft(id);
    if (draft.status === 'published') return draft;
    if (draft.status === 'discarded') throw new Error('A discarded draft cannot be marked published.');
    if (url !== null) assertUrl(url);
    const ts = this.#ts();
    await this.db.run(
      "UPDATE drafts SET status = 'published', published_url = ?, published_at = ?, updated_at = ? WHERE id = ?",
      [url, ts, ts, draft.id],
    );
    await this.#markSignalsUsed(draft.signal_ids, ts);
    return this.getDraft(draft.id);
  }

  /**
   * Numbers of a post on a platform without a collector (catalog
   * metrics: 'manual', e.g. Threads), entered by the author or the agent.
   * The post is stored like a collected one, so content_plan_get,
   * content_performance_get and posts_* count it. Recording the same URL
   * again updates its numbers. With draft_id the draft is marked published
   * with this URL (if it was not) and linked to the post.
   */
  async recordPostMetrics({ platform, account, persona, url, text = null, posted_at = null, draft_id = null, ...counts }) {
    if (PLATFORM_CATALOG[platform]?.metrics !== 'manual') {
      const manual = Object.values(PLATFORM_CATALOG).filter(p => p.metrics === 'manual').map(p => p.id).join(', ');
      throw new Error(`Numbers of ${platform} posts are collected automatically; manual entry is for: ${manual}.`);
    }
    if (!account) throw new Error('account is required.');
    const target = await this.#resolveTarget({ platform, account, persona });
    assertUrl(url);
    const platformId = platformIdFromUrl(platform, url);
    if (!platformId) throw new Error(`${url} is not a ${PLATFORM_CATALOG[platform].displayName} post URL.`);
    const values = {};
    for (const key of COUNTS) {
      const value = counts[key];
      if (value === undefined || value === null) continue;
      if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a whole number of at least 0.`);
      values[key] = value;
    }
    let postedAt = null;
    if (posted_at !== null) {
      postedAt = new Date(posted_at);
      if (Number.isNaN(postedAt.getTime())) throw new Error('posted_at must be a date, e.g. 2026-11-27T18:00:00Z.');
    }
    let draft = null;
    if (draft_id !== null) {
      draft = await this.getDraft(draft_id);
      if (draft.platform !== platform || (draft.account && draft.account !== target.account)) {
        throw new Error(`Draft ${draft.id} is for ${draft.platform}/${draft.account ?? '(no account)'}, not ${platform}/${target.account}.`);
      }
      if (draft.status !== 'published') draft = await this.markPublished(draft.id, { url });
    }
    if (text !== null) assertText(text, platform);
    const ts = this.#ts();

    let accountRow = await this.db.get('SELECT id FROM accounts WHERE platform = ? AND username = ?', [platform, target.account]);
    if (!accountRow) {
      await this.db.run(
        'INSERT INTO accounts (username, platform, is_active, is_archived, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?)',
        [target.account, platform, ts, ts]);
      accountRow = await this.db.get('SELECT id FROM accounts WHERE platform = ? AND username = ?', [platform, target.account]);
    }
    const existing = await this.db.get('SELECT id, account_id FROM posts WHERE platform = ? AND platform_id = ?', [platform, platformId]);
    if (existing && existing.account_id !== accountRow.id) throw new Error(`${url} is already recorded for another account.`);
    const body = text ?? draft?.text ?? null;
    if (existing) {
      const sets = Object.keys(values).map(key => `${key} = ?`);
      const params = Object.values(values);
      if (body !== null) { sets.push('text = ?'); params.push(body); }
      if (postedAt) { sets.push('posted_at = ?'); params.push(postedAt.toISOString()); }
      await this.db.run(`UPDATE posts SET ${[...sets, 'scraped_at = ?', 'updated_at = ?'].join(', ')} WHERE id = ?`, [...params, ts, ts, existing.id]);
    } else {
      await this.db.run(
        `INSERT INTO posts (platform, platform_id, account_id, text, posted_at, raw_url, likes, reposts, replies, views,
           is_repost, is_reply, scraped_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [platform, platformId, accountRow.id, body ?? '', (postedAt ?? new Date(draft?.published_at ?? ts)).toISOString(), url,
          values.likes ?? 0, values.reposts ?? 0, values.replies ?? 0, values.views ?? null, ts, ts, ts]);
    }
    await linkPublishedDrafts(this.db);
    const post = await this.db.get(
      `SELECT id, platform, platform_id, text, posted_at, raw_url AS url, likes, reposts, replies, views, scraped_at AS recorded_at
       FROM posts WHERE platform = ? AND platform_id = ?`, [platform, platformId]);
    const linked = await this.db.get('SELECT id, status FROM drafts WHERE post_id = ? ORDER BY id LIMIT 1', [post.id]);
    return { account: `${platform}/${target.account}`, post, draft: linked ?? null, updated: Boolean(existing) };
  }

  /**
   * Request id for publishing this draft's exact text to Telegram. Stable for
   * the same draft and text, so preparing twice never creates two posts.
   */
  async telegramRequestFor(id) {
    const draft = await this.getDraft(id);
    if (draft.platform !== 'telegram') throw new Error('Only Telegram drafts can be published from EANyra. Publish X and LinkedIn posts yourself, then call draft_mark_published.');
    if (!['draft', 'approved'].includes(draft.status)) throw new Error(`Draft ${draft.id} is ${draft.status}.`);
    if (!draft.account) throw new Error('Set the Telegram channel (account) on the draft first.');
    const owner = (await this.loadPersonas()).find(p => p.accounts.some(ref => ref.platform === 'telegram' && ref.username === draft.account));
    if (!owner) throw new Error(`telegram/${draft.account} belongs to no persona. Assign it to a persona («Акаунти») before publishing.`);
    if (draft.persona !== owner.slug) {
      throw new Error(`Draft ${draft.id} was written ${draft.persona ? `for persona "${draft.persona}"` : 'without a persona'}, but telegram/${draft.account} belongs to another persona. It cannot be published there.`);
    }
    const hash = createHash('sha256').update(draft.text).digest('hex').slice(0, 12);
    const requestId = `draft-${draft.id}-${hash}`;
    await this.db.run('UPDATE drafts SET telegram_request_id = ?, updated_at = ? WHERE id = ?', [requestId, this.#ts(), draft.id]);
    return { draft, request_id: requestId };
  }

  /** Drafts whose Telegram post was sent become published, with the post URL. */
  async reconcileTelegram() {
    const rows = await this.db.all(`
      SELECT d.id, d.signal_ids, o.receipt FROM drafts d
      JOIN telegram_outbox o ON o.request_id = d.telegram_request_id
      WHERE d.status IN ('draft', 'approved') AND o.status = 'sent'`);
    for (const row of rows) {
      const receipt = parseJson(row.receipt, {});
      const ts = receipt.sent_at ?? this.#ts();
      await this.db.run(
        "UPDATE drafts SET status = 'published', published_url = ?, published_at = ?, updated_at = ? WHERE id = ?",
        [receipt.url ?? null, ts, this.#ts(), row.id],
      );
      await this.#markSignalsUsed(parseJson(row.signal_ids, []), ts);
    }
    await linkPublishedDrafts(this.db);
  }

  // ── Performance feedback ──────────────────────────────────────────────────

  /**
   * How published drafts performed, relative to each account's own median
   * post (score = likes + 2·reposts + replies), plus which source signals
   * and which authorship (AI vs. author) led to above-median posts.
   */
  async performance({ persona, platform, days = 90 } = {}, scope) {
    await this.reconcileTelegram();
    const since = new Date(this.now().getTime() - days * DAY).toISOString();
    const conds = ["d.status = 'published'", 'd.published_at >= ?'];
    const params = [since];
    if (!persona) this.#excludeHidden(await this.#hidden(scope), conds, params);
    if (persona) { conds.push('d.persona = ?'); params.push(persona); }
    if (platform) { conds.push('d.platform = ?'); params.push(platform); }
    const drafts = await this.db.all(`${DRAFT_SELECT} WHERE ${conds.join(' AND ')} ORDER BY d.published_at DESC`, params);

    const medians = new Map();
    const medianFor = async accountId => {
      if (!medians.has(accountId)) {
        const rows = await this.db.all(`
          SELECT likes + 2 * reposts + replies AS score FROM posts
          WHERE account_id = ? AND is_repost = 0 AND is_reply = 0 AND posted_at >= ? ORDER BY score`,
        [accountId, since]);
        medians.set(accountId, rows.length ? median(rows.map(row => Number(row.score))) : null);
      }
      return medians.get(accountId);
    };

    const measured = [];
    const unmatched = [];
    for (const row of drafts) {
      const draft = formatDraft(row);
      if (!draft.post) {
        unmatched.push({ id: draft.id, platform: draft.platform, account: draft.account, published_url: draft.published_url });
        continue;
      }
      const base = await medianFor(row.post_account_id);
      measured.push({ ...draft, score: draft.post.score, account_median: base, vs_median: base ? round(draft.post.score / base) : null });
    }

    const signalStats = new Map();
    for (const draft of measured) {
      for (const id of draft.signal_ids) {
        const entry = signalStats.get(id) ?? { ratios: [], drafts: [] };
        if (draft.vs_median !== null) entry.ratios.push(draft.vs_median);
        entry.drafts.push(draft.id);
        signalStats.set(id, entry);
      }
    }
    const signalRows = signalStats.size
      ? await this.db.all(`SELECT id, source, signal_type, title FROM signals WHERE id IN (${[...signalStats.keys()].map(() => '?').join(', ')})`, [...signalStats.keys()])
      : [];
    const byType = {};
    for (const signal of signalRows) {
      const stats = signalStats.get(signal.id);
      const bucket = byType[`${signal.source}/${signal.signal_type}`] ??= { ratios: [], drafts: 0 };
      bucket.ratios.push(...stats.ratios);
      bucket.drafts += stats.drafts.length;
    }
    const summarize = list => {
      const ratios = list.filter(value => value !== null);
      return { drafts: list.length, measured: ratios.length, median_vs_account: ratios.length ? round(median(ratios)) : null };
    };

    return {
      window_days: days,
      published: drafts.length,
      measured: measured.length,
      by_author: {
        ai: summarize(measured.filter(d => d.created_by === 'ai').map(d => d.vs_median)),
        author: summarize(measured.filter(d => d.created_by === 'user').map(d => d.vs_median)),
      },
      by_signal_type: Object.fromEntries(Object.entries(byType).map(([type, entry]) => [type, {
        drafts: entry.drafts, median_vs_account: entry.ratios.length ? round(median(entry.ratios)) : null,
      }])),
      drafts: measured
        .sort((a, b) => (b.vs_median ?? -1) - (a.vs_median ?? -1))
        .map(({ id, persona: p, platform: pl, account, text, created_by, signal_ids, post, account_median, vs_median, notes }) => ({
          id, persona: p, platform: pl, account, created_by, signal_ids, notes,
          text: text.length > 280 ? `${text.slice(0, 280)}…` : text,
          likes: post.likes, reposts: post.reposts, replies: post.replies, views: post.views,
          score: post.score, account_median, vs_median, url: post.raw_url,
        })),
      not_yet_collected: unmatched,
      how_to_read: 'vs_median = draft score / median score of the same account\'s posts in the window ' +
        '(1.0 = typical, 2.0 = twice as engaging). not_yet_collected drafts have no collected post yet: run ' +
        'scraper_run for those accounts, or the URL could not be matched (LinkedIn activity links).',
    };
  }

  // ── Manual signals ────────────────────────────────────────────────────────

  async addSignal({ kind = 'idea', title, body = null, url = null, persona = null }) {
    const types = { idea: ['note', 'idea'], article: ['article', 'article'], note: ['note', 'draft'] };
    if (!types[kind]) throw new Error('kind must be idea, article or note.');
    if (typeof title !== 'string' || !title.trim() || title.length > 300) throw new Error('title must be 1-300 characters.');
    if (body !== null && (typeof body !== 'string' || body.length > MAX_TEXT)) throw new Error(`body must be at most ${MAX_TEXT} characters.`);
    if (url !== null) assertUrl(url);
    if (persona) await this.#assertPersona(persona);
    const [source, type] = types[kind];
    const ts = this.#ts();
    const sourceId = `manual:${randomUUID()}`;
    await this.db.run(
      `INSERT INTO signals (source, source_id, signal_type, title, body, url, occurred_at, metadata, scraped_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [source, sourceId, type, title.trim(), body, url, ts, JSON.stringify({ manual: true, ...(persona ? { persona } : {}) }), ts, ts, ts],
    );
    return this.db.get('SELECT id, source, signal_type, title, body, url, occurred_at, metadata FROM signals WHERE source_id = ?', [sourceId]);
  }

  // ── Content plan ──────────────────────────────────────────────────────────

  /**
   * Per persona and publishing account: target cadence, real cadence from
   * collected posts, what is due, waiting drafts and unused material.
   */
  async contentPlan({ persona: only } = {}, scope) {
    const [personas, global, accounts, configured] = await Promise.all([
      this.loadPersonas(), this.loadGlobalContext(),
      this.db.all('SELECT id, platform, username, last_scraped_at FROM accounts WHERE is_active = 1 AND is_archived = 0'),
      this.loadAccounts(),
    ]);
    if (only && !personas.some(p => p.slug === only)) throw new Error(`Unknown persona "${only}".`);
    const accountRow = new Map(accounts.map(row => [`${row.platform}/${row.username}`, row]));
    const owner = new Map();
    for (const persona of personas) for (const ref of persona.accounts) owner.set(`${ref.platform}/${ref.username}`, persona);

    const groups = new Map();
    for (const entry of configured) {
      if (entry.archive === true || entry.active === false) continue;
      if (PLATFORM_CATALOG[entry.platform]?.output !== 'posts') continue;
      const persona = owner.get(`${entry.platform}/${entry.username}`) ?? null;
      if (only && persona?.slug !== only) continue;
      if (!only && isIsolated(persona) && !scope?.author) continue;
      const key = persona?.slug ?? '';
      if (!groups.has(key)) groups.set(key, { persona, accounts: [] });
      groups.get(key).accounts.push(entry);
    }

    const now = this.now().getTime();
    const result = [];
    for (const { persona, accounts: entries } of groups.values()) {
      // Accounts without a persona have no platform rules (no cadence target).
      const context = persona ? mergePersonaContext(global, persona, personas) : { platforms: {} };
      const items = [];
      for (const entry of entries) {
        const row = accountRow.get(`${entry.platform}/${entry.username}`);
        const rules = context.platforms?.[entry.platform] ?? {};
        const frequency = parseFrequency(rules.posting_frequency ?? rules.frequency);
        const stats = row ? await this.db.get(`
          SELECT MAX(posted_at) AS last_post_at,
                 SUM(CASE WHEN posted_at >= ? THEN 1 ELSE 0 END) AS last_7_days,
                 SUM(CASE WHEN posted_at >= ? THEN 1 ELSE 0 END) AS last_30_days
          FROM posts WHERE account_id = ? AND is_repost = 0 AND is_reply = 0`,
        [new Date(now - 7 * DAY).toISOString(), new Date(now - 30 * DAY).toISOString(), row.id]) : null;
        const waiting = await this.db.get(
          "SELECT COUNT(*) AS n FROM drafts WHERE platform = ? AND account = ? AND status IN ('draft', 'approved')",
          [entry.platform, entry.username],
        );
        const lastPost = stats?.last_post_at ? new Date(stats.last_post_at).getTime() : null;
        const daysSince = lastPost === null ? null : Math.round((now - lastPost) / DAY * 10) / 10;
        const dataAge = row?.last_scraped_at ? (now - new Date(row.last_scraped_at).getTime()) / 36e5 : null;

        let status = 'no_target';
        if (frequency) {
          if (daysSince === null) status = 'due';
          else if (daysSince >= frequency.interval_days * 1.5) status = 'overdue';
          else if (daysSince >= frequency.interval_days) status = 'due';
          else status = 'on_track';
        }
        items.push({
          account: `${entry.platform}/${entry.username}`,
          platform: entry.platform,
          publishing: PLATFORM_CATALOG[entry.platform].publishing,
          target: frequency ? { text: frequency.text, per_week: frequency.per_week } : null,
          status,
          last_post_at: stats?.last_post_at ?? null,
          days_since_last_post: daysSince,
          next_due_at: frequency && lastPost !== null ? new Date(lastPost + frequency.interval_days * DAY).toISOString() : null,
          posts_last_7_days: Number(stats?.last_7_days ?? 0),
          posts_last_30_days: Number(stats?.last_30_days ?? 0),
          drafts_waiting: Number(waiting?.n ?? 0),
          ...(PLATFORM_CATALOG[entry.platform].metrics === 'manual'
            ? { data_warning: 'Posts are counted only once recorded: after publishing, enter each post with post_metrics_record (URL and numbers).' }
            : dataAge === null || dataAge > 36 ? { data_warning: 'Collected data is older than 36 hours or missing; recent posts may not be counted. Run scraper_run first.' } : {}),
        });
      }
      items.sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || (b.days_since_last_post ?? 1e9) - (a.days_since_last_post ?? 1e9));
      result.push({
        persona: persona ? { slug: persona.slug, name: persona.name } : null,
        unused_signals: await this.#unusedSignalCount(persona),
        accounts: items,
      });
    }
    result.sort((a, b) => Math.min(...a.accounts.map(i => URGENCY[i.status])) - Math.min(...b.accounts.map(i => URGENCY[i.status])));
    const due = result.flatMap(group => group.accounts.filter(item => ['overdue', 'due'].includes(item.status))
      .map(item => ({ persona: group.persona?.slug ?? null, ...item })));
    return {
      generated_at: this.now().toISOString(),
      due_now: due.map(({ persona, account, status, days_since_last_post, drafts_waiting }) =>
        ({ persona, account, status, days_since_last_post, drafts_waiting })),
      personas: result,
      next_step: due.length
        ? 'For each due account without waiting drafts: context_get with its persona, pick material from signals_get, write in that persona\'s voice and save with draft_create.'
        : 'Nothing is due. Optionally prepare drafts ahead from unused signals.',
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async #resolveTarget({ platform, account, persona }) {
    if (!PLATFORM_CATALOG[platform] || PLATFORM_CATALOG[platform].output !== 'posts') {
      throw new Error(`Drafts are for publishing platforms: ${Object.values(PLATFORM_CATALOG).filter(p => p.output === 'posts').map(p => p.id).join(', ')}.`);
    }
    let username = null;
    if (account) {
      username = normalizeAccount(String(account).replace(new RegExp(`^${platform}/`), ''), platform);
      const configured = (await this.loadAccounts()).some(entry => entry.platform === platform && entry.username === username && entry.archive !== true);
      if (!configured) throw new Error(`${platform}/${username} is not a configured account.`);
    }
    const personas = await this.loadPersonas();
    const owner = username ? personas.find(p => p.accounts.some(ref => ref.platform === platform && ref.username === username)) : null;
    if (persona) {
      await this.#assertPersona(persona, personas);
      if (owner && owner.slug !== persona) {
        throw new Error(`${platform}/${username} belongs to ${isIsolated(owner) ? 'another persona' : `persona "${owner.slug}"`}, not "${persona}".`);
      }
      if (username && !owner) {
        throw new Error(`${platform}/${username} belongs to no persona, so it cannot carry a draft of "${persona}". ` +
          'Assign the account to that persona first («Акаунти»), or omit persona.');
      }
    }
    return { platform, account: username, persona: owner?.slug ?? persona ?? null };
  }

  /**
   * Checks a raw Telegram post (telegram_post_prepare) before it is stored:
   * the channel must belong to `persona`, and the text must not be a draft
   * written for a different persona.
   */
  async assertTelegramPost({ persona, account, text }) {
    if (typeof persona !== 'string' || !persona) throw new Error('persona is required: the persona this text was written as.');
    const personas = await this.loadPersonas();
    await this.#assertPersona(persona, personas);
    const username = normalizeAccount(String(account ?? '').replace(/^telegram\//, ''), 'telegram');
    const owner = personas.find(p => p.accounts.some(ref => ref.platform === 'telegram' && ref.username === username));
    if (!owner) throw new Error(`telegram/${username} belongs to no persona. Assign it to a persona («Акаунти») before publishing.`);
    if (owner.slug !== persona) throw new Error(`telegram/${username} belongs to another persona, not "${persona}". It cannot carry this text.`);
    const foreign = await this.db.get(
      'SELECT id FROM drafts WHERE TRIM(text) = TRIM(?) AND persona IS NOT NULL AND persona != ? ORDER BY id LIMIT 1',
      [String(text ?? ''), persona],
    );
    if (foreign) throw new Error(`This text is draft ${foreign.id}, written for another persona. It cannot be published to telegram/${username}.`);
    return { persona, account: username };
  }

  async #hidden(scope) {
    if (scope?.author) return { slugs: [], accounts: [] };
    const isolated = (await this.loadPersonas()).filter(isIsolated);
    return {
      slugs: isolated.map(p => p.slug),
      accounts: isolated.flatMap(p => p.accounts.map(ref => `${ref.platform}/${ref.username}`)),
    };
  }

  #excludeHidden(hidden, conds, params) {
    if (hidden.slugs.length) {
      conds.push(`COALESCE(d.persona, '') NOT IN (${hidden.slugs.map(() => '?').join(', ')})`);
      params.push(...hidden.slugs);
    }
    if (hidden.accounts.length) {
      conds.push(`COALESCE(d.platform || '/' || d.account, '') NOT IN (${hidden.accounts.map(() => '?').join(', ')})`);
      params.push(...hidden.accounts);
    }
  }

  async #assertPersona(slug, personas) {
    if (!(personas ?? await this.loadPersonas()).some(p => p.slug === slug)) {
      throw new Error(`Unknown persona "${slug}". Call personas_list.`);
    }
  }

  async #assertSignals(ids) {
    if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(id) || id < 1)) throw new Error('signal_ids must be an array of signal ids.');
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const rows = await this.db.all(`SELECT id FROM signals WHERE id IN (${unique.map(() => '?').join(', ')})`, unique);
    const missing = unique.filter(id => !rows.some(row => row.id === id));
    if (missing.length) throw new Error(`Unknown signal id(s): ${missing.join(', ')}.`);
    return unique;
  }

  async #markSignalsUsed(ids, ts) {
    if (!ids?.length) return;
    await this.db.run(
      `UPDATE signals SET used_for_content = ? WHERE used_for_content IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
      [ts, ...ids],
    );
  }

  async #unusedSignalCount(persona) {
    if (!persona) {
      return Number((await this.db.get('SELECT COUNT(*) AS n FROM signals WHERE used_for_content IS NULL'))?.n ?? 0);
    }
    const refs = persona.accounts;
    const accountCond = refs.map(() => '(a.platform = ? AND a.username = ?)').join(' OR ');
    const row = await this.db.get(`
      SELECT COUNT(*) AS n FROM signals s LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.used_for_content IS NULL AND ((${accountCond}) OR (CASE WHEN json_valid(s.metadata) THEN json_extract(s.metadata, '$.persona') END) = ?)`,
    [...refs.flatMap(ref => [ref.platform, ref.username]), persona.slug]);
    return Number(row?.n ?? 0);
  }

  #ts() {
    return this.now().toISOString();
  }
}

const URGENCY = { overdue: 0, due: 1, on_track: 2, no_target: 3 };

const DRAFT_SELECT = `
  SELECT d.*, o.status AS telegram_status, o.error AS telegram_error, o.content_hash AS telegram_content_hash,
         p.likes AS post_likes, p.reposts AS post_reposts, p.replies AS post_replies, p.views AS post_views,
         p.posted_at AS post_posted_at, p.raw_url AS post_raw_url, p.account_id AS post_account_id
  FROM drafts d
  LEFT JOIN telegram_outbox o ON o.request_id = d.telegram_request_id
  LEFT JOIN posts p ON p.id = d.post_id`;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = value => Math.round(value * 100) / 100;

function formatDraft(row) {
  const limit = LENGTH_LIMITS[row.platform];
  const length = [...row.text].length;
  return {
    id: row.id,
    persona: row.persona,
    platform: row.platform,
    account: row.account,
    text: row.text,
    length,
    ...(limit && length > limit ? { warning: `Longer than ${limit} characters, the usual ${row.platform} limit.` } : {}),
    status: row.status,
    signal_ids: parseJson(row.signal_ids, []),
    notes: row.notes,
    created_by: row.created_by,
    publishing: PLATFORM_CATALOG[row.platform]?.publishing ?? null,
    ...(row.telegram_request_id ? {
      telegram: {
        request_id: row.telegram_request_id, status: row.telegram_status ?? null,
        content_hash: row.telegram_content_hash ?? null, error: row.telegram_error ?? null,
      },
    } : {}),
    published_url: row.published_url,
    published_at: row.published_at,
    ...(row.post_id ? {
      post: {
        id: row.post_id, likes: row.post_likes ?? 0, reposts: row.post_reposts ?? 0, replies: row.post_replies ?? 0,
        views: row.post_views ?? null, posted_at: row.post_posted_at, raw_url: row.post_raw_url,
        score: (row.post_likes ?? 0) + 2 * (row.post_reposts ?? 0) + (row.post_replies ?? 0),
      },
    } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function assertText(text, platform) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text cannot be empty.');
  const max = HARD_LIMITS[platform] ?? MAX_TEXT;
  if (text.length > max) throw new Error(`text is longer than ${max} characters allowed for ${platform}.`);
  return text;
}

function assertId(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value < 1) throw new Error('id must be a positive integer.');
  return value;
}

function assertUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('url must be an absolute http(s) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('url must be an absolute http(s) URL.');
}
