import { ownerRequired } from '@/lib/auth/owner';
import { backToPage, callbackUrl, checkState } from '@/lib/social/oauth';
import { saveConn } from '@/lib/social/store';
import { exchangeYouTubeCode, isExpectedChannel, myChannel } from '@/lib/social/youtube';

export const dynamic = 'force-dynamic';

/**
 * Google sends the browser back here after consent. Saved only when: the owner is signed in, the state matches,
 * Google hands back a refresh token, and the chosen channel is @CandlesBeforeCubicles (anything else is refused, so
 * nothing can ever be uploaded to another channel on the same Google account).
 */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const url = new URL(req.url);
  if (url.searchParams.get('error')) return backToPage(req, 'youtube', { error: 'cancelled' });
  const st = await checkState(req, 'youtube', url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!st || !code) return backToPage(req, 'youtube', { error: 'expired' });
  try {
    const t = await exchangeYouTubeCode({ code, verifier: st.verifier, redirectUri: callbackUrl(req, 'youtube') });
    const ch = await myChannel(t.accessToken);
    if (!isExpectedChannel(ch.handle)) return backToPage(req, 'youtube', { error: 'wrong-channel', got: ch.handle || ch.title });
    await saveConn('youtube', { refreshToken: t.refreshToken, channelId: ch.id, channelTitle: ch.title, handle: ch.handle, scope: t.scope, connectedAt: Date.now() });
    return backToPage(req, 'youtube', { connected: 'youtube' });
  } catch (e) {
    console.warn('[social] YouTube connect failed:', (e as Error).message);
    return backToPage(req, 'youtube', { error: 'failed', why: (e as Error).message.slice(0, 200) });
  }
}
