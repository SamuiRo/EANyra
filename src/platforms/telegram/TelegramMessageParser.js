const PUBLIC_CHANNEL_RE = /^[a-z][a-z0-9_]{4,31}$/i;

export function parseTelegramMessage(message, { username } = {}) {
  if (!isTelegramContentMessage(message)) return null;

  const text      = message.message ?? message.text ?? '';
  const channel   = normalizeTelegramChannel(username);
  const messageId = String(message.id);
  const postedAt  = normalizeTelegramDate(message.date);

  return {
    platform:    'telegram',
    platform_id: `${channel}:${messageId}`,
    text,
    lang:        null,
    posted_at:   postedAt,
    media_urls:  [],
    shared_url:  extractSharedUrl(message, text),
    raw_url:     buildTelegramMessageUrl(channel, messageId),
    likes:       reactionCount(message),
    reposts:     numberOrZero(message.forwards),
    replies:     numberOrZero(message.replies?.replies),
    views:       numberOrNull(message.views),
    is_repost:   Boolean(message.fwdFrom),
    is_reply:    Boolean(message.replyTo?.replyToMsgId),
    visibility:  isPublicChannel(channel) ? 'public' : 'private',
    scraped_at:  new Date(),
  };
}

export function isTelegramContentMessage(message) {
  if (!message || message.id === undefined || message.id === null) return false;
  if (classNameOf(message) === 'MessageService') return false;

  const text = message.message ?? message.text ?? '';
  return Boolean(text.trim() || message.media || message.views !== undefined);
}

export function normalizeTelegramDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? normalizeTelegramDate(asNumber) : null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return new Date(value < 1_000_000_000_000 ? value * 1_000 : value);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeTelegramChannel(value) {
  const raw = String(value ?? '').trim().replace(/^@/, '');

  const privateUrl = raw.match(/^(?:https?:\/\/)?t\.me\/c\/(\d+)/i);
  if (privateUrl) return `-100${privateUrl[1]}`;

  const publicUrl = raw.match(/^(?:https?:\/\/)?t\.me\/(?:s\/)?([^/?#]+)/i);
  if (publicUrl) return publicUrl[1].replace(/^@/, '').toLowerCase();

  return raw.toLowerCase();
}

export function buildTelegramMessageUrl(channel, messageId) {
  if (/^-100\d+$/.test(channel)) {
    return `https://t.me/c/${channel.slice(4)}/${messageId}`;
  }

  if (isPublicChannel(channel)) {
    return `https://t.me/${channel}/${messageId}`;
  }

  return null;
}

function extractSharedUrl(message, text) {
  const webpageUrl = message.media?.webpage?.url ?? message.media?.webpage?.displayUrl;
  if (webpageUrl) return webpageUrl;

  for (const entity of message.entities ?? []) {
    const className = classNameOf(entity);

    if (className === 'MessageEntityTextUrl' && entity.url) {
      return entity.url;
    }

    if (className === 'MessageEntityUrl') {
      const url = text.slice(entity.offset, entity.offset + entity.length).trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
  }

  const bareUrl = text.match(/https?:\/\/\S+/i);
  return bareUrl?.[0] ?? null;
}

function reactionCount(message) {
  return (message.reactions?.results ?? []).reduce(
    (sum, reaction) => sum + numberOrZero(reaction.count),
    0,
  );
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isPublicChannel(channel) {
  return PUBLIC_CHANNEL_RE.test(channel);
}

function classNameOf(value) {
  return value?.className ?? value?.constructor?.name ?? '';
}
