import { getJson, putJson } from '../setups/store';
import { liveInstagram, liveYouTube } from '../social/connections';
import { containerStatus, createReelContainer, mediaPermalink, publishContainer, waitForContainer } from '../social/instagram';
import { addToPlaylist, canManage, deleteVideo, removeFromPlaylist, setThumbnail, updateVideo, uploadVideo, YouTubeError, type UploadMeta } from '../social/youtube';
import { igStep, MAX_ATTEMPTS, nextWake, pending, POSTS_KEY, youtubeState, type PlatformPost, type PlaylistItem, type PostPlan, type Posts } from './posts';
import { createWake, deleteWake, wakeName } from '../social/scheduler';
import { MIN_LEAD_MS } from './slots';
import { signedGet, store, textKey, thumbKey, thumbMetaKey, videoKey, type ThumbMeta } from './store';
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

/**
 * Schedule, re-time or re-word the YouTube upload, and put it in the chosen playlists. Returns the new YouTube part of
 * the plan; `problems` lists playlist steps that failed (the upload itself still counts).
 */
export async function scheduleYouTube(id: string, at: number, t: PostText, old: PlatformPost | undefined, now = Date.now(), wordsSame = false, playlists?: string[]): Promise<{ post: PlatformPost; problems: string[] }> {
  const state = youtubeState(old, now);
  if (state === 'live') throw new YouTubeError('Already public on YouTube. Change it in YouTube Studio.');
  const sameTime = old?.at === at;
  const want = playlists ?? (old?.playlists ?? []).map((x) => x.id);
  const samePlaylists = sameSet(want, (old?.playlists ?? []).map((x) => x.id));
  const thumb = await loadThumb(id);
  const sameThumb = !thumb?.image || old?.thumbMs === thumb.ms;
  const sameMeta = old?.metaV === META_V;   // uploaded before a fixed setting changed (e.g. paid promotion): send it again
  if (old?.videoId && state === 'scheduled' && sameTime && wordsSame && samePlaylists && sameThumb && sameMeta) return { post: old, problems: [] };  // nothing to change
  if (!sameTime && at < now + MIN_LEAD_MS) throw new YouTubeError('Pick a YouTube time at least 15 minutes from now.');
  const { conn, accessToken } = await liveYouTube();
  let post: PlatformPost;
  if (old?.videoId && state === 'scheduled') {
    if (!canManage(conn.scope)) throw new YouTubeError('Connect YouTube again (top of this page) to allow changing a scheduled video, then save again.');
    if (!sameTime || !wordsSame || !sameMeta) await updateVideo(accessToken, old.videoId, meta(t, at));
    post = { ...old, at, updatedAt: now, error: undefined, metaV: META_V };
  } else {
    const bytes = await store.get(videoKey(id));
    if (!bytes) throw new YouTubeError('The video file is missing. Generate the short again.');
    const v = await uploadVideo(accessToken, bytes, meta(t, at));
    post = { at, state: 'scheduled', updatedAt: now, videoId: v.id, url: v.url, playlists: [], metaV: META_V };
  }
  const synced = await syncPlaylists(accessToken, post.videoId!, post.playlists ?? [], want);
  post = { ...post, playlists: synced.items };
  const problems = [...synced.problems];
  // the cover frame he picked, as the custom thumbnail (YouTube may refuse it for Shorts: reported, not fatal)
  if (thumb?.image && post.thumbMs !== thumb.ms) {
    try {
      const img = await store.get(thumbKey(id));
      if (!img) throw new Error('The cover image is missing: pick the frame again.');
      await setThumbnail(accessToken, post.videoId!, img);
      post = { ...post, thumbMs: thumb.ms, thumbError: undefined };
    } catch (e) {
      post = { ...post, thumbError: (e as Error).message };
      problems.push(`thumbnail: ${(e as Error).message}`);
    }
  }
  return { post, problems };
}

/** Version of the fixed upload settings (kids, AI, paid promotion, category, language, tag rules). Bump on change. */
export const META_V = 2;

export const loadThumb = (id: string) => getJson<ThumbMeta>(store, thumbMetaKey(id));

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Adds the video to playlists it should be in and takes it out of ones it should not (needs force-ssl). */
export async function syncPlaylists(accessToken: string, videoId: string, have: PlaylistItem[], want: string[]): Promise<{ items: PlaylistItem[]; problems: string[] }> {
  const items: PlaylistItem[] = [], problems: string[] = [];
  for (const h of have) {
    if (want.includes(h.id)) { items.push(h); continue; }
    try { if (h.itemId) await removeFromPlaylist(accessToken, h.itemId); }
    catch (e) { items.push(h); problems.push((e as Error).message); }
  }
  for (const id of want) {
    if (items.some((x) => x.id === id)) continue;
    try { items.push({ id, itemId: await addToPlaylist(accessToken, id, videoId) }); }
    catch (e) { problems.push((e as Error).message); }
  }
  return { items, problems };
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
      // the cover he picked: the exact frame as an image, and its position as a fallback
      const thumb = await loadThumb(id);
      const coverUrl = thumb?.image ? await signedGet(thumbKey(id), 3 * 3600, 'image/jpeg') : undefined;
      const containerId = await createReelContainer({ accessToken: conn.accessToken, userId: conn.userId, videoUrl, caption, coverUrl, thumbOffsetMs: thumb?.ms });
      cur = { ...cur, state: 'processing', containerId, containerAt: now, updatedAt: now, error: undefined, thumbMs: thumb?.ms };
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

/**
 * Makes sure the post's next timer wake-up exists (EventBridge Scheduler), and that a wake-up no longer needed is gone.
 * Never throws: a problem is written on the post (wakeError) and shown on the page.
 */
export async function syncWake(id: string, p: PlatformPost | undefined, now = Date.now()): Promise<PlatformPost | undefined> {
  if (!p) return p;
  const want = nextWake(p, now);
  const at = want === undefined ? undefined : Math.max(want, now + 60_000);
  const name = at === undefined ? undefined : wakeName('ig', id, at);
  if (name === p.wakeName && !p.wakeError) return p;                 // this step's wake-up is already set
  try {
    if (p.wakeName && p.wakeName !== name) await deleteWake(p.wakeName).catch(() => {});  // ran already, or no longer wanted
    if (name) await createWake(name, at!, { short: id }, fetch, undefined, now);
    return { ...p, wakeAt: at, wakeName: name, wakeError: undefined };
  } catch (e) {
    return { ...p, wakeAt: undefined, wakeName: undefined, wakeError: (e as Error).message };
  }
}

/** Removes a post's pending wake-up (unscheduled, or replaced by a new plan). */
export async function dropWake(p: PlatformPost | undefined): Promise<void> {
  if (p?.wakeName) await deleteWake(p.wakeName).catch(() => {});
}

/**
 * The timer (called by the Lambda when a wake-up fires): one step for every Instagram post that is due, then the next
 * wake-up for each waiting post. Returns counts only.
 */
export async function tick(now = Date.now()): Promise<{ pending: number; prepared: number; published: number; failed: number }> {
  const posts = await loadPosts();
  const waiting = Object.entries(posts).filter(([, plan]) => pending(plan.instagram, 'instagram', now));
  const out = { pending: waiting.length, prepared: 0, published: 0, failed: 0 };
  for (const [id, plan] of waiting) {
    const before = plan.instagram!;
    let after = igStep(before, now) === 'wait' ? before : await stepInstagram(id, before, now);
    if (after.state === 'live') out.published++;
    else if (after.state === 'failed') out.failed++;
    else if (after.containerId && after.containerId !== before.containerId) out.prepared++;
    after = (await syncWake(id, after, now))!;
    if (after === before) continue;
    await updatePlan(id, (p) => (p.instagram && p.instagram.updatedAt === before.updatedAt ? { ...p, instagram: after } : p));  // he changed it meanwhile: his wins
  }
  return out;
}
