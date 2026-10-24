/**
 * The posting plan for each short: when it goes public on YouTube and on Instagram, and what happened.
 * Pure (no network); lib/shorts/publish.ts does the work.
 *
 * YouTube: uploaded when he presses Schedule, as private with publishAt; YouTube itself makes it public at that time.
 * Instagram: the API cannot schedule or post privately, so tradereye publishes it itself. A timer (GitHub Actions,
 * every 5 minutes, .github/workflows/social-tick.yml) calls /api/social/tick:
 *   - from PREPARE_MS before the slot: the video is handed to Meta (a Reel container) so it is processed in time
 *   - at the slot: once Meta says FINISHED, it is published
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
}
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
  if (!fresh) return now >= p.at - PREPARE_MS ? 'prepare' : 'wait';
  return now >= p.at ? 'check' : 'wait';
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
