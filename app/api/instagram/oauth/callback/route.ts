import { ownerRequired } from '@/lib/auth/owner';
import { backToPage, callbackUrl, checkState } from '@/lib/social/oauth';
import { saveConn } from '@/lib/social/store';
import { exchangeInstagramCode, expectedUsername, instagramMe } from '@/lib/social/instagram';

export const dynamic = 'force-dynamic';

/** Instagram sends the browser back here. Saved only for the expected account (candlesbeforecubicles by default). */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const url = new URL(req.url);
  if (url.searchParams.get('error')) return backToPage(req, 'instagram', { error: 'cancelled' });
  const st = await checkState(req, 'instagram', url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!st || !code) return backToPage(req, 'instagram', { error: 'expired' });
  try {
    const now = Date.now();
    const t = await exchangeInstagramCode({ code, redirectUri: callbackUrl(req, 'instagram') }, fetch, now);
    const me = await instagramMe(t.accessToken);
    if (me.username.toLowerCase() !== expectedUsername()) return backToPage(req, 'instagram', { error: 'wrong-account', got: me.username });
    await saveConn('instagram', { accessToken: t.accessToken, expiresAt: t.expiresAt, refreshedAt: now, userId: me.userId, username: me.username, connectedAt: now });
    return backToPage(req, 'instagram', { connected: 'instagram' });
  } catch (e) {
    console.warn('[social] Instagram connect failed:', (e as Error).message);
    return backToPage(req, 'instagram', { error: 'failed', why: (e as Error).message.slice(0, 200) });
  }
}
