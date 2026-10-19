import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** POST -> signed out (the session cookie is removed). Only from this site's own pages. */
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  const r = NextResponse.json({ ok: true });
  r.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return r;
}
