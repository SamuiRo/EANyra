import { print } from '../../shared/utils.js';
import { parseTwitterGraphqlResponse } from './twitterGraphqlParser.js';

const TIMELINE_OPERATIONS = new Set([
  'UserTweets',
  'UserTweetsAndReplies',
  'UserMedia',
  'SearchTimeline',
  'TweetDetail',
]);

function getOperationName(response) {
  const url = response.url();
  if (!url.includes('/i/api/graphql/')) return null;

  try {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

function collectBottomCursors(value, cursors) {
  if (!value || typeof value !== 'object') return;

  if (value.cursorType === 'Bottom' && typeof value.value === 'string') {
    cursors.add(value.value);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectBottomCursors(child, cursors);
  }
}

export function isTwitterTimelineResponse(response) {
  return TIMELINE_OPERATIONS.has(getOperationName(response));
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
    this.diagnostics = new Map();
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

  getDiagnostics() {
    return [...this.diagnostics.entries()].map(([operation, diagnostic]) => ({
      operation,
      responses:      diagnostic.responses,
      post_ids:       [...diagnostic.postIds],
      bottom_cursors: diagnostic.bottomCursors.size,
    }));
  }

  async #consume(response) {
    if (!response.ok()) return;

    const operation = getOperationName(response);
    const payload = await response.json();
    const posts = parseTwitterGraphqlResponse(payload, this.username);
    const cursors = new Set();
    collectBottomCursors(payload, cursors);

    const diagnostic = this.diagnostics.get(operation) ?? {
      responses: 0,
      postIds: new Set(),
      bottomCursors: new Set(),
    };
    diagnostic.responses++;

    for (const post of posts) {
      this.posts.set(post.platform_id, post);
      diagnostic.postIds.add(post.platform_id);
    }
    for (const cursor of cursors) diagnostic.bottomCursors.add(cursor);
    this.diagnostics.set(operation, diagnostic);
  }
}
