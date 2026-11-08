import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramStats, isoSeconds, parseIgInsights, youtubeStats, youtubeRetention } from '../lib/socialAnalysis/fetch';
import { addPoint, findings, groupsOf, MATURE_DAYS, MIN_PER_SIDE, readRetention, toRow, type Facts, type Point, type PostMetrics } from '../lib/socialAnalysis/analyze';
import { factsOf, toFollow } from '../lib/socialAnalysis/follow';
import { readMessage, toRead } from '../lib/socialAnalysis/prompt';
import { canAnalyse, YOUTUBE_SCOPES } from '../lib/social/youtube';
import type { Posts } from '../lib/shorts/posts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8, 2);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('scopes: analytics is asked for, and an older connection is recognised as lacking it', () => {
  assert.equal(canAnalyse(YOUTUBE_SCOPES.join(' ')), true);
  assert.equal(canAnalyse('https://www.googleapis.com/auth/youtube.readonly'), false);
  assert.equal(canAnalyse(undefined), false);
});

test('durations', () => {
  assert.equal(isoSeconds('PT1M2S'), 62);
  assert.equal(isoSeconds('PT45S'), 45);
  assert.equal(isoSeconds('nope'), undefined);
});

test('Instagram: reads both answer shapes, ms to seconds, skip rate as a percent, missing stays missing', () => {
  const s = parseIgInsights([
    { name: 'views', values: [{ value: 120 }] }, { name: 'reach', total_value: { value: 90 } },
    { name: 'ig_reels_avg_watch_time', values: [{ value: 7500 }] }, { name: 'reels_skip_rate', values: [{ value: 0.42 }] },
  ]);
  assert.deepEqual([s.views, s.reach, s.avgWatchSec], [120, 90, 7.5]);
  assert.ok(Math.abs(s.skipPct! - 42) < 1e-9);
  assert.equal(parseIgInsights([{ name: 'reels_skip_rate', values: [{ value: 42 }] }]).skipPct, 42);
  assert.equal(s.saved, undefined);
});

test('Instagram: a refused metric falls back to the plain set; a dead token does not retry', async () => {
  const urls: string[] = [];
  const f = (async (u: string) => {
    urls.push(u);
    return u.includes('reels_skip_rate') ? json({ error: { message: 'bad metric', code: 100 } }, 400) : json({ data: [{ name: 'views', values: [{ value: 5 }] }] });
  }) as unknown as typeof fetch;
  assert.equal((await instagramStats('t', 'm', f)).views, 5);
  assert.equal(urls.length, 2);
  let calls = 0;
  const dead = (async () => { calls++; return json({ error: { message: 'expired', code: 190 } }, 400); }) as unknown as typeof fetch;
  await assert.rejects(instagramStats('t', 'm', dead));
  assert.equal(calls, 1);
});

test('YouTube Analytics: columns matched by name, 400 retries the core metrics, no rows = undefined', async () => {
  const seen: string[] = [];
  const f = (async (u: string) => {
    const metrics = new URL(u).searchParams.get('metrics')!;
    seen.push(metrics);
    return metrics.includes('engagedViews') ? json({ error: { message: 'bad combo' } }, 400)
      : json({ columnHeaders: [{ name: 'views' }, { name: 'subscribersGained' }, { name: 'averageViewDuration' }], rows: [[1000, 4, 12.5]] });
  }) as unknown as typeof fetch;
  const s = await youtubeStats('t', 'v', '2026-11-01', '2026-11-08', f);
  assert.deepEqual([s?.views, s?.subsGained, s?.avgSec, s?.avgPct], [1000, 4, 12.5, undefined]);
  assert.equal(seen.length, 2);
  assert.equal(await youtubeStats('t', 'v', 'a', 'b', (async () => json({ columnHeaders: [], rows: [] })) as unknown as typeof fetch), undefined);
});

test('YouTube retention: sorted by time, asks for one video', async () => {
  let q: URLSearchParams | undefined;
  const f = (async (u: string) => { q = new URL(u).searchParams; return json({ columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }, { name: 'relativeRetentionPerformance' }], rows: [[0.2, 0.5, 0.4], [0.1, 0.9, 0.6]] }); }) as unknown as typeof fetch;
  assert.deepEqual(await youtubeRetention('t', 'abc', 'a', 'b', f), [[0.1, 0.9, 0.6], [0.2, 0.5, 0.4]]);
  assert.equal(q!.get('filters'), 'video==abc');
});

test('one point per IST day; the later pull wins but keeps what it lacks', () => {
  const d1 = Date.UTC(2026, 10, 1, 2), same = d1 + 3_600_000, next = d1 + DAY;
  let p: Point[] = addPoint([], { at: d1, instagram: { views: 1 } });
  p = addPoint(p, { at: same, youtube: { views: 2, privacy: 'public' } });
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].instagram?.views, p[0].youtube?.views], [1, 2]);
  assert.equal(addPoint(p, { at: next }).length, 2);
});

test('retention read: 3s, end, and where it falls fastest', () => {
  const curve = Array.from({ length: 101 }, (_, i): [number, number, null] => { const x = i / 100; return [x, x < 0.5 ? 1 : x < 0.6 ? 1 - (x - 0.5) * 5 : 0.5, null]; });
  const r = readRetention(curve, 40)!;
  assert.ok(Math.abs(r.at3s! - 1) < 1e-9);
  assert.equal(r.atEnd, 0.5);
  assert.ok(r.steepestAtSec! >= 18 && r.steepestAtSec! <= 22, String(r.steepestAtSec));
  assert.equal(readRetention(undefined, 40), undefined);
});

const facts = (kind: Facts['kind'], outcome: Facts['outcome']): Facts => ({ label: 'RELIANCE long', kind, outcome, title: 'Long or short here?' });
function post(id: string, kind: Facts['kind'], outcome: Facts['outcome'], ageDays: number, views: number, avgPct = 50): PostMetrics {
  const at = NOW - ageDays * DAY;
  return {
    id, facts: facts(kind, outcome), youtube: { videoId: id, at },
    points: [{ at: NOW, youtube: { views, privacy: 'public', durationSec: 40, stats: { avgPct, views } } }],
  };
}

test('views at day 7 are preferred over the latest figure; a young post is not mature', () => {
  const at = NOW - 20 * DAY;
  const p: PostMetrics = { id: 'a', facts: facts('mystery', 'win'), youtube: { videoId: 'a', at }, points: [
    { at: at + 7 * DAY, youtube: { views: 100, privacy: 'public' } }, { at: NOW, youtube: { views: 900, privacy: 'public' } },
  ] };
  const y = toRow(p, NOW).youtube!;
  assert.deepEqual([y.viewsDay7, y.views, y.mature], [100, 900, true]);
  assert.equal(toRow(post('b', 'vs', 'me', MATURE_DAYS - 1, 5), NOW).youtube!.mature, false);
});

test('groups ignore young posts; medians resist one outlier', () => {
  const rows = [post('a', 'mystery', 'win', 10, 100), post('b', 'mystery', 'win', 10, 200), post('c', 'mystery', 'loss', 10, 90000), post('d', 'mystery', 'win', 1, 777777)].map((p) => toRow(p, NOW));
  const g = groupsOf(rows).find((x) => x.key === 'mystery')!;
  assert.equal(g.youtube.n, 3);
  assert.equal(g.youtube.views, 200);
});

test('findings: nothing below the post minimum, even with a huge gap; a real gap above it is named', () => {
  const make = (kind: Facts['kind'], outcome: Facts['outcome'], count: number, views: number) => Array.from({ length: count }, (_, i) => post(`${kind}${i}`, kind, outcome, 10, views));
  const few = [...make('mystery', 'win', MIN_PER_SIDE - 1, 1000), ...make('vs', 'me', MIN_PER_SIDE, 10)].map((p) => toRow(p, NOW));
  assert.deepEqual(findings(groupsOf(few)), []);
  const enough = [...make('mystery', 'win', MIN_PER_SIDE, 1000), ...make('vs', 'me', MIN_PER_SIDE, 500)].map((p) => toRow(p, NOW));
  const f = findings(groupsOf(enough)).find((x) => x.metric === 'views')!;
  assert.deepEqual([f.platform, f.better, f.gapPct], ['YouTube', 'Mystery chart', 50]);
  const close = [...make('mystery', 'win', MIN_PER_SIDE, 1000), ...make('vs', 'me', MIN_PER_SIDE, 900)].map((p) => toRow(p, NOW));
  assert.equal(findings(groupsOf(close)).filter((x) => x.metric === 'views').length, 0);
});

test('which posts are followed: only live, under 90 days; longest unseen first', () => {
  const posts: Posts = {
    live1: { youtube: { at: NOW - DAY, state: 'scheduled', updatedAt: 0, videoId: 'v1' } },
    live2: { instagram: { at: NOW - DAY, state: 'live', updatedAt: 0, mediaId: 'm' } },
    future: { youtube: { at: NOW + DAY, state: 'scheduled', updatedAt: 0, videoId: 'v2' } },
    waiting: { instagram: { at: NOW - DAY, state: 'processing', updatedAt: 0, containerId: 'c' } },
    old: { youtube: { at: NOW - 100 * DAY, state: 'live', updatedAt: 0, videoId: 'v3' } },
  };
  const file = { v: 1 as const, updatedAt: 0, account: [], posts: { live1: { id: 'live1', facts: facts('mystery', 'win'), points: [{ at: NOW - DAY }] } } };
  assert.deepEqual(toFollow(posts, file, NOW), ['live2', 'live1']);
});

test('facts: win / loss from the result, the week winner for Me vs Algo', () => {
  const mystery = (value: number) => ({ content: { kind: 'mystery', tell: 'x', panel: { result: { value, unit: 'R' } } } }) as never;
  assert.equal(factsOf(undefined, mystery(-1), undefined).outcome, 'loss');
  assert.equal(factsOf(undefined, mystery(2), undefined).resultR, 2);
  assert.equal(factsOf(undefined, { content: { kind: 'vs', week: { winner: 'algo' } } } as never, undefined).outcome, 'algo');
});

test('the message to Claude has the numbers and never the journal label (it can name the stock)', () => {
  const msg = readMessage([post('a', 'mystery', 'win', 10, 100)].map((p) => toRow(p, NOW)));
  assert.match(msg, /YouTube 1, Instagram 0/);
  assert.match(msg, /none yet/);
  assert.ok(!msg.includes('RELIANCE'));
});

test('Claude\'s answer is trimmed to three lines and a safe confidence', () => {
  const r = toRead({ call: 'x', confidence: 'sure', why: ['1', '2', '3', '4'], next_test: { change: 'c', posts: 4 } });
  assert.deepEqual([r.confidence, r.why.length, r.next_test.posts, r.keep.length], ['low', 3, 4, 0]);
});
