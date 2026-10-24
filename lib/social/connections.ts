import { loadConn, saveConn, type InstagramConn, type YouTubeConn } from './store';
import { youtubeAccessToken, isExpectedChannel, expectedHandle, YouTubeError } from './youtube';
import { needsRefresh, refreshInstagramToken, InstagramError } from './instagram';

/** What the YouTube page shows for each platform (no tokens, ever). */
export interface ConnStatus {
  connected: boolean;
  account?: string;        // "@candlesbeforecubicles"
  title?: string;
  connectedAt?: number;
  expiresAt?: number;      // Instagram's token
  problem?: string;
}

export async function youtubeStatus(): Promise<ConnStatus> {
  const c = await loadConn('youtube');
  if (!c) return { connected: false };
  return { connected: true, account: c.handle, title: c.channelTitle, connectedAt: c.connectedAt, problem: isExpectedChannel(c.handle) ? undefined : `Connected to ${c.handle}, not ${expectedHandle()}.` };
}

export async function instagramStatus(): Promise<ConnStatus> {
  const c = await liveInstagram().catch((e) => ({ error: (e as Error).message }));
  if ('error' in c) return { connected: true, problem: c.error };
  if (!c.conn) return { connected: false };
  return { connected: true, account: `@${c.conn.username}`, connectedAt: c.conn.connectedAt, expiresAt: c.conn.expiresAt };
}

/** The saved YouTube connection plus a fresh access token, only when it is the expected channel. */
export async function liveYouTube(): Promise<{ conn: YouTubeConn; accessToken: string }> {
  const conn = await loadConn('youtube');
  if (!conn) throw new YouTubeError('YouTube is not connected yet.');
  if (!isExpectedChannel(conn.handle)) throw new YouTubeError(`Connected channel is ${conn.handle}, not ${expectedHandle()}. Connect again and pick Candles Before Cubicles.`);
  return { conn, accessToken: await youtubeAccessToken(conn.refreshToken) };
}

/** The saved Instagram connection, refreshing its token first when it is getting old. */
export async function liveInstagram(now = Date.now()): Promise<{ conn?: InstagramConn }> {
  const conn = await loadConn('instagram');
  if (!conn) return {};
  if (conn.expiresAt <= now) throw new InstagramError('The Instagram token expired. Connect Instagram again.');
  if (needsRefresh(conn, now)) {
    const t = await refreshInstagramToken(conn.accessToken, fetch, now);
    const next: InstagramConn = { ...conn, accessToken: t.accessToken, expiresAt: t.expiresAt, refreshedAt: now };
    await saveConn('instagram', next);
    return { conn: next };
  }
  return { conn };
}
