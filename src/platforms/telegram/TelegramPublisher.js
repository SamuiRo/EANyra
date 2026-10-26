import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { PATHS } from '../../config/app.config.js';
import { normalizeAccount, validateAccounts } from '../../config/accountConfig.js';

export class TelegramPublisher {
  constructor({ outbox, gateway, loadAccounts = async () => validateAccounts(
    JSON.parse(await fs.readFile(PATHS.accountsConfig, 'utf8')),
  ) }) {
    this.outbox = outbox;
    this.gateway = gateway;
    this.loadAccounts = loadAccounts;
  }

  async targets() {
    return (await this.loadAccounts()).filter(isPublishTarget).map(({ username, display_name }) => ({
      account: username, display_name: display_name ?? username,
    }));
  }

  async prepare({ request_id, account, text, disable_preview = true }) {
    validateRequestId(request_id);
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
      throw new Error('Telegram text must contain 1 to 4096 UTF-16 code units and cannot be blank.');
    }
    if (typeof disable_preview !== 'boolean') throw new Error('disable_preview must be boolean.');
    account = normalizeAccount(account, 'telegram');
    await this.#assertAllowed(account);
    const content_hash = createHash('sha256').update(JSON.stringify({ account, text, disable_preview })).digest('hex');
    const draft = await this.outbox.create({
      request_id, account, text, disable_preview, content_hash, random_id: randomBytes(8).toString('hex'),
    });
    return formatDraft(draft);
  }

  async get({ request_id }) {
    validateRequestId(request_id);
    return formatDraft(await this.outbox.get(request_id));
  }

  async publish({ request_id, content_hash }) {
    validateRequestId(request_id);
    const draft = await this.outbox.get(request_id);
    if (typeof content_hash !== 'string' || content_hash !== draft.content_hash) {
      throw new Error('content_hash does not match the prepared channel and text. Review the prepared draft first.');
    }
    // A completed or uncertain request never sends again, including after restart.
    // An explicitly rejected one was not published and may be retried as is.
    if (!RETRYABLE_STATUSES.includes(draft.status)) return formatDraft(draft);
    await this.#assertAllowed(draft.account);
    try {
      const target = await this.gateway.resolve(draft.account);
      // Recheck the local policy after a possibly slow network connection.
      await this.#assertAllowed(draft.account);
      if (!await this.outbox.claim(request_id)) return formatDraft(await this.outbox.get(request_id));
      try {
        const receipt = await this.gateway.send(target, draft);
        return formatDraft(await this.outbox.sent(request_id, receipt));
      } catch (error) {
        // Telegram explicitly refused the post, so nothing was published.
        if (error.notSent) return formatDraft(await this.outbox.failed(request_id, error.message));
        // A network failure can happen after Telegram accepted the post. Never
        // retry automatically or reset to draft; the user must reconcile it.
        return formatDraft(await this.outbox.uncertain(request_id, error.message));
      }
    } finally {
      await this.gateway.close().catch(() => {});
    }
  }

  async #assertAllowed(account) {
    if (!(await this.loadAccounts()).some(entry => entry.username === account && isPublishTarget(entry))) {
      throw new Error(`Publishing is not enabled for Telegram channel ${account}. Set publish_enabled: true on an active Telegram account in accounts.json.`);
    }
  }
}

const RETRYABLE_STATUSES = ['draft', 'failed'];

function isPublishTarget(entry) {
  return entry.platform === 'telegram' && entry.active !== false && entry.archive !== true && entry.publish_enabled === true;
}

function validateRequestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('request_id must contain 1 to 128 letters, digits, underscores or hyphens. Reuse it for retries of the same publication.');
  }
}

function formatDraft(row) {
  return {
    request_id: row.request_id,
    account: row.account,
    text: row.text,
    disable_preview: Boolean(row.disable_preview),
    content_hash: row.content_hash,
    status: row.status,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
    error: row.error ?? null,
    ...(row.status === 'sending' || row.status === 'unknown' ? {
      next_action: 'Check this channel in Telegram before taking any further action. This request will not be sent again automatically. Do not create a new request to retry it blindly.',
    } : {}),
    ...(row.status === 'failed' ? {
      next_action: 'Telegram rejected this post, so it was not published. Fix the cause in error, then call telegram_post_publish again with the same request_id.',
    } : {}),
  };
}
