/**
 * Check normalized records before persistence.
 *
 * Saving is one bulk statement per account, so a single malformed record
 * (e.g. a LinkedIn row without a stable id) used to fail the whole account.
 * Invalid records are now dropped with a reason; valid ones are saved.
 * Recoverable problems are fixed instead (negative counters, overlong titles).
 */

const MAX_PLATFORM_ID = 128;
const MAX_SOURCE_ID = 256;
const MAX_TITLE = 512;

/**
 * @param {object[]} records RawPost[]
 * @param {string}   platform the account's platform
 * @returns {{ valid: object[], rejected: { index: number, reason: string }[] }}
 */
export function validatePosts(records, platform) {
  const byId = new Map();
  const rejected = [];
  records.forEach((record, index) => {
    const reason = postProblem(record, platform);
    if (reason) {
      rejected.push({ index, reason });
      return;
    }
    const id = String(record.platform_id).trim();
    // Later duplicates win, matching the upsert semantics.
    byId.set(id, {
      ...record,
      platform_id: id,
      text: record.text ?? '',
      posted_at: record.posted_at ? new Date(record.posted_at) : null,
      likes: counter(record.likes, 0),
      reposts: counter(record.reposts, 0),
      replies: counter(record.replies, 0),
      views: counter(record.views, null),
    });
  });
  return { valid: [...byId.values()], rejected };
}

/**
 * @param {object[]} records RawSignal[]
 * @returns {{ valid: object[], rejected: { index: number, reason: string }[] }}
 */
export function validateSignals(records) {
  const byId = new Map();
  const rejected = [];
  records.forEach((record, index) => {
    const reason = signalProblem(record);
    if (reason) {
      rejected.push({ index, reason });
      return;
    }
    const title = String(record.title).trim();
    byId.set(`${record.source}\u0000${record.source_id}`, {
      ...record,
      title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
      occurred_at: record.occurred_at ? new Date(record.occurred_at) : null,
    });
  });
  return { valid: [...byId.values()], rejected };
}

/** "2 skipped: missing platform_id (×2)" style summary for run reports. */
export function describeRejected(rejected) {
  if (!rejected.length) return null;
  const counts = new Map();
  for (const { reason } of rejected) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const reasons = [...counts].map(([reason, count]) => (count > 1 ? `${reason} (×${count})` : reason)).join('; ');
  return `Skipped ${rejected.length} invalid record(s): ${reasons}`;
}

function postProblem(record, platform) {
  if (!record || typeof record !== 'object') return 'not an object';
  if (record.platform !== platform) return `platform "${record.platform}" does not match the account (${platform})`;
  const id = record.platform_id;
  if (id === null || id === undefined || (typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) {
    return 'missing platform_id';
  }
  if (String(id).trim().length > MAX_PLATFORM_ID) return 'platform_id too long';
  if (record.text !== undefined && record.text !== null && typeof record.text !== 'string') return 'text is not a string';
  if (record.posted_at && Number.isNaN(new Date(record.posted_at).getTime())) return 'invalid posted_at';
  return null;
}

function signalProblem(record) {
  if (!record || typeof record !== 'object') return 'not an object';
  for (const field of ['source', 'source_id', 'signal_type']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) return `missing ${field}`;
  }
  if (record.source_id.length > MAX_SOURCE_ID) return 'source_id too long';
  if (record.title === null || record.title === undefined || !String(record.title).trim()) return 'missing title';
  if (record.occurred_at && Number.isNaN(new Date(record.occurred_at).getTime())) return 'invalid occurred_at';
  return null;
}

function counter(value, fallback) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}
