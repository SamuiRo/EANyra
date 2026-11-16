/**
 * Sends one digest per check: new problems, problems still open after
 * `repeat_hours`, and problems that disappeared (when `notify_resolved`).
 * Nothing is sent when nothing changed. State lives in source_state
 * (source "notify"), so restarts do not re-send old alerts.
 *
 * If every channel fails, the state is left unchanged and the next check
 * tries again; if at least one channel delivers, the state advances.
 */

import { parseJson } from '../services/sql.js';

const SOURCE = 'notify';
const HOUR = 36e5;

export class Notifier {
  /**
   * @param {import('../services/sql.js').Executor} db
   * @param {{ channels: { name: string, send: (text: string) => Promise<void> }[], rules: object, now?: () => Date }} opts
   */
  constructor(db, { channels, rules, now = () => new Date() }) {
    this.db = db;
    this.channels = channels;
    this.rules = rules;
    this.now = now;
  }

  /** @returns {Promise<{ sent: boolean, delivered: string[], failed: string[], digest: object }>} */
  async notify(problems) {
    const now = this.now();
    const stored = new Map((await this.db.all('SELECT key, value FROM source_state WHERE source = ?', [SOURCE]))
      .map(row => [row.key, parseJson(row.value, {})]));
    const current = new Map(problems.map(problem => [problem.key, problem]));

    const fresh = problems.filter(problem => !stored.has(problem.key));
    const repeat = problems.filter(problem => {
      const state = stored.get(problem.key);
      return state && now.getTime() - new Date(state.last_sent).getTime() >= this.rules.repeat_hours * HOUR;
    });
    const resolved = [...stored].filter(([key]) => !current.has(key)).map(([key, state]) => ({ key, text: state.text }));

    const digest = { fresh, repeat, resolved: this.rules.notify_resolved ? resolved : [] };
    const text = formatDigest(digest);
    const result = { sent: false, delivered: [], failed: [], digest };

    if (text && this.channels.length) {
      for (const channel of this.channels) {
        try {
          await channel.send(text);
          result.delivered.push(channel.name);
        } catch (error) {
          result.failed.push(`${channel.name}: ${error.message}`);
        }
      }
      // Keep the state so the next check retries when nothing got through.
      if (!result.delivered.length) return result;
      result.sent = true;
    } else if (text) {
      return result; // nowhere to send: keep watching without recording
    }

    const ts = now.toISOString();
    for (const problem of [...fresh, ...repeat]) {
      const since = stored.get(problem.key)?.since ?? ts;
      await this.#save(problem.key, { since, last_sent: ts, text: problem.text });
    }
    for (const { key } of resolved) {
      await this.db.run('DELETE FROM source_state WHERE source = ? AND key = ?', [SOURCE, key]);
    }
    return result;
  }

  async #save(key, value) {
    await this.db.run(
      `INSERT INTO source_state (source, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [SOURCE, key, JSON.stringify(value), this.now().toISOString()],
    );
  }
}

export function formatDigest({ fresh, repeat, resolved }) {
  if (!fresh.length && !repeat.length && !resolved.length) return '';
  const lines = ['EANyra'];
  if (fresh.length) lines.push('', `Нові проблеми (${fresh.length}):`, ...fresh.map(p => `• ${p.text}`));
  if (repeat.length) lines.push('', `Досі не вирішено (${repeat.length}):`, ...repeat.map(p => `• ${p.text}`));
  if (resolved.length) lines.push('', `✅ Вирішено (${resolved.length}):`, ...resolved.map(p => `• ${p.text}`));
  return lines.join('\n');
}
