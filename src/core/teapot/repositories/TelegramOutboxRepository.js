import { QueryTypes } from 'sequelize';

export class TelegramOutboxRepository {
  constructor(sequelize) {
    this.sequelize = sequelize;
  }

  async get(requestId) {
    const rows = await this.sequelize.query('SELECT * FROM telegram_outbox WHERE request_id = ?', {
      replacements: [requestId], type: QueryTypes.SELECT,
    });
    if (!rows[0]) throw new Error('Unknown Telegram publication request_id.');
    return rows[0];
  }

  async create(draft) {
    const now = new Date().toISOString();
    await this.sequelize.query(`INSERT INTO telegram_outbox
      (request_id, account, text, content_hash, random_id, disable_preview, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?) ON CONFLICT(request_id) DO NOTHING`, {
      replacements: [draft.request_id, draft.account, draft.text, draft.content_hash,
        draft.random_id, draft.disable_preview ? 1 : 0, now, now],
    });
    const stored = await this.get(draft.request_id);
    if (stored.content_hash !== draft.content_hash) {
      throw new Error('request_id already belongs to different content or a different channel. Use the existing draft or a new request_id for a new publication.');
    }
    return stored;
  }

  async claim(requestId) {
    const [, changed] = await this.sequelize.query(`UPDATE telegram_outbox SET status = 'sending', updated_at = ?
      WHERE request_id = ? AND status IN ('draft', 'failed')`, {
      replacements: [new Date().toISOString(), requestId], type: QueryTypes.UPDATE,
    });
    return changed === 1;
  }

  async sent(requestId, receipt) {
    await this.sequelize.query(`UPDATE telegram_outbox SET status = 'sent', receipt = ?, error = NULL, updated_at = ? WHERE request_id = ?`, {
      replacements: [JSON.stringify(receipt), new Date().toISOString(), requestId],
    });
    return this.get(requestId);
  }

  async failed(requestId, error) {
    await this.sequelize.query(`UPDATE telegram_outbox SET status = 'failed', error = ?, updated_at = ? WHERE request_id = ? AND status = 'sending'`, {
      replacements: [error, new Date().toISOString(), requestId],
    });
    return this.get(requestId);
  }

  async uncertain(requestId, error) {
    await this.sequelize.query(`UPDATE telegram_outbox SET status = 'unknown', error = ?, updated_at = ? WHERE request_id = ? AND status = 'sending'`, {
      replacements: [error, new Date().toISOString(), requestId],
    });
    return this.get(requestId);
  }
}
