import { NextResponse } from 'next/server';
import { sessionFromRequest } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** GET -> { owner: true, name, email, picture } when signed in as the owner, else { owner: false }. */
export async function GET(req: Request) {
  const s = await sessionFromRequest(req);
  return NextResponse.json(s ? { owner: true, name: s.name, email: s.email, picture: s.picture } : { owner: false }, { headers: { 'cache-control': 'no-store' } });
}
