import { NextResponse } from 'next/server';
import { authUrl, pkceChallenge, randomToken, redirectUri, safeNext, type LoginState } from '@/lib/auth/google';
import { OAUTH_COOKIE, sign } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** GET ?next=/journal -> Google's sign-in page. The random state / nonce / PKCE verifier wait in a signed 10-minute cookie. */
export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET?.trim() || (process.env.AUTH_SECRET ?? '').trim().length < 32) {
    return NextResponse.redirect(new URL('/?auth=not-configured', req.url));
  }
  const st: LoginState = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), next: safeNext(new URL(req.url).searchParams.get('next')), exp: Date.now() + 10 * 60_000 };
  const res = NextResponse.redirect(authUrl({ clientId, redirectUri: redirectUri(req), state: st.state, nonce: st.nonce, challenge: await pkceChallenge(st.verifier), loginHint: process.env.OWNER_EMAIL?.trim() }));
  res.cookies.set(OAUTH_COOKIE, await sign(st), { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth/google', maxAge: 600 });
  return res;
}
