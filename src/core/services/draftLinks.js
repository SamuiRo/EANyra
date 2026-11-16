/**
 * Link published drafts to the posts collected later, so engagement of each
 * draft (and of the signals it used) becomes visible to the AI.
 *
 * The published URL is reduced to the same platform_id the collectors store:
 *   twitter   https://x.com/<user>/status/<id>          → <id>
 *   telegram  https://t.me/<channel>/<id>                → <channel>:<id>
 *             https://t.me/c/<internal>/<id>             → -100<internal>:<id>
 *   linkedin  …urn:li:share:<id> / urn:li:ugcPost:<id>   → <id>
 */

/** @returns {string|null} */
export function platformIdFromUrl(platform, url) {
  if (typeof url !== 'string' || !url) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url;
  }
  if (platform === 'twitter') {
    return decoded.match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i)?.[1] ?? null;
  }
  if (platform === 'telegram') {
    const internal = decoded.match(/t\.me\/c\/(\d+)\/(\d+)/i);
    if (internal) return `-100${internal[1]}:${internal[2]}`;
    const open = decoded.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]{4,})\/(\d+)/i);
    return open ? `${open[1].toLowerCase()}:${open[2]}` : null;
  }
  if (platform === 'linkedin') {
    // Activity URNs differ from the share ids in LinkedIn exports; only
    // share/ugcPost ids can be matched.
    return decoded.match(/urn:li:(?:share|ugcPost):(\d+)/)?.[1] ?? null;
  }
  return null;
}

/**
 * @param {import('./sql.js').Executor} db
 * @returns {Promise<number>} drafts newly linked
 */
export async function linkPublishedDrafts(db) {
  const drafts = await db.all(`
    SELECT id, platform, published_url FROM drafts
    WHERE status = 'published' AND post_id IS NULL AND published_url IS NOT NULL`);
  let linked = 0;
  for (const draft of drafts) {
    const platformId = platformIdFromUrl(draft.platform, draft.published_url);
    if (!platformId) continue;
    const post = await db.get('SELECT id FROM posts WHERE platform = ? AND platform_id = ?', [draft.platform, platformId]);
    if (!post) continue;
    await db.run('UPDATE drafts SET post_id = ? WHERE id = ? AND post_id IS NULL', [post.id, draft.id]);
    linked++;
  }
  return linked;
}
