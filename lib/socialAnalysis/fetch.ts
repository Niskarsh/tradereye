/**
 * Reads how each Short / Reel did, from YouTube and Instagram. Network only; collect.ts decides what to read and saves it.
 *
 * YouTube has two sources: the Data API (views, likes, comments, nearly live, needs no new permission) and the Analytics
 * API (watch time, retention, shares, subscribers; 2-3 days behind, needs yt-analytics.readonly).
 * Instagram gives lifetime totals only, up to 48 hours behind, so its history exists only because we save a copy daily.
 * A number a platform does not give stays undefined. It is never turned into 0.
 */

const DATA_API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';
const GRAPH = 'https://graph.instagram.com';

export class MetricsError extends Error {
  constructor(message: string, public status = 0, public code = 0) { super(message); }
}

const num = (x: unknown): number | undefined => {
  if (x === null || x === undefined || x === '') return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};

async function failure(res: Response, what: string): Promise<MetricsError> {
  const j = await res.json().catch(() => ({})) as { error?: { message?: string; code?: number } };
  return new MetricsError(`${what}: ${j.error?.message ?? `HTTP ${res.status}`}`, res.status, j.error?.code ?? 0);
}

/** "PT1M2S" -> 62. */
export function isoSeconds(d: string | undefined): number | undefined {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d ?? '');
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : undefined;
}

export interface YtLive { views?: number; likes?: number; comments?: number; durationSec?: number; privacy: string }

/** Nearly live counts, any number of videos. A video missing from the answer was deleted on YouTube. */
export async function youtubeLive(token: string, ids: string[], f: typeof fetch = fetch): Promise<Record<string, YtLive>> {
  const out: Record<string, YtLive> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const q = new URLSearchParams({ part: 'statistics,contentDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
    const res = await f(`${DATA_API}/videos?${q}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!res.ok) throw await failure(res, 'Reading YouTube counts');
    const j = await res.json() as { items?: { id: string; statistics?: Record<string, string>; contentDetails?: { duration?: string }; status?: { privacyStatus?: string } }[] };
    for (const v of j.items ?? []) {
      out[v.id] = { views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount), durationSec: isoSeconds(v.contentDetails?.duration), privacy: v.status?.privacyStatus ?? '' };
    }
  }
  return out;
}

export interface YtStats {
  views?: number; engagedViews?: number; minutes?: number; avgSec?: number; avgPct?: number;
  likes?: number; comments?: number; shares?: number; subsGained?: number; subsLost?: number;
}
const YT_FIELD: Record<string, keyof YtStats> = {
  views: 'views', engagedViews: 'engagedViews', estimatedMinutesWatched: 'minutes', averageViewDuration: 'avgSec', averageViewPercentage: 'avgPct',
  likes: 'likes', comments: 'comments', shares: 'shares', subscribersGained: 'subsGained', subscribersLost: 'subsLost',
};
const YT_ALL = Object.keys(YT_FIELD).join(',');
/** engagedViews and averageViewPercentage are the two YouTube may refuse in a combination: asked again without them. */
const YT_CORE = 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost';

interface AnalyticsTable { columnHeaders?: { name: string }[]; rows?: (string | number)[][] }

async function report(token: string, p: Record<string, string>, f: typeof fetch): Promise<AnalyticsTable | Response> {
  const res = await f(`${ANALYTICS_API}?${new URLSearchParams({ ids: 'channel==MINE', ...p })}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  return res.ok ? await res.json() as AnalyticsTable : res;
}

/** One video's totals from its publish day to today. Undefined while YouTube has nothing yet for it. */
export async function youtubeStats(token: string, videoId: string, startDate: string, endDate: string, f: typeof fetch = fetch): Promise<YtStats | undefined> {
  const base = { startDate, endDate, filters: `video==${videoId}` };
  let t = await report(token, { ...base, metrics: YT_ALL }, f);
  if (t instanceof Response && t.status === 400) t = await report(token, { ...base, metrics: YT_CORE }, f);
  if (t instanceof Response) throw await failure(t, 'Reading YouTube Analytics');
  const row = t.rows?.[0];
  if (!row) return undefined;
  const out: YtStats = {};
  (t.columnHeaders ?? []).forEach((h, i) => { const k = YT_FIELD[h.name]; if (k) out[k] = num(row[i]); });
  return out;
}

/** [share of the video elapsed 0-1, viewers still watching (1 = all; over 1 = rewatched), against similar videos 0-1 or null]. */
export type RetentionPoint = [number, number, number | null];

/** The retention curve (up to 100 points). One video per request: YouTube does not allow a list here. */
export async function youtubeRetention(token: string, videoId: string, startDate: string, endDate: string, f: typeof fetch = fetch): Promise<RetentionPoint[]> {
  const t = await report(token, { startDate, endDate, dimensions: 'elapsedVideoTimeRatio', metrics: 'audienceWatchRatio,relativeRetentionPerformance', filters: `video==${videoId}` }, f);
  if (t instanceof Response) throw await failure(t, 'Reading YouTube retention');
  const at = (name: string) => (t.columnHeaders ?? []).findIndex((h) => h.name === name);
  const [x, w, r] = [at('elapsedVideoTimeRatio'), at('audienceWatchRatio'), at('relativeRetentionPerformance')];
  if (x < 0 || w < 0) return [];
  return (t.rows ?? []).map((row): RetentionPoint => [Number(row[x]), Number(row[w]), r >= 0 ? num(row[r]) ?? null : null]).sort((a, b) => a[0] - b[0]);
}

export interface IgStats {
  views?: number; reach?: number; likes?: number; comments?: number; shares?: number; saved?: number; reposts?: number;
  interactions?: number; avgWatchSec?: number; totalWatchSec?: number; skipPct?: number;
}
const IG_ALL = 'views,reach,likes,comments,shares,saved,reposts,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate';
/** Meta marks several of the others "in development": one refused metric fails the whole request, so this is the fallback. */
const IG_CORE = 'views,reach,likes,comments,shares,saved';

async function igCall(url: string, what: string, f: typeof fetch): Promise<Record<string, unknown>> {
  const res = await f(url, { cache: 'no-store' });
  if (!res.ok) throw await failure(res, what);
  return await res.json() as Record<string, unknown>;
}

type IgRow = { name: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } };

export function parseIgInsights(rows: IgRow[]): IgStats {
  const v: Record<string, number | undefined> = {};
  for (const r of rows) v[r.name] = num(r.values?.[0]?.value ?? r.total_value?.value);
  const sec = (ms: number | undefined) => (ms === undefined ? undefined : ms / 1000);
  const skip = v.reels_skip_rate;
  return {
    views: v.views, reach: v.reach, likes: v.likes, comments: v.comments, shares: v.shares, saved: v.saved, reposts: v.reposts, interactions: v.total_interactions,
    avgWatchSec: sec(v.ig_reels_avg_watch_time), totalWatchSec: sec(v.ig_reels_video_view_total_time),
    // Meta does not say whether this is 0.45 or 45; a real skip rate under 1% is not believable, so a value <= 1 is a fraction
    skipPct: skip === undefined ? undefined : skip <= 1 ? skip * 100 : skip,
  };
}

/** One Reel's lifetime totals. A dead token (190) is not retried; anything else is tried once with the plain metrics. */
export async function instagramStats(token: string, mediaId: string, f: typeof fetch = fetch): Promise<IgStats> {
  const url = (metric: string) => `${GRAPH}/${mediaId}/insights?${new URLSearchParams({ metric, access_token: token })}`;
  let j: Record<string, unknown>;
  try { j = await igCall(url(IG_ALL), 'Reading Instagram numbers', f); }
  catch (e) {
    if ((e as MetricsError).code === 190) throw e;
    j = await igCall(url(IG_CORE), 'Reading Instagram numbers', f);
  }
  return parseIgInsights((j.data ?? []) as IgRow[]);
}

export interface Account { youtubeSubs?: number; youtubeViews?: number; igFollowers?: number }

export async function youtubeAccount(token: string, f: typeof fetch = fetch): Promise<Pick<Account, 'youtubeSubs' | 'youtubeViews'>> {
  const res = await f(`${DATA_API}/channels?part=statistics&mine=true`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) throw await failure(res, 'Reading the channel');
  const s = ((await res.json()) as { items?: { statistics?: Record<string, string> }[] }).items?.[0]?.statistics;
  return { youtubeSubs: num(s?.subscriberCount), youtubeViews: num(s?.viewCount) };
}

export async function instagramAccount(token: string, f: typeof fetch = fetch): Promise<Pick<Account, 'igFollowers'>> {
  const j = await igCall(`${GRAPH}/me?${new URLSearchParams({ fields: 'followers_count', access_token: token })}`, 'Reading the Instagram account', f);
  return { igFollowers: num(j.followers_count) };
}
