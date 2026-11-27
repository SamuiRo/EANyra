/**
 * Persona `sources:` — public places EANyra reads for new material. Each new
 * link a source yields becomes a signal of that persona (source "finding").
 *
 *   - type: github_trending   new repositories that gathered the most stars
 *     period: daily | weekly  (default daily)
 *     language: rust          (optional)
 *     min_stars: 20
 *   - type: github_topic      new repositories with a topic, by stars
 *     topic: example-topic
 *     window_days: 30
 *     min_stars: 10
 *   - type: reddit            posts of one subreddit (public JSON listing)
 *     subreddit: example
 *     sort: top | hot | new   (default top)
 *     period: hour | day | week | month | year   (top only, default day)
 *     min_score: 0
 *     include_nsfw: false
 *   - type: rss               an RSS or Atom feed
 *     url: https://example.com/feed.xml
 *
 * Every source also takes `name` (shown with the signal) and `limit`
 * (newest items read per run, 1-50, default 10).
 */

export const SOURCE_TYPES = ['github_trending', 'github_topic', 'reddit', 'rss'];
export const MAX_SOURCES_PER_PERSONA = 30;

const COMMON = ['type', 'name', 'limit'];
const FIELDS = {
  github_trending: ['period', 'language', 'min_stars'],
  github_topic: ['topic', 'window_days', 'min_stars'],
  reddit: ['subreddit', 'sort', 'period', 'min_score', 'include_nsfw'],
  rss: ['url'],
};
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;
const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;
const LANGUAGE = /^[A-Za-z0-9+#._ -]{1,40}$/;

/**
 * @param {unknown} value the persona's `sources` field
 * @returns {{ sources: object[], warnings: string[] }} normalized sources
 * @throws {Error} naming the first invalid entry
 */
export function parseSources(value) {
  if (value === undefined || value === null) return { sources: [], warnings: [] };
  if (!Array.isArray(value)) throw new Error('sources must be a list of sources (one "- type: …" per entry).');
  if (value.length > MAX_SOURCES_PER_PERSONA) throw new Error(`sources: at most ${MAX_SOURCES_PER_PERSONA} entries.`);
  const warnings = [];
  const sources = value.map((entry, index) => {
    const where = `sources[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be a mapping with a type.`);
    if (!SOURCE_TYPES.includes(entry.type)) throw new Error(`${where}.type must be one of: ${SOURCE_TYPES.join(', ')}.`);
    for (const key of Object.keys(entry)) {
      if (!COMMON.includes(key) && !FIELDS[entry.type].includes(key)) warnings.push(`${where}.${key} is not used by ${entry.type} and is ignored`);
    }
    const source = normalize(entry, where);
    source.key = sourceKey(source);
    return source;
  });
  const keys = sources.map(source => source.key);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate) throw new Error(`sources: ${duplicate} is listed twice.`);
  return { sources, warnings };
}

function normalize(entry, where) {
  const base = {
    type: entry.type,
    name: optionalText(entry.name, `${where}.name`),
    limit: integer(entry.limit, 10, 1, 50, `${where}.limit`),
  };
  switch (entry.type) {
    case 'github_trending': {
      const period = entry.period ?? 'daily';
      if (!['daily', 'weekly'].includes(period)) throw new Error(`${where}.period must be daily or weekly.`);
      const language = optionalText(entry.language, `${where}.language`);
      if (language && !LANGUAGE.test(language)) throw new Error(`${where}.language must be a language name such as "rust".`);
      return { ...base, period, language, min_stars: integer(entry.min_stars, 20, 0, 1_000_000, `${where}.min_stars`) };
    }
    case 'github_topic': {
      if (typeof entry.topic !== 'string' || !TOPIC.test(entry.topic)) throw new Error(`${where}.topic must be a GitHub topic such as "example-topic".`);
      return {
        ...base, topic: entry.topic,
        window_days: integer(entry.window_days, 30, 1, 365, `${where}.window_days`),
        min_stars: integer(entry.min_stars, 10, 0, 1_000_000, `${where}.min_stars`),
      };
    }
    case 'reddit': {
      const subreddit = typeof entry.subreddit === 'string' ? entry.subreddit.replace(/^\/?r\//i, '') : entry.subreddit;
      if (typeof subreddit !== 'string' || !SUBREDDIT.test(subreddit)) throw new Error(`${where}.subreddit must be a subreddit name such as "example".`);
      const sort = entry.sort ?? 'top';
      if (!['top', 'hot', 'new'].includes(sort)) throw new Error(`${where}.sort must be top, hot or new.`);
      const period = entry.period ?? 'day';
      if (!['hour', 'day', 'week', 'month', 'year'].includes(period)) throw new Error(`${where}.period must be hour, day, week, month or year.`);
      if (entry.include_nsfw !== undefined && typeof entry.include_nsfw !== 'boolean') throw new Error(`${where}.include_nsfw must be true or false.`);
      return {
        ...base, subreddit, sort, period: sort === 'top' ? period : null,
        min_score: integer(entry.min_score, 0, 0, 10_000_000, `${where}.min_score`),
        include_nsfw: entry.include_nsfw === true,
      };
    }
    case 'rss': {
      if (!isHttpUrl(entry.url)) throw new Error(`${where}.url must be an http(s) feed URL.`);
      return { ...base, url: entry.url };
    }
    default:
      throw new Error(`${where}.type is not supported.`);
  }
}

/** Stable identity of a source, used for its run state. */
export function sourceKey(source) {
  switch (source.type) {
    case 'github_trending': return `github_trending:${source.period}${source.language ? `:${source.language.toLowerCase()}` : ''}`;
    case 'github_topic': return `github_topic:${source.topic}`;
    case 'reddit': return `reddit:${source.subreddit.toLowerCase()}:${source.sort}${source.period ? `:${source.period}` : ''}`;
    case 'rss': return `rss:${source.url}`;
    default: return source.type;
  }
}

function integer(value, fallback, min, max, where) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${where} must be a whole number from ${min} to ${max}.`);
  return value;
}

function optionalText(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${where} must be text.`);
  return value.trim() || null;
}

function isHttpUrl(value) {
  try {
    return typeof value === 'string' && ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
