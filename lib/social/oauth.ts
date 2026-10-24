import { NextResponse } from 'next/server';
import { cookieFrom, sign, unsign } from '@/lib/auth/session';
import { randomToken } from '@/lib/auth/google';
import type { Platform } from './store';

/**
 * The short-lived "connect" state for YouTube / Instagram, like Google sign-in's: a random state (+ PKCE verifier for
 * Google) in a signed 10-minute cookie scoped to /api/<platform>/oauth. The callback only accepts a code whose state
 * matches, so a forged link cannot attach someone else's channel.
 */

export interface ConnectState { state: string; verifier: string; exp: number }

const cookieName = (p: Platform) => `te_${p}_oauth`;
const cookiePath = (p: Platform) => `/api/${p}/oauth`;

export function appBase(req: Request): string {
  return (process.env.APP_URL ?? '').trim().replace(/\/+$/, '') || new URL(req.url).origin;
}

export const callbackUrl = (req: Request, p: Platform) => `${appBase(req)}/api/${p}/oauth/callback`;

export async function newState(): Promise<ConnectState> {
  return { state: randomToken(), verifier: randomToken(48), exp: Date.now() + 10 * 60_000 };
}

export async function setStateCookie(res: NextResponse, p: Platform, st: ConnectState): Promise<NextResponse> {
  res.cookies.set(cookieName(p), await sign(st), { httpOnly: true, secure: true, sameSite: 'lax', path: cookiePath(p), maxAge: 600 });
  return res;
}

/** The state from the cookie when it is valid and matches the `state` Google / Instagram sent back. */
export async function checkState(req: Request, p: Platform, returned: string | null): Promise<ConnectState | undefined> {
  const st = await unsign<ConnectState>(cookieFrom(req.headers.get('cookie'), cookieName(p)));
  if (!st || st.exp < Date.now() || !returned || returned !== st.state) return undefined;
  return st;
}

/** Back to the Socials page with a short result code (?connected=youtube or ?error=...), clearing the state cookie. */
export function backToPage(req: Request, p: Platform, q: Record<string, string>): NextResponse {
  const r = NextResponse.redirect(new URL(`/socials?${new URLSearchParams(q)}`, req.url));
  r.cookies.set(cookieName(p), '', { httpOnly: true, secure: true, sameSite: 'lax', path: cookiePath(p), maxAge: 0 });
  return r;
}
