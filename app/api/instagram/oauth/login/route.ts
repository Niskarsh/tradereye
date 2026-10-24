import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { backToPage, callbackUrl, newState, setStateCookie } from '@/lib/social/oauth';
import { instagramAuthUrl } from '@/lib/social/instagram';

export const dynamic = 'force-dynamic';

/** GET -> Instagram's login / permission page for the candlesbeforecubicles account. */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const appId = process.env.IG_APP_ID?.trim();
  if (!appId || !process.env.IG_APP_SECRET?.trim()) return backToPage(req, 'instagram', { error: 'instagram-not-configured' });
  const st = await newState();
  return setStateCookie(NextResponse.redirect(instagramAuthUrl({ appId, redirectUri: callbackUrl(req, 'instagram'), state: st.state })), 'instagram', st);
}
