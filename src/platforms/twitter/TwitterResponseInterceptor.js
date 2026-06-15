import { print } from '../../shared/utils.js';
import { parseTwitterGraphqlResponse } from './twitterGraphqlParser.js';

const TIMELINE_OPERATIONS = new Set([
  'UserTweets',
  'UserTweetsAndReplies',
  'UserMedia',
]);

export function isTwitterTimelineResponse(response) {
  const url = response.url();
  if (!url.includes('/i/api/graphql/')) return false;

  let operation;
  try {
    operation = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  } catch {
    return false;
  }
  return TIMELINE_OPERATIONS.has(operation);
}

export class TwitterResponseInterceptor {
  /**
   * @param {import('playwright').Page} page
   * @param {string} username
   */
  constructor(page, username) {
    this.page = page;
    this.username = username;
    this.posts = new Map();
    this.pending = new Set();
    this.handler = response => {
      if (!isTwitterTimelineResponse(response)) return;

      const task = this.#consume(response)
        .catch(error => print(`Twitter GraphQL response skipped: ${error.message}`, 'debug'))
        .finally(() => this.pending.delete(task));
      this.pending.add(task);
    };
  }

  start() {
    this.page.on('response', this.handler);
  }

  async stop() {
    this.page.removeListener('response', this.handler);
    await this.drain();
  }

  async drain() {
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
    }
  }

  getPosts() {
    return [...this.posts.values()];
  }

  async #consume(response) {
    if (!response.ok()) return;

    const payload = await response.json();
    for (const post of parseTwitterGraphqlResponse(payload, this.username)) {
      this.posts.set(post.platform_id, post);
    }
  }
}

