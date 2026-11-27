import * as mcpDb from '../db.js';
import { mcpExecutor } from '../../services/sql.js';
import { ChannelStatsRepository, utcDay } from '../../teapot/repositories/ChannelStatsRepository.js';
import { personaIndex, personaProperty, personaScopeCondition } from '../personas.js';

/**
 * src/core/mcp/tools/audience.js
 *
 * telegram_channel_stats — subscriber history of Telegram channels and the
 * joins counted on each named invite link, from the daily snapshots that
 * every Telegram collection (scraper_run platform telegram) stores.
 */

const MS_PER_DAY = 86_400_000;

export function buildAudienceTools({ db = mcpExecutor(mcpDb) } = {}) {
  const stats = new ChannelStatsRepository(db);
  return [{
    name: 'telegram_channel_stats',
    description:
      'Audience numbers of Telegram channels: subscribers today and per day, and the joins counted on each ' +
      'named invite link (title, cumulative joins, joins in the window, pending join requests). Snapshots are ' +
      'stored once per day by Telegram collection (scraper_run with platform telegram or the persona); for fresh ' +
      'numbers run it first. Invite links are only readable for channels the collecting session administers. ' +
      'Without persona, channels of personas that must be named are not returned.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: personaProperty,
        account: { type: 'string', minLength: 1, description: 'Channel username, with or without "telegram/".' },
        link_title: { type: 'string', minLength: 1, description: 'Only invite links with this title (case-insensitive).' },
        days: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'History window in days.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler({ persona, account, link_title, days = 30 } = {}, scope) {
      const conds = ["a.platform = 'telegram'"];
      const params = [];
      if (account) {
        conds.push('LOWER(a.username) = LOWER(?)');
        params.push(account.replace(/^telegram\//i, '').replace(/^@/, ''));
      }
      const filter = await personaScopeCondition({ persona, scope });
      if (filter) {
        conds.push(filter.sql);
        params.push(...filter.params);
      }
      const accounts = await db.all(
        `SELECT a.id, a.username FROM accounts a WHERE ${conds.join(' AND ')} ORDER BY a.username`, params);
      const personas = await personaIndex();
      const fromDay = utcDay(new Date(Date.now() - (days - 1) * MS_PER_DAY));
      const wanted = link_title?.trim().toLowerCase();

      const channels = [];
      for (const row of accounts) {
        const latest = await stats.latestSubscribers(row.id);
        const history = await stats.subscriberHistory(row.id, fromDay);
        const inviteRows = await stats.inviteHistory(row.id, fromDay);
        const links = (await stats.latestInvites(row.id))
          .filter(invite => !wanted || (invite.title ?? '').toLowerCase() === wanted)
          .map(invite => describeInvite(invite, inviteRows.filter(entry => entry.link === invite.link), fromDay));
        const first = history.find(entry => entry.subscribers !== null);
        channels.push({
          account: `telegram/${row.username}`,
          persona: personas.get(`telegram/${row.username}`) ?? personas.get(`telegram/${row.username.toLowerCase()}`) ?? null,
          subscribers: latest?.subscribers ?? null,
          as_of: latest?.day ?? null,
          subscribers_change: first && latest?.subscribers != null && latest.day >= fromDay
            ? latest.subscribers - first.subscribers : null,
          history,
          invite_links: links,
          invite_joins_total: links.reduce((sum, link) => sum + link.joins, 0),
          ...(latest ? {} : { note: 'No snapshot yet: run scraper_run with platform telegram.' }),
        });
      }
      return { days, from_day: fromDay, count: channels.length, channels };
    },
  }];
}

/** Joins are cumulative per link; the window delta starts at 0 for links created inside it. */
function describeInvite(invite, rows, fromDay) {
  const createdInWindow = invite.created_at && utcDay(invite.created_at) >= fromDay;
  const baseline = createdInWindow ? 0 : rows[0]?.joins ?? null;
  return {
    title: invite.title ?? null,
    link: invite.link,
    joins: invite.joins,
    joins_in_window: baseline === null ? null : invite.joins - baseline,
    requested: invite.requested,
    revoked: Boolean(invite.revoked),
    created_at: invite.created_at ?? null,
    last_seen: invite.day,
    history: rows.map(entry => ({ day: entry.day, joins: entry.joins })),
  };
}
