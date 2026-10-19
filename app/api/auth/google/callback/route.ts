import { NextResponse } from 'next/server';
import { exchangeCode, redirectUri, safeNext, verifyIdToken, type LoginState } from '@/lib/auth/google';
import { OAUTH_COOKIE, SESSION_COOKIE, SESSION_DAYS, cookieFrom, createSession, isOwnerAccount, unsign } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Google sends the browser back here. The sign-in is accepted only if: the state matches the one we made (same
 * browser, not a forged link), Google gives us an ID token for the code (with our client secret + PKCE verifier),
 * that token passes every check, and the account is the owner's (email and, once set, the Google account id).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => {
    const r = NextResponse.redirect(new URL(`/?auth=${q}`, req.url));
    r.cookies.set(OAUTH_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth/google', maxAge: 0 });
    return r;
  };
  const st = await unsign<LoginState>(cookieFrom(req.headers.get('cookie'), OAUTH_COOKIE));
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  if (url.searchParams.get('error')) return back('cancelled');
  if (!st || st.exp < Date.now() || !state || state !== st.state || !code) return back('expired');
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? '', clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  try {
    const idToken = await exchangeCode({ code, verifier: st.verifier, clientId, clientSecret, redirectUri: redirectUri(req) });
    const c = await verifyIdToken(idToken, { clientId, nonce: st.nonce });
    if (!isOwnerAccount(c.email, c.sub)) {
      console.warn('[auth] sign-in refused for a non-owner Google account');
      return back('denied');
    }
    const r = NextResponse.redirect(new URL(process.env.OWNER_GOOGLE_ID?.trim() ? safeNext(st.next) : `/?auth=welcome&gid=${encodeURIComponent(c.sub)}`, req.url));
    r.cookies.set(SESSION_COOKIE, await createSession({ email: c.email, sub: c.sub, name: c.name, picture: c.picture }), { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400 });
    r.cookies.set(OAUTH_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth/google', maxAge: 0 });
    return r;
  } catch (e) {
    console.warn('[auth] sign-in failed:', (e as Error).message);
    return back('failed');
  }
}
