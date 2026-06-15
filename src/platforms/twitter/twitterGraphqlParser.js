import { TWITTER } from '../../config/app.config.js';

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unwrapTweetResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.__typename === 'TweetWithVisibilityResults') return result.tweet ?? null;
  return result.tweet?.legacy ? result.tweet : result;
}

function getScreenName(tweet) {
  const user = tweet?.core?.user_results?.result;
  return user?.legacy?.screen_name ?? user?.core?.screen_name ?? null;
}

function getText(tweet, legacy) {
  return tweet?.note_tweet?.note_tweet_results?.result?.text
    ?? legacy?.note_tweet?.note_tweet_results?.result?.text
    ?? legacy?.full_text
    ?? '';
}

function getMediaUrls(tweet, legacy) {
  const media = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  const urls = [];

  for (const item of media) {
    if (item?.media_url_https ?? item?.media_url) {
      urls.push(item.media_url_https ?? item.media_url);
    }

    const variants = item?.video_info?.variants
      ?.filter(variant => variant?.url && variant?.content_type === 'video/mp4')
      ?.sort((a, b) => asNumber(b.bitrate) - asNumber(a.bitrate));

    if (variants?.length) urls.push(variants[0].url);
  }

  return [...new Set(urls)];
}

function collectTimelineTweetResults(value, results) {
  if (!value || typeof value !== 'object') return;

  const result = value?.itemContent?.tweet_results?.result;
  if (result) results.push(result);

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectTimelineTweetResults(child, results);
  }
}

/**
 * Convert one GraphQL tweet result into the normalized RawPost contract.
 *
 * @param {object} result
 * @param {string} username
 * @returns {import('../../core/teapot/repositories/PostRepository.js').RawPost|null}
 */
export function parseGraphqlTweet(result, username) {
  const tweet = unwrapTweetResult(result);
  const legacy = tweet?.legacy;
  if (!tweet || !legacy) return null;

  const author = getScreenName(tweet);
  if (!author || author.toLowerCase() !== username.toLowerCase()) return null;

  const tweetId = String(tweet.rest_id ?? legacy.id_str ?? '');
  if (!tweetId) return null;

  const viewsValue = tweet?.views?.count ?? legacy?.ext_views?.count;
  const postedAt = legacy.created_at ? new Date(legacy.created_at) : null;

  return {
    platform:    'twitter',
    platform_id: tweetId,
    text:        getText(tweet, legacy),
    lang:        legacy.lang ?? null,
    posted_at:   postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
    likes:       asNumber(legacy.favorite_count),
    reposts:     asNumber(legacy.retweet_count),
    replies:     asNumber(legacy.reply_count),
    views:       viewsValue === undefined || viewsValue === null
      ? null
      : asNumber(viewsValue),
    media_urls:  getMediaUrls(tweet, legacy),
    is_repost:   Boolean(legacy.retweeted_status_result ?? legacy.retweeted_status_id_str),
    is_reply:    Boolean(legacy.in_reply_to_status_id_str),
    raw_url:     `${TWITTER.baseUrl}/${author}/status/${tweetId}`,
    scraped_at:  new Date(),
  };
}

/**
 * Parse top-level timeline tweets from a Twitter/X GraphQL response.
 * Nested quoted and retweeted tweets are deliberately ignored.
 *
 * @param {object} payload
 * @param {string} username
 * @returns {import('../../core/teapot/repositories/PostRepository.js').RawPost[]}
 */
export function parseTwitterGraphqlResponse(payload, username) {
  const results = [];
  collectTimelineTweetResults(payload, results);

  const posts = new Map();
  for (const result of results) {
    const post = parseGraphqlTweet(result, username);
    if (post) posts.set(post.platform_id, post);
  }
  return [...posts.values()];
}

