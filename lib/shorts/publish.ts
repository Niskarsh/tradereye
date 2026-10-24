import { getJson, putJson } from '../setups/store';
import { liveInstagram, liveYouTube } from '../social/connections';
import { containerStatus, createReelContainer, mediaPermalink, publishContainer, waitForContainer } from '../social/instagram';
import { canManage, deleteVideo, updateVideo, uploadVideo, YouTubeError, type UploadMeta } from '../social/youtube';
import { igStep, MAX_ATTEMPTS, pending, POSTS_KEY, youtubeState, type PlatformPost, type PostPlan, type Posts } from './posts';
import { MIN_LEAD_MS } from './slots';
import { signedGet, store, textKey, videoKey } from './store';
import type { WrittenText } from './write';

/**
 * Doing the posting (see lib/shorts/posts.ts for the plan and the rules).
 * The plans live in one S3 file, shorts/posts.json: { [shortId]: { youtube?, instagram? } }.
 */

export async function loadPosts(): Promise<Posts> { return (await getJson<Posts>(store, POSTS_KEY)) ?? {}; }

/** Re-reads the file just before writing, so a timer run and a page save do not undo each other. */
export async function updatePlan(id: string, f: (p: PostPlan) => PostPlan): Promise<PostPlan> {
  const all = await loadPosts();
  const next = f(all[id] ?? {});
  if (!next.youtube && !next.instagram) delete all[id]; else all[id] = next;
  await putJson(store, POSTS_KEY, all);
  return next;
}

/** The words he approved (Claude's, edited on the page). */
export interface PostText { title: string; description: string; tags: string[]; caption: string }

export async function saveText(id: string, t: PostText): Promise<void> {
  const old = await getJson<WrittenText | { error: string }>(store, textKey(id));
  const base = old && 'youtube' in old ? old : { model: 'manual', costInr: 0, at: Date.now() };
  await putJson(store, textKey(id), {
    ...base, youtube: { title: t.title, description: t.description, tags: t.tags }, instagram: { caption: t.caption }, editedAt: Date.now(),
  });
}

const meta = (t: PostText, at: number): UploadMeta => ({
  title: t.title, description: t.description, tags: t.tags, privacy: 'private', publishAt: new Date(at).toISOString(),
});

/** Schedule, re-time or re-word the YouTube upload. Returns the new YouTube part of the plan. */
export async function scheduleYouTube(id: string, at: number, t: PostText, old: PlatformPost | undefined, now = Date.now(), wordsSame = false): Promise<PlatformPost> {
  const state = youtubeState(old, now);
  if (state === 'live') throw new YouTubeError('Already public on YouTube. Change it in YouTube Studio.');
  const sameTime = old?.at === at;
  if (old?.videoId && state === 'scheduled' && sameTime && wordsSame) return old;  // nothing to change
  if (!sameTime && at < now + MIN_LEAD_MS) throw new YouTubeError('Pick a YouTube time at least 15 minutes from now.');
  const { conn, accessToken } = await liveYouTube();
  if (old?.videoId && state === 'scheduled') {
    if (!canManage(conn.scope)) throw new YouTubeError('Connect YouTube again (top of this page) to allow changing a scheduled video, then save again.');
    await updateVideo(accessToken, old.videoId, meta(t, at));
    return { ...old, at, updatedAt: now, error: undefined };
  }
  const bytes = await store.get(videoKey(id));
  if (!bytes) throw new YouTubeError('The video file is missing. Generate the short again.');
  const v = await uploadVideo(accessToken, bytes, meta(t, at));
  return { at, state: 'scheduled', updatedAt: now, videoId: v.id, url: v.url };
}

/** Removes the private, not-yet-public YouTube video. */
export async function unscheduleYouTube(old: PlatformPost): Promise<void> {
  if (!old.videoId) return;
  const { conn, accessToken } = await liveYouTube();
  if (!canManage(conn.scope)) throw new YouTubeError('Connect YouTube again (top of this page) to allow removing a scheduled video, or delete it in YouTube Studio.');
  await deleteVideo(accessToken, old.videoId);
}

/**
 * One step for one Instagram post (the timer calls this for every pending post; "Post now" calls it with waitMs so
 * the whole thing happens at once). Never throws: problems are written on the post.
 */
export async function stepInstagram(id: string, p: PlatformPost, now = Date.now(), waitMs = 0): Promise<PlatformPost> {
  const step = igStep(p, now);
  if (step === 'wait') return p;
  if (step === 'missed') {
    return { ...p, state: 'failed', updatedAt: now, error: 'Missed its time by over 90 minutes (the timer did not run). Pick a new time or Post now.' };
  }
  try {
    const { conn } = await liveInstagram(now);
    if (!conn) throw new Error('Instagram is not connected.');
    let cur = p;
    if (step === 'prepare') {
      const text = await getJson<WrittenText | { error: string }>(store, textKey(id));
      const caption = text && 'instagram' in text ? text.instagram.caption : '';
      const videoUrl = await signedGet(videoKey(id), 3 * 3600);
      const containerId = await createReelContainer({ accessToken: conn.accessToken, userId: conn.userId, videoUrl, caption });
      cur = { ...cur, state: 'processing', containerId, containerAt: now, updatedAt: now, error: undefined };
      if (now < cur.at) return cur;                      // processed ahead; published on a later run at its time
    }
    const s = waitMs ? await waitForContainer(conn.accessToken, cur.containerId!, waitMs) : await containerStatus(conn.accessToken, cur.containerId!);
    if (s.code === 'IN_PROGRESS') return { ...cur, state: 'processing', updatedAt: now };
    if (s.code === 'EXPIRED') return { ...cur, containerId: undefined, containerAt: undefined, updatedAt: now };  // made again next run
    if (s.code !== 'FINISHED') return { ...cur, state: 'failed', updatedAt: now, error: `Instagram could not process the video (${s.code}${s.detail ? `: ${s.detail}` : ''}).` };
    const mediaId = await publishContainer({ accessToken: conn.accessToken, userId: conn.userId, containerId: cur.containerId! });
    const url = await mediaPermalink(conn.accessToken, mediaId).catch(() => '');
    return { ...cur, state: 'live', mediaId, url: url || undefined, updatedAt: Date.now(), error: undefined, attempts: 0 };
  } catch (e) {
    const attempts = (p.attempts ?? 0) + 1;
    const error = (e as Error).message;
    return attempts >= MAX_ATTEMPTS ? { ...p, state: 'failed', attempts, updatedAt: now, error } : { ...p, attempts, updatedAt: now, error };
  }
}

/** The timer: one step for every Instagram post that needs one. Returns counts only (the job log is public). */
export async function tick(now = Date.now()): Promise<{ pending: number; prepared: number; published: number; failed: number }> {
  const posts = await loadPosts();
  const due = Object.entries(posts).filter(([, plan]) => igStep(plan.instagram, now) !== 'wait');
  const out = { pending: Object.values(posts).filter((p) => pending(p.instagram, 'instagram', now)).length, prepared: 0, published: 0, failed: 0 };
  for (const [id, plan] of due) {
    const before = plan.instagram!;
    const after = await stepInstagram(id, before, now);
    if (after.state === 'live') out.published++;
    else if (after.state === 'failed') out.failed++;
    else if (after.containerId && after.containerId !== before.containerId) out.prepared++;
    await updatePlan(id, (p) => (p.instagram && p.instagram.updatedAt === before.updatedAt ? { ...p, instagram: after } : p));  // he changed it meanwhile: his wins
  }
  return out;
}
