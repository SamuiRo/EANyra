/**
 * src/platforms/twitter/TwitterScraper.js
 *
 * Scrapes tweets from a single Twitter/X profile page using Playwright.
 * Returns RawPost[] compatible with the unified PostRepository.
 *
 * Human-behaviour:
 *   - simulatePageLanding() is called once after the first tweet appears
 *   - humanScroll() replaces the primitive window.scrollBy() call
 *   Both functions live in humanBehavior.js to keep this file focused
 *   purely on extraction logic.
 */

import { SCRAPER, TWITTER }                                 from '../../config/app.config.js';
import { print }                                            from '../../shared/utils.js';
import { humanScroll, simulatePageLanding }                 from './humanBehavior.js';
import { TwitterResponseInterceptor }                       from './TwitterResponseInterceptor.js';

// Selectors

const SEL = {
  tweet:        'article[data-testid="tweet"]',
  tweetText:    '[data-testid="tweetText"]',
  time:         'time',
  likeCount:    '[data-testid="like"] span[data-testid="app-text-transition-container"]',
  retweetCount: '[data-testid="retweet"] span[data-testid="app-text-transition-container"]',
  replyCount:   '[data-testid="reply"] span[data-testid="app-text-transition-container"]',
  viewCount:    '[data-testid="analyticsButton"] span',
  mediaImg:     '[data-testid="tweetPhoto"] img',
  mediaVideo:   '[data-testid="videoPlayer"] video',
  tweetLink:    'a[href*="/status/"]',
  retweetLabel: '[data-testid="socialContext"]',
};

// Helpers

/**
 * Parse abbreviated metric strings like "1.2K", "45M", "3" into integers.
 * @param {string|null|undefined} raw
 * @returns {number}
 */
function parseMetric(raw) {
  if (!raw) return 0;
  const str = raw.replace(/,/g, '').trim();
  if (str.endsWith('K')) return Math.round(parseFloat(str) * 1_000);
  if (str.endsWith('M')) return Math.round(parseFloat(str) * 1_000_000);
  const n = parseInt(str, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Extract the numeric tweet ID from a status URL path.
 * Example: "/user/status/1234567890" becomes "1234567890".
 * @param {string|null|undefined} href
 * @returns {string|null}
 */
function extractTweetId(href) {
  const match = href?.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function mergePosts(domPosts, networkPosts) {
  const merged = new Map(domPosts.map(post => [post.platform_id, post]));

  for (const networkPost of networkPosts) {
    const domPost = merged.get(networkPost.platform_id);
    merged.set(networkPost.platform_id, {
      ...domPost,
      ...networkPost,
      text:       networkPost.text || domPost?.text || '',
      lang:       networkPost.lang ?? domPost?.lang ?? null,
      posted_at:  networkPost.posted_at ?? domPost?.posted_at ?? null,
      media_urls: networkPost.media_urls?.length
        ? networkPost.media_urls
        : domPost?.media_urls ?? [],
      raw_url:    networkPost.raw_url ?? domPost?.raw_url ?? null,
      views:      networkPost.views ?? domPost?.views ?? null,
    });
  }

  return [...merged.values()];
}

export class TwitterScraper {
  /**
   * @param {import('playwright').Page} page         Playwright page instance
   * @param {number}                    postsTarget  How many posts to collect
   */
  constructor(page, postsTarget = SCRAPER.postsPerAccount) {
    this.page        = page;
    this.postsTarget = postsTarget;
  }

  /**
   * Navigate to a Twitter profile and collect up to postsTarget posts.
   *
   * @param {string} username  Twitter handle without "@"
   * @returns {Promise<import('../../core/teapot/repositories/PostRepository.js').RawPost[]>}
   */
  async scrapeAccount(username) {
    const repliesUrl = `${TWITTER.baseUrl}/${username}/with_replies`;
    const postsUrl = `${TWITTER.baseUrl}/${username}`;
    const interceptor = new TwitterResponseInterceptor(this.page, username);
    interceptor.start();

    const cookies = await this.page.context().cookies(TWITTER.baseUrl);
    const hasAuthToken = cookies.some(cookie => cookie.name === 'auth_token');
    if (!hasAuthToken) {
      print(
        'Twitter session has no auth_token. Replies and public posts may be unavailable; ' +
        'refresh with `npm run import-cookies -- <file>`.',
        'warning',
      );
    }

    let timeline = 'replies';
    let loaded = await this.#openTimeline(repliesUrl);
    if (!loaded) {
      print('Replies timeline did not load; falling back to the Posts timeline.', 'warning');
      timeline = 'posts';
      loaded = await this.#openTimeline(postsUrl);
    }

    if (!loaded) {
      const currentUrl = this.page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
        print(
          'Twitter session expired. Refresh it with `npm run import-cookies -- <file>`.',
          'warning',
        );
      }
      print(
        `No tweets found for @${username} — account may be private, suspended, or rate-limited.`,
        'warning',
      );
      await interceptor.stop();
      return interceptor.getPosts().slice(0, this.postsTarget);
    }

    print(`Using ${timeline === 'replies' ? 'Posts + Replies' : 'Posts'} timeline.`, 'debug');
    await simulatePageLanding(this.page);

    // Map keyed on platform_id guarantees deduplication across scroll passes
    const collected      = new Map();
    let   scrollAttempts = 0;
    let   stagnantScrolls = 0;
    let   previousCount = 0;

    while (
      mergePosts([...collected.values()], interceptor.getPosts()).length < this.postsTarget &&
      scrollAttempts < SCRAPER.maxScrollAttempts
    ) {
      const articles = await this.page.$$(SEL.tweet);

      for (const article of articles) {
        if (collected.size >= this.postsTarget) break;
        try {
          const post = await this.#extractPost(article, username);
          if (post && !collected.has(post.platform_id)) {
            collected.set(post.platform_id, post);
          }
        } catch (err) {
          print(`Skipped a tweet (parse error): ${err.message}`, 'debug');
        }
      }

      await interceptor.drain();
      const currentCount = mergePosts([...collected.values()], interceptor.getPosts()).length;
      if (currentCount >= this.postsTarget) break;

      if (currentCount > previousCount) {
        previousCount = currentCount;
        stagnantScrolls = 0;
      } else {
        stagnantScrolls++;
        if (stagnantScrolls >= SCRAPER.maxStagnantScrollAttempts) {
          print(
            `Stopping after ${stagnantScrolls} scroll(s) without new post IDs.`,
            'debug',
          );
          break;
        }
      }

      await humanScroll(this.page, { scrollDelayMs: SCRAPER.scrollDelayMs });
      scrollAttempts++;
    }

    await interceptor.stop();
    const networkPosts = interceptor.getPosts();
    const posts = mergePosts([...collected.values()], networkPosts)
      .slice(0, this.postsTarget);
    const replyCount = posts.filter(post => post.is_reply).length;
    print(
      `Collected ${posts.length} post(s) from @${username} ` +
      `(${networkPosts.length} from GraphQL, ${collected.size} from DOM, ` +
      `${replyCount} replies).`,
      'data',
    );
    return posts;
  }

  async #openTimeline(url) {
    print(`Navigating to ${url}`, 'info');
    try {
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout:   SCRAPER.navigationTimeoutMs,
      });
      await this.page.waitForSelector(SEL.tweet, {
        timeout: SCRAPER.selectorTimeoutMs,
      });
      return true;
    } catch (error) {
      print(`Timeline unavailable at ${url}: ${error.message}`, 'debug');
      return false;
    }
  }

  /**
   * Extract structured data from a single <article> element.
   * Returns null if the tweet has no identifiable ID (e.g. promoted content).
   *
   * @param {import('playwright').ElementHandle} article
   * @param {string}                             username
   * @returns {Promise<import('../../core/teapot/repositories/PostRepository.js').RawPost|null>}
   */
  async #extractPost(article, username) {
    const linkEl    = await article.$(SEL.tweetLink);
    const href      = await linkEl?.getAttribute('href');
    const tweetId   = extractTweetId(href);
    if (!tweetId) return null;

    const raw_url = href ? `${TWITTER.baseUrl}${href}` : null;

    const textEl = await article.$(SEL.tweetText);
    const text   = textEl ? (await textEl.innerText()).trim() : '';

    const timeEl    = await article.$(SEL.time);
    const datetime  = await timeEl?.getAttribute('datetime');
    const posted_at = datetime ? new Date(datetime) : null;

    const likes   = parseMetric(await this.#safeInnerText(article, SEL.likeCount));
    const reposts = parseMetric(await this.#safeInnerText(article, SEL.retweetCount));
    const replies = parseMetric(await this.#safeInnerText(article, SEL.replyCount));
    const views   = parseMetric(await this.#safeInnerText(article, SEL.viewCount));

    const imgEls     = await article.$$(SEL.mediaImg);
    const videoEls   = await article.$$(SEL.mediaVideo);
    const media_urls = [
      ...await Promise.all(imgEls.map(el => el.getAttribute('src'))),
      ...await Promise.all(videoEls.map(el => el.getAttribute('src'))),
    ].filter(Boolean);

    const retweetLabelEl = await article.$(SEL.retweetLabel);
    const retweetLabel   = retweetLabelEl ? await retweetLabelEl.innerText() : '';
    const is_repost      = retweetLabel.toLowerCase().includes('retweet');

    const is_reply = href
      ? href.split('/status/').length > 2
      : false;

    const lang = await article.getAttribute('lang') ?? null;

    return {
      platform:    'twitter',
      platform_id: tweetId,
      text,
      lang,
      posted_at,
      likes,
      reposts,
      replies,
      views:       views || null,
      media_urls,
      is_repost,
      is_reply,
      raw_url,
      scraped_at:  new Date(),
    };
  }

  /**
   * Return trimmed innerText of a child selector, or null if absent.
   *
   * @param {import('playwright').ElementHandle} parent
   * @param {string} selector
   * @returns {Promise<string|null>}
   */
  async #safeInnerText(parent, selector) {
    try {
      const el = await parent.$(selector);
      return el ? (await el.innerText()).trim() : null;
    } catch {
      return null;
    }
  }
}
