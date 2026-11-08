import { youtubeState, type PlatformPost, type Posts } from '../shorts/posts';
import type { ShortSpec } from '../shorts/spec';
import type { ShortItem } from '../shorts/store';
import type { WrittenText } from '../shorts/write';
import type { Facts, MetricsFile } from './analyze';

/** Which posts the pull follows, and what we know about each one (pure). */

const DAY = 86_400_000;
/** Numbers stop moving; an older post is left as it was last seen. */
export const FOLLOW_DAYS = 90;

export function factsOf(item: ShortItem | undefined, spec: ShortSpec | undefined, text: WrittenText | { error: string } | undefined, old?: Facts): Facts {
  const words = text && 'youtube' in text ? text : undefined;
  const c = spec?.content;
  const r = c?.kind === 'mystery' ? c.panel.result.value : undefined;
  const outcome: Facts['outcome'] = c?.kind === 'vs' ? c.week.winner : r === undefined ? old?.outcome ?? 'none' : r < 0 ? 'loss' : 'win';
  return {
    label: item?.label ?? old?.label ?? '', kind: c?.kind ?? item?.kind ?? old?.kind ?? 'mystery', outcome,
    resultR: r !== undefined && c?.kind === 'mystery' && c.panel.result.unit === 'R' ? r : old?.resultR,
    title: words?.youtube.title ?? old?.title,
    captionHook: words?.instagram.caption.split('\n')[0]?.slice(0, 160) ?? old?.captionHook,
    tell: (c?.kind === 'mystery' ? c.tell : undefined) ?? old?.tell,
  };
}

export const isLive = (p: PlatformPost | undefined, id: string | undefined, yt: boolean, now: number) => !!p && !!id && (yt ? youtubeState(p, now) === 'live' : p.state === 'live') && p.at <= now;

/** Which posts are followed: published, under FOLLOW_DAYS old; the ones longest without a fresh number first. */
export function toFollow(posts: Posts, file: MetricsFile, now: number): string[] {
  const recent = (p?: PlatformPost) => !!p && now - p.at < FOLLOW_DAYS * DAY;
  const wanted = Object.keys(posts).filter((id) => {
    const { youtube: y, instagram: g } = posts[id];
    return (isLive(y, y?.videoId, true, now) && recent(y)) || (isLive(g, g?.mediaId, false, now) && recent(g));
  });
  const seen = (id: string) => file.posts[id]?.points.at(-1)?.at ?? 0;
  return wanted.sort((a, b) => seen(a) - seen(b));
}
