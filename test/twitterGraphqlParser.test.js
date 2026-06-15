import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  parseGraphqlTweet,
  parseTwitterGraphqlResponse,
} from '../src/platforms/twitter/twitterGraphqlParser.js';
import {
  isTwitterTimelineResponse,
  TwitterResponseInterceptor,
} from '../src/platforms/twitter/TwitterResponseInterceptor.js';

function tweetResult(overrides = {}) {
  return {
    __typename: 'Tweet',
    rest_id: '123',
    core: {
      user_results: {
        result: {
          legacy: { screen_name: 'example' },
        },
      },
    },
    views: { count: '4567' },
    legacy: {
      created_at: 'Wed Oct 10 20:19:24 +0000 2018',
      full_text: 'Short text',
      lang: 'en',
      favorite_count: 12,
      retweet_count: 3,
      reply_count: 2,
      extended_entities: {
        media: [{ type: 'photo', media_url_https: 'https://img.example/photo.jpg' }],
      },
    },
    ...overrides,
  };
}

test('parses exact metrics, media, long text, and reply state', () => {
  const result = tweetResult({
    note_tweet: {
      note_tweet_results: {
        result: { text: 'Complete long-form text' },
      },
    },
    legacy: {
      ...tweetResult().legacy,
      in_reply_to_status_id_str: '100',
    },
  });

  const post = parseGraphqlTweet(result, 'Example');

  assert.equal(post.text, 'Complete long-form text');
  assert.equal(post.likes, 12);
  assert.equal(post.views, 4567);
  assert.equal(post.is_reply, true);
  assert.deepEqual(post.media_urls, ['https://img.example/photo.jpg']);
});

test('unwraps visibility results and identifies reposts', () => {
  const post = parseGraphqlTweet({
    __typename: 'TweetWithVisibilityResults',
    tweet: tweetResult({
      legacy: {
        ...tweetResult().legacy,
        retweeted_status_result: { result: tweetResult({ rest_id: '999' }) },
      },
    }),
  }, 'example');

  assert.equal(post.platform_id, '123');
  assert.equal(post.is_repost, true);
});

test('extracts only top-level timeline items authored by the requested account', () => {
  const payload = {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [{
                entries: [{
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          ...tweetResult(),
                          quoted_status_result: {
                            result: tweetResult({ rest_id: '999' }),
                          },
                        },
                      },
                    },
                  },
                }, {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: tweetResult({
                          rest_id: '777',
                          core: {
                            user_results: {
                              result: { legacy: { screen_name: 'someone_else' } },
                            },
                          },
                        }),
                      },
                    },
                  },
                }],
              }],
            },
          },
        },
      },
    },
  };

  const posts = parseTwitterGraphqlResponse(payload, 'example');

  assert.deepEqual(posts.map(post => post.platform_id), ['123']);
});

test('intercepts only supported Twitter profile timeline operations', () => {
  const response = path => ({ url: () => `https://x.com/i/api/graphql/query-id/${path}?variables=x` });

  assert.equal(isTwitterTimelineResponse(response('UserTweets')), true);
  assert.equal(isTwitterTimelineResponse(response('UserTweetsAndReplies')), true);
  assert.equal(isTwitterTimelineResponse(response('SearchTimeline')), true);
  assert.equal(isTwitterTimelineResponse(response('TweetDetail')), true);
  assert.equal(isTwitterTimelineResponse(response('HomeTimeline')), false);
  assert.equal(isTwitterTimelineResponse({ url: () => 'https://example.com/UserTweets' }), false);
});

test('response interceptor waits for pending JSON parsing before stopping', async () => {
  const page = new EventEmitter();
  const interceptor = new TwitterResponseInterceptor(page, 'example');
  const payload = {
    data: {
      timeline: {
        itemContent: {
          tweet_results: { result: tweetResult() },
        },
        cursor: {
          cursorType: 'Bottom',
          value: 'opaque-bottom-cursor',
        },
      },
    },
  };

  interceptor.start();
  page.emit('response', {
    url: () => 'https://x.com/i/api/graphql/query-id/UserTweets?variables=x',
    ok: () => true,
    json: async () => payload,
  });
  await interceptor.stop();

  assert.deepEqual(interceptor.getPosts().map(post => post.platform_id), ['123']);
  assert.deepEqual(interceptor.getDiagnostics(), [{
    operation: 'UserTweets',
    responses: 1,
    post_ids: ['123'],
    bottom_cursors: 1,
  }]);
  assert.equal(page.listenerCount('response'), 0);
});
