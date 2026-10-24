/**
 * The posting plan for each short: when it goes public on YouTube and on Instagram, and what happened.
 * Pure (no network); lib/shorts/publish.ts does the work.
 *
 * YouTube: uploaded when he presses Schedule, as private with publishAt; YouTube itself makes it public at that time.
 * Instagram: the API cannot schedule or post privately, so tradereye publishes it itself. For every waiting Reel there
 * is one EventBridge Scheduler wake-up (lib/social/scheduler.ts) at its next step; it calls a small Lambda, which calls
 * /api/social/tick:
 *   - PREPARE_MS before the slot: the video is handed to Meta (a Reel container) so it is processed in time
 *   - at the slot: once Meta says FINISHED, it is published (not finished yet: another wake-up RETRY_MS later)
 * Nothing reaches Instagram's feed before the slot, so it can be unscheduled until then.
 */

export type Platform = 'youtube' | 'instagram';
export type PostState = 'scheduled' | 'processing' | 'live' | 'failed';

export interface PlatformPost {
  at: number;                 // when it goes public (ms)
  state: PostState;
  updatedAt: number;
  videoId?: string;           // YouTube
  containerId?: string;       // Instagram: the processed video waiting to be published
  containerAt?: number;
  mediaId?: string;           // Instagram: the published Reel
  url?: string;               // the public link, once known
  error?: string;
  attempts?: number;          // failed tries in a row (Instagram)
  wakeAt?: number;            // Instagram: the next timer wake-up (EventBridge Scheduler), and its name
  wakeName?: string;
  wakeError?: string;         // the wake-up could not be set (the timer is not set up, or AWS refused)
  playlists?: PlaylistItem[]; // YouTube: the playlists it was added to
}
/** A YouTube playlist the video is in (itemId = its entry in that playlist, used to take it out again). */
export interface PlaylistItem { id: string; itemId?: string }
export interface PostPlan { youtube?: PlatformPost; instagram?: PlatformPost }
export type Posts = Record<string, PostPlan>;

export const POSTS_KEY = 'shorts/posts.json';
/** Instagram: hand the video to Meta this long before the slot (processing takes a minute or two). */
export const PREPARE_MS = 20 * 60_000;
/** Instagram: later than this after the slot (the timer did not run), it is not published on its own. */
export const LATE_MS = 90 * 60_000;
/** Meta's containers expire after 24 hours; one older than this is made again. */
export const CONTAINER_TTL_MS = 23 * 3_600_000;
/** Failed tries in a row before an Instagram post is marked failed. */
export const MAX_ATTEMPTS = 3;
/** Not finished at Meta yet, or a failed try: the next wake-up comes this much later. */
export const RETRY_MS = 2 * 60_000;
/** A wake-up may arrive a little early or late; steps allow this much slack. */
const SLACK_MS = 60_000;

/** YouTube flips the video public by itself: after its time a scheduled video is live. */
export function youtubeState(p: PlatformPost | undefined, now = Date.now()): PostState | undefined {
  if (!p) return undefined;
  return p.state === 'scheduled' && p.at <= now ? 'live' : p.state;
}

/** Still waiting to go public (can be changed or unscheduled). */
export function pending(p: PlatformPost | undefined, platform: Platform, now = Date.now()): boolean {
  if (!p) return false;
  if (platform === 'youtube') return youtubeState(p, now) === 'scheduled';
  return p.state === 'scheduled' || p.state === 'processing';
}

export type IgStep = 'wait' | 'prepare' | 'check' | 'missed';

/** What the timer should do for one Instagram post right now. */
export function igStep(p: PlatformPost | undefined, now = Date.now()): IgStep {
  if (!p || !pending(p, 'instagram')) return 'wait';
  if (now > p.at + LATE_MS) return 'missed';
  const fresh = !!p.containerId && !!p.containerAt && now - p.containerAt < CONTAINER_TTL_MS;
  if (!fresh) return now >= p.at - PREPARE_MS - SLACK_MS ? 'prepare' : 'wait';
  return now >= p.at - SLACK_MS / 2 ? 'check' : 'wait';
}

/** When the timer should next wake up for this Instagram post (undefined = nothing left to do). */
export function nextWake(p: PlatformPost | undefined, now = Date.now()): number | undefined {
  if (!p || !pending(p, 'instagram') || now > p.at + LATE_MS) return undefined;
  const fresh = !!p.containerId && !!p.containerAt && now - p.containerAt < CONTAINER_TTL_MS;
  if (!fresh) return now < p.at - PREPARE_MS ? p.at - PREPARE_MS : p.attempts ? now + RETRY_MS : now;  // now = as soon as possible
  if (now < p.at) return p.at;
  return now + RETRY_MS;
}

/** A short's video and words can be deleted only when nothing is waiting to go out. */
export function blocksDelete(plan: PostPlan | undefined, now = Date.now()): boolean {
  return pending(plan?.youtube, 'youtube', now) || pending(plan?.instagram, 'instagram', now);
}

/** Every future slot already used (for picking default slots for the next shorts). */
export function takenSlots(posts: Posts, now = Date.now()): number[] {
  const out: number[] = [];
  for (const plan of Object.values(posts)) for (const p of [plan.youtube, plan.instagram]) if (p && p.at > now) out.push(p.at);
  return out;
}

/** Instagram accepts at most 5 hashtags on a post: later ones are dropped (duplicates too), the words stay. */
export const IG_MAX_HASHTAGS = 5;
export function capHashtags(caption: string, max = IG_MAX_HASHTAGS): string {
  const seen = new Set<string>();
  return caption.replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, (m, pre: string, tag: string) => {
    const k = tag.toLowerCase();
    if (seen.has(k) || seen.size >= max) return pre;
    seen.add(k); return m;
  }).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trimEnd();
}
export const hashtagCount = (caption: string) => new Set((caption.match(/(?:^|\s)#([\p{L}\p{N}_]+)/gu) ?? []).map((t) => t.trim().toLowerCase())).size;
