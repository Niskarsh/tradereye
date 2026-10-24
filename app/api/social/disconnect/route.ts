import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { deleteConn, type Platform } from '@/lib/social/store';

export const dynamic = 'force-dynamic';

/** POST { platform } -> forget that connection (deletes the saved token from S3). */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const { platform } = await req.json().catch(() => ({})) as { platform?: Platform };
  if (platform !== 'youtube' && platform !== 'instagram') return NextResponse.json({ error: 'BAD_REQUEST', message: 'platform must be youtube or instagram' }, { status: 400 });
  await deleteConn(platform);
  return NextResponse.json({ ok: true });
}
