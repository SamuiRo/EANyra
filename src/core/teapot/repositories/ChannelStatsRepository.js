/**
 * Daily audience snapshots of Telegram channels (tables channel_stats and
 * invite_link_stats). One row per channel (and invite link) per UTC day:
 * collecting twice on the same day replaces that day's numbers, so the
 * history has one value per day.
 *
 * Written against the shared SQL executor (services/sql.js), so the
 * orchestrator (Sequelize) and MCP tools (sqlite3) use the same code.
 */

export class ChannelStatsRepository {
  /** @param {{ all: Function, get: Function, run: Function }} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {number} accountId
   * @param {{ subscribers: number|null, invites: object[]|null }} stats
   * @param {Date} [at]
   */
  async saveSnapshot(accountId, { subscribers, invites }, at = new Date()) {
    const day = utcDay(at);
    const capturedAt = at.toISOString();
    await this.db.run(
      `INSERT INTO channel_stats (account_id, day, subscribers, captured_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, day) DO UPDATE SET subscribers = excluded.subscribers, captured_at = excluded.captured_at`,
      [accountId, day, subscribers ?? null, capturedAt],
    );
    for (const invite of invites ?? []) {
      await this.db.run(
        `INSERT INTO invite_link_stats (account_id, day, link, title, joins, requested, revoked, created_at, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, day, link) DO UPDATE SET title = excluded.title, joins = excluded.joins,
           requested = excluded.requested, revoked = excluded.revoked, captured_at = excluded.captured_at`,
        [accountId, day, invite.link, invite.title ?? null, invite.joins ?? 0, invite.requested ?? 0,
          invite.revoked ? 1 : 0, invite.created_at ? new Date(invite.created_at).toISOString() : null, capturedAt],
      );
    }
    return { day, invites: invites?.length ?? 0 };
  }

  /** Daily subscriber counts since `fromDay` (inclusive), oldest first. */
  subscriberHistory(accountId, fromDay = '0000-00-00') {
    return this.db.all(
      'SELECT day, subscribers FROM channel_stats WHERE account_id = ? AND day >= ? ORDER BY day',
      [accountId, fromDay],
    );
  }

  /** Daily rows of every invite link since `fromDay`, oldest first. */
  inviteHistory(accountId, fromDay = '0000-00-00') {
    return this.db.all(
      `SELECT day, link, title, joins, requested, revoked, created_at FROM invite_link_stats
       WHERE account_id = ? AND day >= ? ORDER BY link, day`,
      [accountId, fromDay],
    );
  }

  /** Latest snapshot of every link ever seen (also links missing from the last run). */
  latestInvites(accountId) {
    return this.db.all(
      `SELECT s.day, s.link, s.title, s.joins, s.requested, s.revoked, s.created_at FROM invite_link_stats s
       WHERE s.account_id = ? AND s.day = (SELECT MAX(day) FROM invite_link_stats WHERE account_id = s.account_id AND link = s.link)
       ORDER BY s.joins DESC, s.link`,
      [accountId],
    );
  }

  latestSubscribers(accountId) {
    return this.db.get(
      'SELECT day, subscribers, captured_at FROM channel_stats WHERE account_id = ? ORDER BY day DESC LIMIT 1',
      [accountId],
    );
  }
}

export function utcDay(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}
