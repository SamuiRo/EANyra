# Twitter Scraping Status

Last updated: 2026-06-15

This document is the handoff source of truth for the current Twitter/X scraping
work. Read it before changing the Twitter scraper.

## Current Stage

The GraphQL response interceptor and reply classification are implemented and
working. Playwright discovery now combines the profile Replies timeline, live
search, and known conversation roots. Authenticated verification recovered all
25 currently known posts, including 20 replies. Exhaustive historical reply
discovery is still not guaranteed.

The latest full authenticated verification was scraper run `#17`:

```text
Opened Replies tab by clicking the profile navigation.
Using Posts + Replies timeline.
Stopping after 4 scroll(s) without new post IDs.
Collected 25 post(s) from @starlithars
(25 from GraphQL, 15 from DOM, 20 replies).
```

Database state after that run:

- Twitter records: `25`
- Records classified as replies: `20`
- New records saved by run `#17`: `0`

The profile Replies timeline still exposed only 15 authored IDs. Conversation
`TweetDetail` responses recovered 10 additional authored replies from known
thread roots. Live `from:<username>` search returned no authored post IDs.

The recovered database now contains the complete known examples that were
previously compressed in the profile timeline:

- one `1/8` thread was expanded from parts `1`, `3`, `4`, `7`, and `8`;
- another `1/8` thread was expanded from parts `1`, `7`, and `8`.

This confirms that profile timelines may omit authored replies even when they
return the root and later replies, and that known-conversation discovery can
recover those omitted parts.

## Extended Playwright Discovery

The scraper now attempts these sources in order:

1. Open the profile root and explicitly click the visible Replies tab.
2. Fall back to direct `/with_replies` navigation when the click is unavailable.
3. Open live search for `from:<username>` when the configured target has not
   been reached.
4. When the configured target is still not reached, open known non-reply
   authored posts as conversations and intercept `TweetDetail` responses to
   recover thread parts omitted from profile timelines.
5. Merge and deduplicate all GraphQL and DOM records by tweet ID.

The interceptor records safe per-operation diagnostics:

- GraphQL operation name;
- response count;
- unique authored tweet IDs and count;
- unique bottom cursor count.

It does not log cursor values, cookies, authorization headers, CSRF tokens, or
raw responses.

Supported discovery operations are now:

- `UserTweets`
- `UserTweetsAndReplies`
- `UserMedia`
- `SearchTimeline`
- `TweetDetail`

Conversation discovery is bounded by:

- `MAX_TWITTER_CONVERSATION_ROOTS`, default `10`;
- `MAX_TWITTER_CONVERSATION_SCROLLS`, default `2`.

## Latest Verification

Runs `#16` through `#19` were executed on 2026-06-15 without a manual cookie
import:

- Run `#16` logged `Restored Twitter session from data/cookies.json`, proving
  the cookie fallback restores `auth_token` when the persistent profile loses
  it. Its navigation was blocked by sandbox network access.
- Run `#17` used the restored authenticated session with network access,
  clicked the Replies tab, and recovered 25 posts including 20 replies.
- Run `#18` started after run `#17` closed the browser and remained
  authenticated without another restore, confirming that the restored cookie
  then persisted normally in the Chromium profile.
- Run `#19` verified the configured upper bound after a regression fix:
  `POSTS_PER_ACCOUNT=1` returned exactly 1 post even though GraphQL exposed 12.

Run `#17` GraphQL diagnostics:

- `UserTweets`: 1 response, 12 authored IDs, 1 bottom cursor;
- `UserTweetsAndReplies`: 3 responses, 15 authored IDs, 3 bottom cursors;
- `SearchTimeline`: 1 response, 0 authored IDs, 1 bottom cursor;
- `TweetDetail`: 5 responses, 25 authored IDs, 5 bottom cursors.

## Confirmed Working

- Cookie import creates a usable persistent session when current `x.com`
  cookies include `auth_token`.
- Interactive Playwright login is unreliable because X may reject it.
- The scraper intercepts `UserTweets`, `UserTweetsAndReplies`, and `UserMedia`
  GraphQL responses.
- GraphQL parsing extracts exact metrics, complete text, media, language,
  repost state, and reply state.
- Reply classification uses `legacy.in_reply_to_status_id_str`.
- GraphQL and DOM records are merged and deduplicated by tweet ID.
- DOM extraction remains available as a fallback.
- Repeated scrolls without new IDs stop early.
- Explicitly clicking the Replies tab.
- Live `from:<username>` search discovery.
- Known-conversation discovery.
- Safe operation, authored-ID, response, and bottom-cursor diagnostics after a
  successful scrape.
- Automatic restoration from the gitignored cookie fallback when the
  persistent profile loses `auth_token`.

## Not Yet Solved

- Discovering replies that are absent from the profile timeline and from every
  known conversation root.
- Exhaustive historical reply collection.

The `/with_replies` route successfully loaded in run `#9`, but it returned the
same 15 IDs visible in the profile timeline. Its route name alone is not proof
that X returned a complete replies timeline.

## Important Distinction

Reply detection and reply discovery are separate problems:

- Detection is solved: when a returned tweet is a reply, it is classified
  correctly.
- Discovery is open: X is not currently returning every known reply through
  the loaded timeline.

`POSTS_PER_ACCOUNT` and `INITIAL_POSTS_PER_ACCOUNT` are upper bounds. Increasing
them will not help when X stops returning new timeline IDs.

## Final Verification Procedure

When validating future changes, perform one high-limit backfill:

```powershell
# Only re-import if both the persistent profile and fallback session expired.
npm run import-cookies -- <cookies.json>
$env:POSTS_PER_ACCOUNT='200'
$env:SCRAPER_WAKE_UP_MAX_MS='0'
$env:MAX_TWITTER_CONVERSATION_ROOTS='20'
$env:MAX_TWITTER_CONVERSATION_SCROLLS='3'
npm run scrape:twitter
```

Record the resulting counts for `UserTweets`, `UserTweetsAndReplies`,
`SearchTimeline`, and `TweetDetail`, plus the final unique record and reply
counts. Compare the recovered IDs against the known compressed thread parts.

If authenticated live search and conversation discovery still omit known
authored replies, treat that as the practical limit of the Playwright-only
approach. Cursor replay may improve historical pagination, but cannot guarantee
recovery of replies that X omits from every discovered dataset.

## Relevant Files

- `src/platforms/twitter/TwitterScraper.js`
- `src/platforms/twitter/TwitterResponseInterceptor.js`
- `src/platforms/twitter/twitterGraphqlParser.js`
- `src/platforms/twitter/humanBehavior.js`
- `src/core/browser/sessionCookies.js`
- `src/core/cli/import-cookies.js`
- `test/sessionCookies.test.js`
- `test/twitterGraphqlParser.test.js`

## Verification Commands

```powershell
npm run scrape:twitter
npm test
```

If the session is unavailable and automatic fallback cannot restore it, run
`npm run import-cookies -- <cookies.json>`. For a useful live verification,
confirm that the log includes `Using Posts + Replies timeline`, then compare
collected IDs and reply count against what X exposes in the browser.
