import type { IgStats, RetentionPoint, YtLive, YtStats } from './fetch';

/**
 * Turns the saved numbers into what the Analysis page shows. Pure (no network).
 *
 * A post counts in any comparison only once it is 7 days old: a two-day-old Short has not finished being shown. Views
 * are read at day 7 (or the latest figure, for a post older than our first pull). Group figures are medians, because one
 * post that takes off would drag an average with it.
 */

export const MATURE_DAYS = 7;
/** Below this many grown-up posts on each side, a difference between two groups is noise and is called that. */
export const MIN_PER_SIDE = 5;
/** ...and the gap has to be at least this big (25%). */
export const CLEAR_GAP = 0.25;
const DAY = 86_400_000;

export interface YtPoint extends YtLive { stats?: YtStats }
export interface Point { at: number; youtube?: YtPoint; instagram?: IgStats }
export interface Facts {
  label: string; kind: 'mystery' | 'vs'; outcome: 'win' | 'loss' | 'me' | 'algo' | 'tie' | 'none';
  resultR?: number; title?: string; captionHook?: string; tell?: string;
}
export interface PostMetrics {
  id: string; facts: Facts; points: Point[];
  youtube?: { videoId: string; at: number; url?: string; retention?: RetentionPoint[] };
  instagram?: { mediaId: string; at: number; url?: string };
}
export interface AccountPoint { at: number; youtubeSubs?: number; youtubeViews?: number; igFollowers?: number }
export interface LastRun { at: number; source: 'timer' | 'manual'; pulled: number; failed: number; problems: string[]; youtubeAnalytics: boolean }
export interface MetricsFile { v: 1; updatedAt: number; posts: Record<string, PostMetrics>; account: AccountPoint[]; lastRun?: LastRun }

export const emptyFile = (): MetricsFile => ({ v: 1, updatedAt: 0, posts: {}, account: [] });

const istDay = (ms: number) => new Date(ms + 19_800_000).toISOString().slice(0, 10);

/** One point per IST day: a second pull on the same day replaces that day's point, keeping what the new one lacks. */
export function addPoint<T extends { at: number }>(points: T[], next: T, keep = 400): T[] {
  const last = points[points.length - 1];
  if (last && istDay(last.at) === istDay(next.at)) return [...points.slice(0, -1), { ...last, ...next }];
  return [...points, next].slice(-keep);
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rate = (top: number | undefined, base: number | undefined) => (top !== undefined && base ? (top / base) * 1000 : undefined);

/** The last point at most 8.5 days after publishing and at least 6: "views at day 7" when we have one near it. */
function dayN<T>(points: Point[], at: number, pick: (p: Point) => T | undefined): T | undefined {
  let found: T | undefined;
  for (const p of points) {
    const age = (p.at - at) / DAY;
    if (age < MATURE_DAYS - 1 || age > MATURE_DAYS + 1.5) continue;
    const v = pick(p);
    if (v !== undefined) found = v;
  }
  return found;
}

function latest<T>(points: Point[], pick: (p: Point) => T | undefined): T | undefined {
  for (let i = points.length - 1; i >= 0; i--) { const v = pick(points[i]); if (v !== undefined) return v; }
  return undefined;
}

export interface RetentionRead { at3s?: number; atEnd?: number; steepestAtSec?: number; steepestFall?: number }

function interp(curve: RetentionPoint[], x: number): number | undefined {
  if (!curve.length) return undefined;
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (x > curve[i][0]) continue;
    const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
    return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return curve[curve.length - 1][1];
}

/** Still watching at 3 seconds, at the end, and where (in seconds) the audience falls fastest over any 2 seconds. */
export function readRetention(curve: RetentionPoint[] | undefined, durationSec: number | undefined): RetentionRead | undefined {
  if (!curve?.length || !durationSec || durationSec < 5) return undefined;
  const win = 2 / durationSec;
  let steepestAtSec: number | undefined, steepestFall = 0;
  for (const [x] of curve) {
    if (x + win > 1) break;
    const fall = (interp(curve, x) ?? 0) - (interp(curve, x + win) ?? 0);
    if (fall > steepestFall) { steepestFall = fall; steepestAtSec = Math.round(x * durationSec); }
  }
  return { at3s: interp(curve, 3 / durationSec), atEnd: curve[curve.length - 1][1], steepestAtSec, steepestFall: steepestAtSec === undefined ? undefined : steepestFall };
}

export interface YtRow {
  at: number; url?: string; mature: boolean; views?: number; viewsDay7?: number; likes?: number; comments?: number; shares?: number;
  avgSec?: number; avgPct?: number; subs?: number; subsPer1k?: number; durationSec?: number; retention?: RetentionRead; curve?: RetentionPoint[];
}
export interface IgRow {
  at: number; url?: string; mature: boolean; views?: number; viewsDay7?: number; reach?: number; likes?: number; comments?: number; shares?: number; saved?: number;
  avgWatchSec?: number; skipPct?: number; sharesSavesPer1k?: number;
}
export interface Row { id: string; facts: Facts; poster?: string; youtube?: YtRow; instagram?: IgRow }

export function toRow(p: PostMetrics, now: number): Row {
  const row: Row = { id: p.id, facts: p.facts };
  if (p.youtube) {
    const at = p.youtube.at, mature = now - at >= MATURE_DAYS * DAY;
    const durationSec = latest(p.points, (x) => x.youtube?.durationSec);
    const stat = <K extends keyof YtStats>(k: K) => latest(p.points, (x) => x.youtube?.stats?.[k]);
    const views = latest(p.points, (x) => x.youtube?.views), viewsDay7 = dayN(p.points, at, (x) => x.youtube?.views);
    const gained = stat('subsGained'), lost = stat('subsLost');
    const subs = gained === undefined ? undefined : gained - (lost ?? 0);
    const analyticsViews = stat('views');
    row.youtube = {
      at, url: p.youtube.url, mature, views, viewsDay7, durationSec,
      likes: latest(p.points, (x) => x.youtube?.likes), comments: latest(p.points, (x) => x.youtube?.comments), shares: stat('shares'),
      avgSec: stat('avgSec'), avgPct: stat('avgPct'), subs, subsPer1k: rate(subs, analyticsViews ?? views),
      retention: readRetention(p.youtube.retention, durationSec), curve: p.youtube.retention,
    };
  }
  if (p.instagram) {
    const at = p.instagram.at, mature = now - at >= MATURE_DAYS * DAY;
    const stat = <K extends keyof IgStats>(k: K) => latest(p.points, (x) => x.instagram?.[k]);
    const shares = stat('shares'), saved = stat('saved'), reach = stat('reach');
    row.instagram = {
      at, url: p.instagram.url, mature, views: stat('views'), viewsDay7: dayN(p.points, at, (x) => x.instagram?.views),
      reach, likes: stat('likes'), comments: stat('comments'), shares, saved, avgWatchSec: stat('avgWatchSec'), skipPct: stat('skipPct'),
      sharesSavesPer1k: shares === undefined && saved === undefined ? undefined : rate((shares ?? 0) + (saved ?? 0), reach),
    };
  }
  return row;
}

export const viewsToJudge = (x: { viewsDay7?: number; views?: number } | undefined) => x?.viewsDay7 ?? x?.views;

export interface Group {
  key: string; label: string;
  youtube: { n: number; views?: number; avgPct?: number; at3s?: number; subsPer1k?: number };
  instagram: { n: number; views?: number; avgWatchSec?: number; skipPct?: number; sharesSavesPer1k?: number };
}

const GROUPS: { key: string; label: string; test: (f: Facts) => boolean }[] = [
  { key: 'mystery', label: 'Mystery chart', test: (f) => f.kind === 'mystery' },
  { key: 'vs', label: 'Me vs Algo', test: (f) => f.kind === 'vs' },
  { key: 'win', label: 'Mystery: a win', test: (f) => f.kind === 'mystery' && f.outcome === 'win' },
  { key: 'loss', label: 'Mystery: a loss', test: (f) => f.kind === 'mystery' && f.outcome === 'loss' },
];

const pickNums = <T>(xs: T[], f: (x: T) => number | undefined) => xs.map(f).filter((x): x is number => x !== undefined);

export function groupsOf(rows: Row[]): Group[] {
  return GROUPS.map(({ key, label, test }) => {
    const yt = rows.filter((r) => test(r.facts) && r.youtube?.mature).map((r) => r.youtube!);
    const ig = rows.filter((r) => test(r.facts) && r.instagram?.mature).map((r) => r.instagram!);
    return {
      key, label,
      youtube: { n: yt.length, views: median(pickNums(yt, viewsToJudge)), avgPct: median(pickNums(yt, (x) => x.avgPct)), at3s: median(pickNums(yt, (x) => x.retention?.at3s)), subsPer1k: median(pickNums(yt, (x) => x.subsPer1k)) },
      instagram: { n: ig.length, views: median(pickNums(ig, viewsToJudge)), avgWatchSec: median(pickNums(ig, (x) => x.avgWatchSec)), skipPct: median(pickNums(ig, (x) => x.skipPct)), sharesSavesPer1k: median(pickNums(ig, (x) => x.sharesSavesPer1k)) },
    };
  });
}

export interface Finding { platform: 'YouTube' | 'Instagram'; a: string; b: string; metric: string; better: string; gapPct: number }

/** Only differences with enough posts on both sides and a real gap. Empty is the normal answer early on. */
export function findings(groups: Group[]): Finding[] {
  const out: Finding[] = [];
  const pairs: [string, string][] = [['mystery', 'vs'], ['win', 'loss']];
  const by = new Map(groups.map((g) => [g.key, g]));
  const check = (platform: Finding['platform'], a: Group, b: Group, metric: string, va?: number, vb?: number, na = 0, nb = 0, lowerBetter = false) => {
    if (na < MIN_PER_SIDE || nb < MIN_PER_SIDE || va === undefined || vb === undefined) return;
    const hi = Math.max(va, vb), lo = Math.min(va, vb);
    if (!hi || (hi - lo) / hi < CLEAR_GAP) return;
    const aBetter = lowerBetter ? va < vb : va > vb;
    out.push({ platform, a: a.label, b: b.label, metric, better: aBetter ? a.label : b.label, gapPct: Math.round(((hi - lo) / hi) * 100) });
  };
  for (const [ka, kb] of pairs) {
    const a = by.get(ka), b = by.get(kb);
    if (!a || !b) continue;
    const [y1, y2, i1, i2] = [a.youtube, b.youtube, a.instagram, b.instagram];
    check('YouTube', a, b, 'views', y1.views, y2.views, y1.n, y2.n);
    check('YouTube', a, b, 'average watched', y1.avgPct, y2.avgPct, y1.n, y2.n);
    check('Instagram', a, b, 'views', i1.views, i2.views, i1.n, i2.n);
    check('Instagram', a, b, 'skip rate', i1.skipPct, i2.skipPct, i1.n, i2.n, true);
    check('Instagram', a, b, 'shares + saves', i1.sharesSavesPer1k, i2.sharesSavesPer1k, i1.n, i2.n);
  }
  return out;
}

export const matureCount = (rows: Row[]) => ({ youtube: rows.filter((r) => r.youtube?.mature).length, instagram: rows.filter((r) => r.instagram?.mature).length });
