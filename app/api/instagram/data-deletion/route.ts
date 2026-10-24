import { NextResponse } from 'next/server';
import { parseSignedRequest } from '@/lib/social/instagram';
import { deleteConn } from '@/lib/social/store';
import { appBase } from '@/lib/social/oauth';

export const dynamic = 'force-dynamic';

/**
 * Meta's data deletion callback (public, no session; signed with IG_APP_SECRET). The only Instagram data tradereye
 * keeps is the saved connection, so it is deleted right away and Meta gets the status link + confirmation code it asks for.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const p = parseSignedRequest(form?.get('signed_request')?.toString());
  if (!p) return NextResponse.json({ error: 'BAD_SIGNATURE' }, { status: 400 });
  await deleteConn('instagram');
  const code = `del-${Date.now().toString(36)}`;
  return NextResponse.json({ url: `${appBase(req)}/privacy`, confirmation_code: code });
}
