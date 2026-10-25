import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, storyId, tagSlug } from '../lib/medium/rss';
import { collect, emptyIndex, merge, prune, trends, POSTS_KEY, RUNS_KEY, type FeedSource, type PostIndex, type RunLog } from '../lib/medium/collect';
import { getJson, type Store } from '../lib/setups/store';
import { cronCheck } from '../lib/auth/cron';
import { gate } from '../lib/auth/gate';

const DAY = 86_400_000;

function item(id: string, title: string, tags: string[], pub = 'Sat, 24 Oct 2026 10:00:00 GMT') {
  return `<item><title><![CDATA[${title}]]></title><link>https://medium.com/@someone/a-story-${id}?source=rss------day_trading-5</link>` +
    `<guid isPermaLink="false">https://medium.com/p/${id}</guid>${tags.map((t) => `<category><![CDATA[${t}]]></category>`).join('')}` +
    `<dc:creator><![CDATA[Some Writer]]></dc:creator><pubDate>${pub}</pubDate><atom:updated>2026-10-24T10:05:00.000Z</atom:updated></item>`;
}
const rss = (items: string[]) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Day Trading on Medium</title>${items.join('')}</channel></rss>`;

function memStore(): Store & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, get: async (k) => files.get(k), put: async (k, b) => { files.set(k, b); } };
}

test('RSS: reads title, id, clean link, author, time and tags; skips broken items', () => {
  const xml = rss([
    item('1a2b3c4d5e6f', 'I Let a Bot Trade &amp; Lost', ['Day Trading', 'algorithmic-trading', 'day-trading']),
    '<item><title>No id here</title><link>https://example.com/x</link></item>',
  ]);
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: '1a2b3c4d5e6f', title: 'I Let a Bot Trade & Lost', url: 'https://medium.com/@someone/a-story-1a2b3c4d5e6f',
    author: 'Some Writer', publishedAt: Date.parse('Sat, 24 Oct 2026 10:00:00 GMT'), tags: ['day-trading', 'algorithmic-trading'],
  });
  assert.equal(tagSlug('Stock Market'), 'stock-market');
  assert.equal(storyId('', 'https://medium.com/pub/my-post-abc123def456?source=rss'), 'abc123def456');
});

test('merge: a story is stored once, first-seen time never changes, every feed that showed it is kept', () => {
  const idx = emptyIndex();
  const a = parseRss(rss([item('aaaaaaaaaaaa', 'A', ['trading'])]));
  assert.equal(merge(idx, 'tag/trading', a, 1000), 1);
  assert.equal(merge(idx, 'tag/day-trading', a, 2000), 0);
  assert.equal(idx.posts.aaaaaaaaaaaa.firstSeen, 1000);
  assert.deepEqual(idx.posts.aaaaaaaaaaaa.seenIn, ['tag/trading', 'tag/day-trading']);
});

test('prune: stories older than 90 days go', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const idx: PostIndex = { v: 1, posts: {
    old: { title: 'o', url: '', author: '', publishedAt: now - 91 * DAY, tags: [], seenIn: [], firstSeen: now },
    recent: { title: 'r', url: '', author: '', publishedAt: now - 10 * DAY, tags: [], seenIn: [], firstSeen: now },
  } };
  assert.equal(prune(idx, now), 1);
  assert.deepEqual(Object.keys(idx.posts), ['recent']);
});

test('collect: saves stories and a run log, records failing feeds, flags a feed whose stories were all new', async () => {
  const store = memStore();
  const feeds: FeedSource[] = [{ kind: 'tag', slug: 'trading' }, { kind: 'tag', slug: 'nope' }];
  let round = 1;
  const fetchImpl = async (url: string) => {
    if (url.endsWith('/tag/nope')) return new Response('not found', { status: 404 });
    const ids = round === 1 ? ['111111111111', '222222222222'] : ['333333333333', '444444444444'];
    return new Response(rss(ids.map((id) => item(id, `Story ${id}`, ['trading']))), { status: 200 });
  };
  const now = Date.parse('2026-10-25T06:00:00Z');
  const r1 = await collect(store, { feeds, fetchImpl, now });
  assert.equal(r1.newPosts, 2);
  assert.deepEqual(r1.feeds[0], { feed: 'tag/trading', items: 2, fresh: 2, full: false }); // first run: nothing to compare with
  assert.equal(r1.feeds[1].error, 'HTTP 404');
  round = 2;
  const r2 = await collect(store, { feeds, fetchImpl, now: now + 3 * 3600_000 });
  assert.equal(r2.feeds[0].full, true); // all new -> some may have been missed
  const idx = await getJson<PostIndex>(store, POSTS_KEY);
  assert.equal(Object.keys(idx!.posts).length, 4);
  const log = await getJson<RunLog>(store, RUNS_KEY);
  assert.equal(log!.runs.length, 2);
  assert.equal(log!.runs[0].at, now + 3 * 3600_000);
});

test('trends: not ready without a baseline; with history, a tag written about more than usual surges', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const idx = emptyIndex();
  let n = 0;
  const add = (daysAgo: number, tags: string[]) => {
    const id = (++n).toString(16).padStart(12, '0');
    idx.posts[id] = { title: id, url: '', author: '', publishedAt: now - daysAgo * DAY, tags, seenIn: [], firstSeen: now - daysAgo * DAY };
  };
  for (let i = 0; i < 3; i++) for (let w = 1; w <= 3; w++) add(7 * w + 2, ['trading']); // 3 a week before
  for (let i = 0; i < 2; i++) for (let w = 1; w <= 3; w++) add(7 * w + 2, ['ai']);      // 2 a week before
  for (let i = 0; i < 3; i++) add(2, ['trading']);                                        // same as usual
  for (let i = 0; i < 8; i++) add(3, ['ai', 'trading']);                                  // ai jumps

  const early = trends(idx, now - 5 * DAY, now);
  assert.equal(early.ready, false);
  assert.ok(early.tags.every((t) => t.surge === null));

  const t = trends(idx, now - 30 * DAY, now);
  assert.equal(t.ready, true);
  assert.equal(t.tags[0].tag, 'ai');
  assert.equal(t.tags[0].lastWeek, 8);
  assert.equal(t.tags[0].before, 2);
  assert.equal(t.tags[0].surge, 4);
});

test('collector endpoint: public path, but only with the CRON_SECRET', () => {
  assert.equal(gate('/api/medium/collect', false), 'allow');
  assert.equal(gate('/api/medium/status', false), 'deny-api');
  const env = { CRON_SECRET: 'x'.repeat(32) };
  const req = (auth?: string) => new Request('https://t/api/medium/collect', { method: 'POST', headers: auth ? { authorization: auth } : {} });
  assert.equal(cronCheck(req(`Bearer ${'x'.repeat(32)}`), env), 'ok');
  assert.equal(cronCheck(req('Bearer wrong'), env), 'denied');
  assert.equal(cronCheck(req(), env), 'denied');
  assert.equal(cronCheck(req(`Bearer ${'x'.repeat(32)}`), { CRON_SECRET: 'short' }), 'unset');
});
