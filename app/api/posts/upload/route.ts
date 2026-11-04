import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { istToday, slideKey, validName } from '@/lib/posts/publish';
import { store } from '@/lib/shorts/store';

export const dynamic = 'force-dynamic';
const MAX_BYTES = 3 * 1024 * 1024;

/** POST { date, name, image } -> saves one image of today's post (a JPEG drawn in the browser) for Instagram to fetch. */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({})) as { date?: string; name?: string; image?: string };
  const name = String(b.name ?? '');
  if (b.date !== istToday()) return bad('Posts are for today only.');
  if (!validName(name)) return bad('Bad image name.');
  const bytes = Buffer.from(String(b.image ?? '').replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  if (bytes.length > MAX_BYTES) return bad('That image is too large.');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bad('The image must be a JPEG.');
  await store.put(slideKey(b.date, name), new Uint8Array(bytes));
  return NextResponse.json({ ok: true });
}
const bad = (message: string) => NextResponse.json({ error: 'BAD_REQUEST', message }, { status: 400 });
