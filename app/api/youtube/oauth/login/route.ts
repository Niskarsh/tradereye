import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { pkceChallenge } from '@/lib/auth/google';
import { backToPage, callbackUrl, newState, setStateCookie } from '@/lib/social/oauth';
import { youtubeAuthUrl } from '@/lib/social/youtube';

export const dynamic = 'force-dynamic';

/** GET -> Google's consent page for the YouTube scopes. Pick the Candles Before Cubicles channel there. */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET?.trim()) return backToPage(req, 'youtube', { error: 'youtube-not-configured' });
  const st = await newState();
  const url = youtubeAuthUrl({ clientId, redirectUri: callbackUrl(req, 'youtube'), state: st.state, challenge: await pkceChallenge(st.verifier) });
  return setStateCookie(NextResponse.redirect(url), 'youtube', st);
}
