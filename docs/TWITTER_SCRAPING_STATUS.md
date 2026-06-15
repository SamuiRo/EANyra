# Twitter Scraping Status

Last updated: 2026-06-15

This document is the handoff source of truth for the current Twitter/X scraping
work. Read it before changing the Twitter scraper.

## Current Stage

The GraphQL response interceptor and reply classification are implemented and
working. Complete discovery of every reply visible elsewhere on X is not yet
solved or verified.

The latest confirmed authenticated run was scraper run `#9`:

```text
Navigating to https://x.com/starlithars/with_replies
Using Posts + Replies timeline.
Stopping after 4 scroll(s) without new post IDs.
Collected 15 post(s) from @starlithars
(15 from GraphQL, 15 from DOM, 10 replies).
```

Database state after that run:

- Twitter records: `15`
- Records classified as replies: `10`
- New records saved by run `#9`: `0`

The user confirmed that X shows 15 entries in the loaded profile timeline.
Therefore, returning 15 instead of the configured target of 20 is expected.
However, the user also knows that additional replies exist, so the current
timeline does not expose every reply.

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

## Not Yet Solved

- Discovering replies that are not present in the loaded profile timeline.
- Proving that direct navigation to `/<username>/with_replies` produces a
  different GraphQL dataset from `/<username>` for this account.
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

## Recommended Next Investigation

Do not change parsing first. Add temporary response diagnostics and compare:

1. Open the profile root and record GraphQL operation names, response counts,
   tweet IDs, and bottom cursors.
2. Explicitly click the visible `Replies` tab instead of relying only on direct
   `/with_replies` navigation.
3. Record the same GraphQL diagnostics after the click.
4. Compare the `UserTweets` and `UserTweetsAndReplies` payloads and cursors.
5. Determine whether more pages can be requested by scrolling, cursor replay,
   or another authenticated endpoint.

Do not log cookie values, authorization headers, CSRF tokens, or complete raw
responses containing private session data.

## Relevant Files

- `src/platforms/twitter/TwitterScraper.js`
- `src/platforms/twitter/TwitterResponseInterceptor.js`
- `src/platforms/twitter/twitterGraphqlParser.js`
- `src/platforms/twitter/humanBehavior.js`
- `src/core/cli/import-cookies.js`
- `test/twitterGraphqlParser.test.js`

## Verification Commands

```powershell
npm run import-cookies -- <cookies.json>
npm run scrape:twitter
npm test
```

For a useful live verification, confirm that the log includes
`Using Posts + Replies timeline`, then compare collected IDs and reply count
against what X exposes in the browser.
