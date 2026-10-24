import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { putJson } from '@/lib/setups/store';
import { loadThumb } from '@/lib/shorts/publish';
import { signedGet, statusOf, store, thumbKey, thumbMetaKey, validId, videoKey, type ThumbMeta } from '@/lib/shorts/store';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 3 * 1024 * 1024;

/** GET ?id -> a fresh link to the video (for the frame picker) and the cover picked so far. */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!validId(id)) return bad('Unknown short.');
  const thumb = await loadThumb(id);
  return NextResponse.json({
    video: await signedGet(videoKey(id), 900),
    thumb, image: thumb?.image ? await signedGet(thumbKey(id), 900, 'image/jpeg') : undefined,
  });
}

/**
 * POST { id, ms, image? } -> saves the cover frame he picked: where it is in the video (ms) and, when the browser could
 * capture it, the frame itself as a JPEG (base64). YouTube needs the image; Instagram can use either.
 */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({})) as { id?: string; ms?: number; image?: string };
  const id = String(b.id ?? '');
  if (!validId(id)) return bad('Unknown short.');
  if ((await statusOf(id)).state !== 'done') return bad('The video is not ready yet.');
  const ms = Number(b.ms);
  if (!Number.isFinite(ms) || ms < 0 || ms > 10 * 60_000) return bad('Pick a frame in the video.');
  let image = false;
  if (b.image) {
    const bytes = Buffer.from(String(b.image).replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    if (bytes.length > MAX_BYTES) return bad('That frame is too large.');
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bad('The frame must be a JPEG.');
    await store.put(thumbKey(id), new Uint8Array(bytes));
    image = true;
  }
  const meta: ThumbMeta = { ms: Math.round(ms), image, at: Date.now() };
  await putJson(store, thumbMetaKey(id), meta);
  return NextResponse.json({ thumb: meta, image: image ? await signedGet(thumbKey(id), 900, 'image/jpeg') : undefined });
}

const bad = (message: string) => NextResponse.json({ error: 'BAD_REQUEST', message }, { status: 400 });
