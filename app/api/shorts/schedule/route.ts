import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { capHashtags, pending, youtubeState, type PlatformPost } from '@/lib/shorts/posts';
import { dropWake, loadPosts, loadThumb, saveText, scheduleYouTube, syncWake, unscheduleYouTube, updatePlan, type PostText } from '@/lib/shorts/publish';
import { listShorts, statusOf, store, textKey, validId } from '@/lib/shorts/store';
import { withDisclaimer } from '@/lib/shorts/disclaimer';
import { getJson } from '@/lib/setups/store';
import type { WrittenText } from '@/lib/shorts/write';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;  // the YouTube upload happens here

/**
 * POST { id, text: { title, description, tags, caption }, youtube: { at, playlists?: [playlistId] } | null, instagram: { at } | null }
 * Saves the words, then:
 *  - youtube { at }: uploads now as private with that publish time (or changes the time / words of the upload)
 *  - instagram { at }: an EventBridge wake-up is set; the timer publishes it at that time (lib/shorts/posts.ts)
 *  - null: unscheduled (the private YouTube video is removed). Anything already public is left alone.
 */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({})) as { id?: string; text?: Partial<PostText>; youtube?: { at?: number; playlists?: unknown } | null; instagram?: { at?: number } | null };
  const id = String(b.id ?? '');
  if (!validId(id)) return bad('Unknown short.');
  if ((await statusOf(id)).state !== 'done') return bad('The video is not ready yet.');
  const text: PostText = {
    title: String(b.text?.title ?? '').trim().slice(0, 100),
    description: String(b.text?.description ?? '').slice(0, 4000),  // + the disclaimer, under YouTube's 4500
    tags: (Array.isArray(b.text?.tags) ? b.text!.tags : []).map((x) => String(x).trim().replace(/^#/, '')).filter(Boolean).slice(0, 20),
    caption: capHashtags(String(b.text?.caption ?? '').slice(0, 2200)),  // Instagram allows 5 hashtags
  };
  // the risk disclaimer is always there, whatever was edited (shorts made before it existed get it here)
  const kind = (await listShorts()).find((x) => x.id === id)?.kind;
  text.description = withDisclaimer(text.description, 'youtube', kind);
  text.caption = capHashtags(withDisclaimer(text.caption, 'instagram', kind));
  const now = Date.now();
  const ytAt = b.youtube?.at, igAt = b.instagram?.at;
  if (b.youtube && !Number.isFinite(ytAt)) return bad('Pick a YouTube time.');
  if (b.instagram && !Number.isFinite(igAt)) return bad('Pick an Instagram time.');
  if (b.youtube && !text.title) return bad('YouTube needs a title.');

  const oldText = await getJson<WrittenText | { error: string }>(store, textKey(id));
  const captionSame = !!oldText && 'instagram' in oldText && oldText.instagram.caption === text.caption;
  const ytWordsSame = !!oldText && 'youtube' in oldText && oldText.youtube.title === text.title && oldText.youtube.description === text.description
    && oldText.youtube.tags.join('|') === text.tags.join('|');
  await saveText(id, text);
  const old = (await loadPosts())[id] ?? {};
  const errors: string[] = [];

  // YouTube
  let yt: PlatformPost | undefined = old.youtube;
  const ytLive = youtubeState(old.youtube, now) === 'live';
  if (!ytLive) {
    try {
      if (b.youtube) {
        const lists = Array.isArray(b.youtube.playlists) ? b.youtube.playlists.map(String).filter((x) => /^[A-Za-z0-9_-]{10,64}$/.test(x)).slice(0, 5) : undefined;
        const r = await scheduleYouTube(id, ytAt!, text, old.youtube, now, ytWordsSame, lists);
        yt = r.post;
        for (const p of r.problems) errors.push(`YouTube playlist: ${p}`);
      }
      else if (old.youtube && pending(old.youtube, 'youtube', now)) { await unscheduleYouTube(old.youtube); yt = undefined; }
      else if (old.youtube?.state === 'failed') yt = undefined;
    } catch (e) { errors.push(`YouTube: ${(e as Error).message}`); }
  }

  // Instagram (nothing is sent to Meta here; the timer does it near the time)
  let ig: PlatformPost | undefined = old.instagram;
  if (old.instagram?.state !== 'live') {
    if (b.instagram) {
      if (igAt! < now + 2 * 60_000 && !(igAt === old.instagram?.at && pending(old.instagram, 'instagram', now))) errors.push('Instagram: pick a time at least 2 minutes from now, or use Post now.');
      else {
        // a new time or new caption (it is baked into what Meta processed): start over; the old one expires on its own
        // the cover is baked in too: a frame picked after Meta processed it means starting over
        const thumbSame = !old.instagram?.containerId || old.instagram.thumbMs === (await loadThumb(id))?.ms;
        const keep = old.instagram && old.instagram.at === igAt && pending(old.instagram, 'instagram', now) && captionSame && thumbSame;
        ig = keep ? old.instagram : { at: igAt!, state: 'scheduled', updatedAt: now };
      }
    } else ig = undefined;
    if (ig !== old.instagram) await dropWake(old.instagram);  // its timer wake-up belonged to the old plan
    ig = await syncWake(id, ig, now);                           // the timer's next wake-up for the new plan
    if (ig?.wakeError) errors.push(`Instagram timer: ${ig.wakeError}`);
  }

  const plan = await updatePlan(id, () => ({ youtube: yt, instagram: ig }));
  return NextResponse.json({ plan, errors }, { status: errors.length ? 207 : 200 });
}

const bad = (message: string) => NextResponse.json({ error: 'BAD_REQUEST', message }, { status: 400 });
