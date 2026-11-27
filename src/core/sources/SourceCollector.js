/**
 * Reads every persona's `sources:` and stores each new link as a signal of
 * that persona:
 *
 *   source       'finding'
 *   source_id    '<persona>:<hash of the canonical URL>'  → one signal per link and persona,
 *                whichever source found it and however often it is found again
 *   signal_type  the source type (github_trending, github_topic, reddit, rss)
 *   account_id   NULL; metadata.persona binds it (see mcp/personas.js), so the
 *                persona filter and isolation of signals_get apply unchanged
 *
 * Found text is third-party content: it is stored as plain data, trimmed,
 * marked metadata.untrusted, and must never be followed as instructions.
 * One failing source never stops the others; each source's last outcome is
 * kept in source_state ('finding_source', '<persona>:<source key>').
 */

import { createHash } from 'node:crypto';

import { PKG } from '../../config/app.config.js';
import { READERS } from '../../platforms/sources/fetchers.js';

export const FINDING_SOURCE = 'finding';
const STATE = 'finding_source';
const MAX_TITLE = 300;
const MAX_BODY = 1000;
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si)$/i;
// Control, zero-width and bidi-override characters: invisible text that can hide or reorder content.
const INVISIBLE = new RegExp(`[${[[0x00, 0x08], [0x0B, 0x0C], [0x0E, 0x1F], [0x7F, 0x7F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2066, 0x2069]]
  .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`, 'g');

export class SourceCollector {
  /**
   * @param {{ all: Function, get: Function, run: Function }} db shared SQL executor
   * @param {{ fetchImpl?: typeof fetch, githubToken?: string, now?: () => Date,
   *           readers?: typeof READERS, pause?: (ms: number) => Promise<void> }} [deps]
   */
  constructor(db, deps = {}) {
    this.db = db;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.githubToken = deps.githubToken ?? '';
    this.now = deps.now ?? (() => new Date());
    this.readers = deps.readers ?? READERS;
    this.pause = deps.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /**
   * @param {object[]} personas synced personas (with `sources`)
   * @returns {Promise<{ found: number, saved: number, failed: number,
   *   personas: Array<{ persona: string, sources: object[] }> }>}
   */
  async collect(personas) {
    const summary = { found: 0, saved: 0, failed: 0, personas: [] };
    const lastHit = new Map();   // host → time of the last request (polite pacing)
    for (const persona of personas) {
      const results = [];
      for (const source of persona.sources ?? []) {
        const result = await this.#collectSource(persona.slug, source, lastHit);
        summary.found += result.found;
        summary.saved += result.saved;
        if (result.error) summary.failed += 1;
        results.push(result);
      }
      if (results.length) summary.personas.push({ persona: persona.slug, sources: results });
    }
    return summary;
  }

  /** Last outcome of every source of a persona, keyed by source key. */
  async status(slug) {
    const rows = await this.db.all('SELECT key, value FROM source_state WHERE source = ? AND substr(key, 1, ?) = ?',
      [STATE, slug.length + 1, `${slug}:`]);
    return Object.fromEntries(rows.map(row => [row.key.slice(slug.length + 1), safeJson(row.value)]));
  }

  async #collectSource(slug, source, lastHit) {
    const at = this.now();
    const result = { key: source.key, type: source.type, name: source.name ?? null, found: 0, saved: 0 };
    try {
      await this.#politePause(source, lastHit);
      const items = await this.readers[source.type](source, {
        fetchImpl: this.fetchImpl, now: at, githubToken: this.githubToken,
        userAgent: `${PKG.name}/${PKG.version} (source reader)`,
      });
      result.found = items.length;
      for (const item of items) {
        if (await this.#save(slug, source, item, at)) result.saved += 1;
      }
    } catch (error) {
      result.error = error.message;
    }
    await this.#recordState(slug, source, { ...result, last_run_at: at.toISOString() });
    return result;
  }

  async #save(slug, source, item, at) {
    const url = canonicalUrl(item.url);
    if (!url) return false;
    const identity = url.replace(/^http:/, 'https:');
    const sourceId = `${slug}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    if (await this.db.get('SELECT id FROM signals WHERE source = ? AND source_id = ?', [FINDING_SOURCE, sourceId])) return false;
    const title = clean(item.title, MAX_TITLE) || url;
    const body = clean(item.body, MAX_BODY) || null;
    const metadata = {
      persona: slug, untrusted: true, origin: source.key, source_name: source.name ?? null,
      ...(item.metadata ?? {}),
    };
    const occurred = item.occurred_at instanceof Date && !Number.isNaN(item.occurred_at.getTime()) ? item.occurred_at : at;
    const ts = at.toISOString();
    await this.db.run(
      `INSERT OR IGNORE INTO signals (source, source_id, signal_type, account_id, title, body, url, occurred_at, metadata, scraped_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [FINDING_SOURCE, sourceId, source.type, title, body, url, occurred.toISOString(), JSON.stringify(metadata), ts, ts, ts],
    );
    return true;
  }

  async #recordState(slug, source, value) {
    await this.db.run(
      `INSERT INTO source_state (source, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [STATE, `${slug}:${source.key}`, JSON.stringify(value), value.last_run_at],
    );
  }

  /** At most one request per second to the same host (Reddit and GitHub limit anonymous clients). */
  async #politePause(source, lastHit) {
    const host = source.type === 'rss' ? new URL(source.url).host : source.type === 'reddit' ? 'reddit' : 'github';
    const previous = lastHit.get(host);
    const wait = previous ? 1_000 - (Date.now() - previous) : 0;
    if (wait > 0) await this.pause(wait);
    lastHit.set(host, Date.now());
  }
}

/**
 * The form a link is stored in: http(s) only, lower-case host without "www.",
 * no fragment, no tracking parameters, sorted query, no trailing slash.
 * Deduplication also treats http and https as the same link.
 * @returns {string|null}
 */
export function canonicalUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  // "https://host/" and "https://host/?q" lose the lone slash too.
  const result = url.toString().replace(/^(https?:\/\/[^/?#]+)\/(?=\?|$)/, '$1');
  return result.length <= 2000 ? result : null;
}

/** Plain single-line-safe text: control characters removed, length capped. */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(INVISIBLE, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
