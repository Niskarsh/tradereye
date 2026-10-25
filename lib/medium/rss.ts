/**
 * A small reader for Medium's public RSS feeds (medium.com/feed/tag/<tag>, medium.com/feed/<publication>).
 * Medium's feeds are plain RSS 2.0 with CDATA text; each one holds only the ~10 newest stories and no clap counts.
 * Only what the trend radar needs is kept: no story bodies.
 */

export interface FeedItem {
  /** Medium's story id (the hex id at the end of the guid / link) */
  id: string;
  title: string;
  /** the story link without Medium's ?source=rss tracking */
  url: string;
  author: string;
  /** publish time, ms since epoch (0 when the feed did not say) */
  publishedAt: number;
  /** the story's own tags, lower case slugs (a story has up to 5) */
  tags: string[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .trim();
}

function first(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function all(block: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  for (const m of block.matchAll(re)) out.push(decode(m[1]));
  return out;
}

/** "Trading Strategies" or "trading-strategies" -> "trading-strategies" */
export function tagSlug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Medium story ids are the hex string at the end of the guid (medium.com/p/<id>) or of the link (...-<id>). */
export function storyId(guid: string, link: string): string {
  const fromGuid = guid.match(/\/p\/([0-9a-f]{8,16})(?:[/?#]|$)/i)?.[1];
  if (fromGuid) return fromGuid.toLowerCase();
  const fromLink = link.split(/[?#]/)[0].match(/-([0-9a-f]{8,16})\/?$/i)?.[1];
  return (fromLink ?? '').toLowerCase();
}

export function cleanUrl(link: string): string {
  return link.split('?')[0].split('#')[0];
}

/** Every story in a feed. Items without a title or an id are skipped. */
export function parseRss(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = first(block, 'title').replace(/\s+/g, ' ');
    const link = first(block, 'link');
    const id = storyId(first(block, 'guid'), link);
    if (!title || !id) continue;
    const t = Date.parse(first(block, 'pubDate'));
    const tags = [...new Set(all(block, 'category').map(tagSlug).filter(Boolean))];
    out.push({ id, title, url: cleanUrl(link), author: first(block, 'dc:creator'), publishedAt: Number.isFinite(t) ? t : 0, tags });
  }
  return out;
}
