/**
 * Readers for persona sources (config/sourceConfig.js). Each returns found
 * items; SourceCollector turns them into signals and removes duplicates.
 *
 *   read(source, { fetchImpl, now, githubToken, userAgent }) →
 *     Array<{ title, url, body?, occurred_at?, metadata? }>
 *
 * Only official public endpoints are used: the GitHub REST search API (no
 * HTML scraping of github.com/trending), Reddit's public JSON listings and
 * the feed URL itself. Every item is untrusted third-party content.
 */

import { parseFeed } from './feedParser.js';

const TIMEOUT_MS = 15_000;
const MS_PER_DAY = 86_400_000;

export const READERS = Object.freeze({
  github_trending: (source, ctx) => {
    const days = source.period === 'weekly' ? 7 : 1;
    const query = [`created:>=${isoDay(ctx.now, days)}`, `stars:>=${source.min_stars}`,
      ...(source.language ? [`language:"${source.language}"`] : [])].join(' ');
    return githubSearch(query, source, ctx);
  },

  github_topic: (source, ctx) => githubSearch(
    `topic:${source.topic} created:>=${isoDay(ctx.now, source.window_days)} stars:>=${source.min_stars}`, source, ctx),

  async reddit(source, ctx) {
    const url = new URL(`https://www.reddit.com/r/${encodeURIComponent(source.subreddit)}/${source.sort}.json`);
    url.searchParams.set('limit', String(Math.min(100, source.limit * 2)));
    url.searchParams.set('raw_json', '1');
    if (source.period) url.searchParams.set('t', source.period);
    const body = await getJson(url, ctx);
    const posts = (body?.data?.children ?? []).map(child => child?.data).filter(Boolean);
    return posts
      .filter(post => !post.stickied && (source.include_nsfw || !post.over_18) && Number(post.score ?? 0) >= source.min_score)
      .slice(0, source.limit)
      .map(post => {
        const permalink = post.permalink ? `https://www.reddit.com${post.permalink}` : null;
        const external = post.url && !post.is_self && !/^https?:\/\/(www\.|old\.)?reddit\.com\//i.test(post.url) ? post.url : null;
        return {
          title: post.title,
          url: external ?? permalink,
          body: post.selftext || null,
          occurred_at: post.created_utc ? new Date(post.created_utc * 1000) : null,
          metadata: {
            subreddit: post.subreddit ?? source.subreddit, score: post.score ?? null, comments: post.num_comments ?? null,
            discussion_url: permalink, flair: post.link_flair_text ?? null, domain: post.domain ?? null,
          },
        };
      });
  },

  async rss(source, ctx) {
    const xml = await getText(new URL(source.url), ctx, 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5');
    return parseFeed(xml)
      .filter(item => item.url)
      .sort((a, b) => (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0))
      .slice(0, source.limit)
      .map(item => ({ title: item.title || item.url, url: item.url, body: item.summary, occurred_at: item.published, metadata: {} }));
  },
});

async function githubSearch(query, source, ctx) {
  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', query);
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(source.limit));
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (ctx.githubToken) headers.Authorization = `Bearer ${ctx.githubToken}`;
  const body = await getJson(url, ctx, headers);
  return (body?.items ?? []).map(repo => ({
    title: repo.description ? `${repo.full_name}: ${repo.description}` : repo.full_name,
    url: repo.html_url,
    body: repo.description ?? null,
    occurred_at: repo.created_at ? new Date(repo.created_at) : null,
    metadata: {
      repo: repo.full_name, stars: repo.stargazers_count ?? null, language: repo.language ?? null,
      topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 10) : [], homepage: repo.homepage || null,
    },
  }));
}

async function getJson(url, ctx, headers = {}) {
  const text = await getText(url, ctx, 'application/json', headers);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url.host} did not return JSON.`);
  }
}

async function getText(url, { fetchImpl = fetch, userAgent }, accept, headers = {}) {
  const response = await fetchImpl(url, {
    headers: { Accept: accept, 'User-Agent': userAgent, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const hint = response.status === 429 || response.status === 403 ? ' (rate limited or blocked; try again later)' : '';
    throw new Error(`${url.host} answered HTTP ${response.status}${hint}.`);
  }
  return response.text();
}

function isoDay(now, daysBack) {
  return new Date(now.getTime() - daysBack * MS_PER_DAY).toISOString().slice(0, 10);
}
