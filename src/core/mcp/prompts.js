/**
 * MCP prompts: ready-made workflows the author can pick in an MCP client
 * (e.g. Claude Desktop's prompt menu) instead of explaining the steps.
 * Each prompt only describes which tools to call in which order; the agent
 * still asks before anything is published.
 */

import { z } from 'zod';

const optional = description => z.string().max(200).optional().describe(description);

export const PROMPTS = [
  {
    name: 'write_post',
    title: 'Write a post',
    description: 'Write a post for one persona/account in its own voice and save it as a draft for review.',
    args: {
      persona: optional('Persona slug, e.g. "brand". Leave empty to choose from the account or topic.'),
      platform: optional('twitter, telegram or linkedin. Leave empty for every platform of the persona.'),
      topic: optional('What the post is about. Leave empty to pick from unused signals.'),
    },
    build: ({ persona, platform, topic }) => [
      `Write a ${platform ?? ''} post${persona ? ` for persona "${persona}"` : ''}${topic ? ` about: ${topic}` : ''}.`.replace(/\s+/g, ' '),
      '',
      'Steps:',
      persona
        ? `1. context_get with persona "${persona}".`
        : '1. personas_list, pick the persona that fits the topic or ask me, then context_get with it.',
      `2. drafts_list for that persona${platform ? ` and platform ${platform}` : ''} to avoid duplicating a waiting draft.`,
      topic
        ? '3. signals_get with the persona to find related material (optional).'
        : '3. signals_get with the persona and pick the strongest unused signal; tell me which one and why.',
      '4. posts_get with the persona, type "sample", to calibrate style on my real posts.',
      `5. Write ${platform ? 'the post' : 'one version per platform of the persona'} following platforms.<platform> rules ` +
        '(language, length, style, formats, avoid) and the voice. Do not reuse one text across platforms.',
      '6. Save each version with draft_create (exact account, signal_ids of the material used, notes with the angle).',
      '7. Show me the drafts. Do not publish anything; I review them in the web UI.',
    ].join('\n'),
  },
  {
    name: 'content_week',
    title: 'Plan the week',
    description: 'Check what is due across personas and prepare drafts for the accounts that need posts.',
    args: { persona: optional('Limit to one persona.') },
    build: ({ persona }) => [
      `Plan my content${persona ? ` for persona "${persona}"` : ''} for the coming week.`,
      '',
      `1. content_plan_get${persona ? ` with persona "${persona}"` : ''}. If any account has data_warning, run scraper_run for it, wait with scraper_job_get, then call content_plan_get again.`,
      '2. For every overdue or due account without waiting drafts: context_get with its persona, pick material from signals_get (persona filter), and write one post in that persona\'s voice.',
      '3. Save each with draft_create, including signal_ids.',
      '4. Finish with a short table: account, status, draft id, one-line summary. Do not publish anything.',
    ].join('\n'),
  },
  {
    name: 'repurpose_signal',
    title: 'Turn a signal into posts',
    description: 'Turn one signal (release, idea, article) into platform-specific drafts for the right persona.',
    args: { signal_id: z.string().regex(/^\d+$/).describe('Signal id from signals_get.') },
    build: ({ signal_id }) => [
      `Turn signal ${signal_id} into posts.`,
      '',
      `1. signals_get to read signal ${signal_id} (check used_for_content).`,
      '2. Decide which persona it belongs to (personas_list, its account or persona metadata); ask me if unclear.',
      '3. context_get with that persona, posts_get type "sample" for style.',
      `4. Write one version per platform of the persona and save each with draft_create, signal_ids [${signal_id}].`,
      '5. Show me the drafts. Do not publish anything.',
    ].join('\n'),
  },
  {
    name: 'performance_review',
    title: 'What works',
    description: 'Analyse which of my posts performed best and turn it into concrete writing guidance.',
    args: { persona: optional('Persona slug.'), days: z.string().regex(/^\d+$/).optional().describe('Look-back window in days, default 30.') },
    build: ({ persona, days = '30' }) => [
      `Review my post performance${persona ? ` for persona "${persona}"` : ''} over the last ${days} days.`,
      '',
      `1. content_performance_get${persona ? ` with persona "${persona}"` : ''} and days ${days}: how drafts from EANyra performed vs. each account's median, by signal type and by author (AI vs. me).`,
      `   Then posts_stats${persona ? ` with persona "${persona}"` : ''} and since_days ${days}.`,
      `2. posts_get type "top_engagement" and type "recent"${persona ? ` with persona "${persona}"` : ''}, since_days ${days}.`,
      '3. Compare the top posts with the rest: topics, format, length, hooks, time of posting, language.',
      '4. Give 5 concrete, evidence-based recommendations, each citing example posts.',
      '5. Suggest 3 post ideas following them and offer to save them with signal_add.',
    ].join('\n'),
  },
];

/** @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server */
export function registerPrompts(server) {
  for (const prompt of PROMPTS) {
    server.registerPrompt(prompt.name, {
      title: prompt.title,
      description: prompt.description,
      argsSchema: prompt.args,
    }, args => ({
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args ?? {}) } }],
    }));
  }
}
