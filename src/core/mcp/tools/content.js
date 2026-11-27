import fs from 'node:fs/promises';

import { PATHS } from '../../../config/app.config.js';
import { validateAccounts } from '../../../config/accountConfig.js';
import { PLATFORM_CATALOG, MANUAL_METRICS_PLATFORMS } from '../../../platforms/catalog.js';
import * as mcpDb from '../db.js';
import { loadPersonas } from '../personas.js';
import { loadGlobalContext } from '../context.js';
import { ContentService, DRAFT_STATUSES } from '../../services/ContentService.js';
import { mcpExecutor } from '../../services/sql.js';

/**
 * src/core/mcp/tools/content.js
 *
 * The writing loop for the agent and the web UI:
 *   content_plan_get   — what is due per persona/account vs. posting_frequency
 *   signal_add         — save an idea, article or note as material
 *   draft_create / drafts_list / draft_get / draft_update
 *   draft_prepare_telegram — turn a Telegram draft into a publishable request
 *   draft_mark_published   — record a post the author published (X, LinkedIn)
 */

const PUBLISHING_PLATFORMS = Object.values(PLATFORM_CATALOG).filter(p => p.output === 'posts').map(p => p.id);

export function createContentService() {
  return new ContentService(mcpExecutor(mcpDb), {
    loadAccounts: async () => validateAccounts(JSON.parse(await fs.readFile(PATHS.accountsConfig, 'utf8'))),
    loadPersonas,
    loadGlobalContext,
  });
}

/**
 * @param {{ publications: import('../TelegramPublishRequests.js').TelegramPublishRequests,
 *           content?: ContentService }} deps
 */
export function buildContentTools({ publications, content = createContentService() }) {
  const id = { type: 'integer', minimum: 1, description: 'Draft id from draft_create or drafts_list.' };
  return [
    {
      name: 'content_plan_get',
      description:
        'What to write next. For every persona and publishing account: the target cadence from ' +
        'platforms.<platform>.posting_frequency, days since the last own post (from collected data), ' +
        'posts in the last 7/30 days, status (overdue, due, on_track, no_target), next due date, drafts ' +
        'already waiting and the count of unused signals. Start a writing session here. If an account has ' +
        'data_warning, collect fresh data with scraper_run before trusting its status.',
      inputSchema: { type: 'object', properties: { persona: { type: 'string', minLength: 1, description: 'Limit to one persona.' } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ persona } = {}, scope) => content.contentPlan({ persona }, scope),
    },
    {
      name: 'content_performance_get',
      description:
        'Learn from results. For drafts published in the window: engagement of the collected post ' +
        '(likes, reposts, replies, views) relative to the same account\'s median post (vs_median), which ' +
        'signal types led to stronger posts, and AI-written vs. author-written drafts. Use it before writing ' +
        'to repeat what worked, and in performance reviews. Published drafts appear here after the next ' +
        'collection of their account.',
      inputSchema: {
        type: 'object',
        properties: {
          persona: { type: 'string', minLength: 1 },
          platform: { type: 'string', enum: PUBLISHING_PLATFORMS },
          days: { type: 'integer', minimum: 1, maximum: 365, default: 90 },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: (args, scope) => content.performance(args, scope),
    },
    {
      name: 'signal_add',
      description:
        'Save material for future posts as a signal: an idea, an article/link or a note the author ' +
        'mentions. Optionally bind it to a persona so signals_get with that persona returns it. ' +
        'Use when the author shares an idea or link they want to write about later.',
      inputSchema: {
        type: 'object', required: ['title'],
        properties: {
          kind: { type: 'string', enum: ['idea', 'article', 'note'], default: 'idea' },
          title: { type: 'string', minLength: 1, maxLength: 300 },
          body: { type: 'string', maxLength: 20000, description: 'Details, quotes, the angle to take.' },
          url: { type: 'string', description: 'Source link (http/https).' },
          persona: { type: 'string', minLength: 1 },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: args => content.addSignal(args),
    },
    {
      name: 'draft_create',
      description:
        'Save a written post as a draft for the author to review in the web UI. Always save finished ' +
        'texts here instead of only answering in chat. Give the platform and, when known, the exact ' +
        'account ("platform/username" or username); the persona is always derived from the account, and a ' +
        'persona that does not match the account is refused. Pass ' +
        'signal_ids of the signals the post is based on: they are marked used once it is published. ' +
        'Creating a draft never publishes anything. X and LinkedIn drafts are always published by the ' +
        'author manually; Telegram drafts can be published with draft_prepare_telegram + telegram_post_publish ' +
        'after approval. Write one draft per platform version.',
      inputSchema: {
        type: 'object', required: ['platform', 'text'],
        properties: {
          platform: { type: 'string', enum: PUBLISHING_PLATFORMS },
          account: { type: 'string', minLength: 1, description: 'Configured target account.' },
          persona: { type: 'string', minLength: 1, description: 'Persona slug when no single account is chosen yet.' },
          text: { type: 'string', minLength: 1, maxLength: 20000, description: 'Exact post text.' },
          signal_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Source signals used for this post.' },
          notes: { type: 'string', maxLength: 4000, description: 'Rationale, alternatives, hashtags or media to attach.' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: args => content.createDraft({ ...args, created_by: 'ai' }),
    },
    {
      name: 'drafts_list',
      description: 'List drafts, newest and approved first. Filter by status (draft, approved, published, discarded), persona, platform or account. Check this before writing so you do not duplicate a waiting draft.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: DRAFT_STATUSES },
          persona: { type: 'string', minLength: 1 },
          platform: { type: 'string', enum: PUBLISHING_PLATFORMS },
          account: { type: 'string', minLength: 1, description: 'Username without platform prefix.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: (args, scope) => content.listDrafts(args, scope),
    },
    {
      name: 'draft_get',
      description: 'Read one draft with its source signals and Telegram delivery state.',
      inputSchema: { type: 'object', required: ['id'], properties: { id } },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ id: draftId }) => content.getDraft(draftId),
    },
    {
      name: 'draft_update',
      description: 'Revise a draft\'s text, notes or source signals after feedback, or set status to approved, draft or discarded. Published drafts cannot change.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: {
          id,
          text: { type: 'string', minLength: 1, maxLength: 20000 },
          notes: { type: 'string', maxLength: 4000 },
          status: { type: 'string', enum: ['draft', 'approved', 'discarded'] },
          signal_ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: ({ id: draftId, ...changes }) => content.updateDraft(draftId, changes),
    },
    {
      name: 'draft_mark_published',
      description:
        'Record that the author published this draft themselves (X, LinkedIn, or Telegram outside EANyra) ' +
        'and mark its source signals as used. Call only after the author confirms the post is live; pass ' +
        'its URL when known. Never call it speculatively.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id, url: { type: 'string', description: 'Public URL of the published post.' } },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: ({ id: draftId, url }) => content.markPublished(draftId, { url: url ?? null }),
    },
    {
      name: 'post_metrics_record',
      description:
        'Enter the numbers of a published post on a platform EANyra cannot collect yet (Threads). Give the ' +
        'account, the post URL and the counts the author reads in the app (likes, reposts, replies, views); ' +
        'recording the same URL again updates them. With draft_id the draft is marked published and linked, ' +
        'so content_performance_get and content_plan_get count the post. Only enter numbers the author gave or ' +
        'confirmed; never estimate them.',
      inputSchema: {
        type: 'object', required: ['platform', 'account', 'url'],
        properties: {
          platform: { type: 'string', enum: MANUAL_METRICS_PLATFORMS },
          account: { type: 'string', minLength: 1, description: 'Configured account, e.g. "threads/example_handle".' },
          persona: { type: 'string', minLength: 1, description: 'Optional; must be the account\'s persona.' },
          url: { type: 'string', minLength: 1, description: 'Public URL of the post.' },
          draft_id: { type: 'integer', minimum: 1, description: 'The draft this post was published from.' },
          text: { type: 'string', maxLength: 20000, description: 'Post text when there is no draft.' },
          posted_at: { type: 'string', description: 'When it was published (ISO date); default the draft\'s publish time or now.' },
          likes: { type: 'integer', minimum: 0 },
          reposts: { type: 'integer', minimum: 0 },
          replies: { type: 'integer', minimum: 0 },
          views: { type: 'integer', minimum: 0 },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: args => content.recordPostMetrics(args),
    },
    {
      name: 'draft_prepare_telegram',
      description:
        'Prepare a Telegram draft for publishing without sending it: stores the exact text in the durable ' +
        'Telegram outbox and returns request_id and content_hash. Then, only with the author\'s approval of ' +
        'this exact text and channel, call telegram_post_publish with them. The draft becomes published ' +
        'automatically once Telegram confirms the post. Calling it again for unchanged text is safe.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id, disable_preview: { type: 'boolean', default: true } },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler({ id: draftId, disable_preview = true }) {
        const { draft, request_id } = await content.telegramRequestFor(draftId);
        const prepared = await publications.execute('prepare', {
          request_id, account: draft.account, text: draft.text, disable_preview,
        });
        return {
          draft_id: draft.id,
          ...prepared,
          next_action: 'Show the channel and text to the author. Publish only after approval: telegram_post_publish with this request_id and content_hash.',
        };
      },
    },
  ];
}
