/**
 * Readers for persona sources (config/sourceConfig.js). Each returns found
 * items; SourceCollector turns them into signals and removes duplicates.
 *
 *   read(source, { fetchImpl, now, githubToken, reddit, userAgent }) →
 *     Array<{ title, url, body?, occurred_at?, metadata? }>
 *
 * Only official endpoints are used: the GitHub REST search API (no HTML
 * scraping of github.com/trending), the Reddit API (app-only OAuth when a
 * reddit-app secret is stored, otherwise the public JSON listings, which
 * Reddit often blocks for anonymous clients) and the feed URL itself.
 * Every item is untrusted third-party content.
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
    const token = ctx.reddit ? await redditToken(ctx) : null;
    const path = `/r/${encodeURIComponent(source.subreddit)}/${source.sort}`;
    const url = new URL(token ? `https://oauth.reddit.com${path}` : `https://www.reddit.com${path}.json`);
    url.searchParams.set('limit', String(Math.min(100, source.limit * 2)));
    url.searchParams.set('raw_json', '1');
    if (source.period) url.searchParams.set('t', source.period);
    const body = await getJson(url, ctx, token ? { Authorization: `Bearer ${token}` } : {});
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

/**
 * Application-only OAuth token (client credentials), cached on ctx.reddit
 * for the rest of the run. https://github.com/reddit-archive/reddit/wiki/OAuth2
 */
async function redditToken(ctx) {
  const app = ctx.reddit;
  if (app.token && app.expiresAt > Date.now()) return app.token;
  const { fetchImpl = fetch, userAgent } = ctx;
  const response = await fetchImpl('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Reddit OAuth answered HTTP ${response.status}; check the reddit-app secret.`);
  const body = JSON.parse(await response.text());
  if (!body.access_token) throw new Error('Reddit OAuth returned no access token; check the reddit-app secret.');
  app.token = body.access_token;
  app.expiresAt = Date.now() + Math.max(60, Number(body.expires_in ?? 3600) - 60) * 1000;
  return app.token;
}

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
