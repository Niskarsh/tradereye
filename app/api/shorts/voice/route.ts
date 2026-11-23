import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { putVoice, statusOf, validId } from '@/lib/shorts/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** a few seconds of speech is ~50-150 KB; this leaves room and keeps Vercel's 4.5 MB body limit far away */
const MAX_BYTES = 2_000_000;
const TYPES = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac)/;

/** POST ?id=<short id>, body = the recorded take (audio/webm or audio/mp4) -> saved as shorts/<id>/voice.audio */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const id = new URL(req.url).searchParams.get('id') ?? '';
    if (!validId(id)) return bad('Unknown short.');
    if ((await statusOf(id)).state !== 'voice') return bad('This short is not waiting for a voice take.');
    const type = (req.headers.get('content-type') ?? '').toLowerCase();
    if (!TYPES.test(type)) return bad('Send the recording as audio.');
    const body = new Uint8Array(await req.arrayBuffer());
    if (!body.length) return bad('The recording is empty.');
    if (body.length > MAX_BYTES) return bad('The recording is too long.');
    await putVoice(id, body, type.split(';')[0]);
    return NextResponse.json({ ok: true, bytes: body.length });
  } catch (e) { return errorResponse(e); }
}

const bad = (message: string) => NextResponse.json({ error: 'BAD_REQUEST', message }, { status: 400 });
