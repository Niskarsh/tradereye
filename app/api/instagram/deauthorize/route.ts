import { NextResponse } from 'next/server';
import { parseSignedRequest } from '@/lib/social/instagram';
import { deleteConn } from '@/lib/social/store';

export const dynamic = 'force-dynamic';

/**
 * Meta calls this (public, no session) when the app is removed from the Instagram account. Only a request signed
 * with IG_APP_SECRET is accepted; then the saved Instagram connection is deleted.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const p = parseSignedRequest(form?.get('signed_request')?.toString());
  if (!p) return NextResponse.json({ error: 'BAD_SIGNATURE' }, { status: 400 });
  await deleteConn('instagram');
  return NextResponse.json({ ok: true });
}
