/**
 * A small tolerant RSS 2.0 / RSS 1.0 / Atom reader without dependencies.
 * Returns plain text only: markup is stripped, entities decoded. Feed content
 * is untrusted and is never interpreted beyond that.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * @param {string} xml
 * @returns {Array<{ title: string, url: string|null, summary: string|null, published: Date|null }>}
 */
export function parseFeed(xml) {
  if (typeof xml !== 'string') return [];
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = atom ? elements(xml, 'entry') : elements(xml, 'item');
  return blocks.map(block => {
    const title = text(first(block, 'title'));
    const url = atom ? atomLink(block) : (text(first(block, 'link')) || guidLink(block));
    const summary = text(first(block, atom ? 'summary' : 'description') ?? first(block, 'content') ?? first(block, 'content:encoded'));
    const published = date(text(first(block, atom ? 'published' : 'pubDate') ?? first(block, 'updated') ?? first(block, 'dc:date')));
    return { title, url: url || null, summary: summary || null, published };
  }).filter(item => item.title || item.url);
}

function elements(xml, tag) {
  const pattern = new RegExp(`<${escape(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escape(tag)}>`, 'gi');
  return [...xml.matchAll(pattern)].map(match => match[1]);
}

function first(xml, tag) {
  const match = xml.match(new RegExp(`<${escape(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escape(tag)}>`, 'i'));
  return match ? match[1] : null;
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map(match => attributes(match[1]));
  const alternate = links.find(link => !link.rel || link.rel === 'alternate') ?? links[0];
  return alternate?.href ? decode(alternate.href) : null;
}

function guidLink(block) {
  const match = block.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid>/i);
  if (!match || /isPermaLink\s*=\s*["']false["']/i.test(match[1])) return null;
  const value = text(match[2]);
  return /^https?:\/\//i.test(value) ? value : null;
}

function attributes(source) {
  const result = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) result[match[1].toLowerCase()] = match[3] ?? match[4];
  return result;
}

/** Inner XML → plain text: CDATA unwrapped, tags removed, entities decoded, whitespace collapsed. */
export function text(value) {
  if (value === null || value === undefined) return '';
  let result = String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Escaped HTML inside RSS descriptions: decode once, then strip tags.
  result = decode(result.replace(/<[^>]*>/g, ' '));
  return result.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function date(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function escape(tag) {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
