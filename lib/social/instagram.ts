import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Instagram API with Instagram Login: connect, keep the long-lived token fresh, and publish Reels in three steps
 * (create a container from a public video URL, wait until Meta has processed it, publish). The API has no
 * "publish at" option, so scheduled Reels are published by tradereye itself at the chosen time.
 * The Meta app stays in Development mode with the account as its Instagram Tester; no App Review needed.
 */

const AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const TOKEN = 'https://api.instagram.com/oauth/access_token';
const GRAPH = 'https://graph.instagram.com';

export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights'];

/** Refresh when fewer than this many days are left (Meta allows a refresh once the token is a day old). */
export const REFRESH_WHEN_DAYS_LEFT = 20;

export const expectedUsername = (env: Record<string, string | undefined> = process.env) =>
  (env.IG_USERNAME?.trim() || 'candlesbeforecubicles').replace(/^@/, '').toLowerCase();

export class InstagramError extends Error {
  constructor(message: string, public status = 0, public code = 0) { super(message); }
}

function creds() {
  const appId = process.env.IG_APP_ID?.trim(), appSecret = process.env.IG_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new InstagramError('IG_APP_ID / IG_APP_SECRET are not set in Vercel.');
  return { appId, appSecret };
}

export function instagramAuthUrl(p: { appId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.appId, redirect_uri: p.redirectUri, response_type: 'code', scope: INSTAGRAM_SCOPES.join(','),
    state: p.state, enable_fb_login: '0', force_reauth: 'true',
  });
  return `${AUTHORIZE}?${q}`;
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const j = await res.json().catch(() => ({})) as Record<string, unknown> & { error?: { message?: string; code?: number } | string; error_message?: string; error_type?: string };
  if (!res.ok || j.error) {
    const e = typeof j.error === 'object' ? j.error : undefined;
    const msg = e?.message ?? j.error_message ?? (typeof j.error === 'string' ? j.error : '') ?? '';
    const code = e?.code ?? 0;
    const hint = code === 190 ? ' Connect Instagram again.' : '';
    throw new InstagramError(`${what} failed: ${msg || `HTTP ${res.status}`}.${hint}`, res.status, code);
  }
  return j;
}

/** Code -> short-lived token -> long-lived token (~60 days). Instagram adds "#_" to the code; it is not part of it. */
export async function exchangeInstagramCode(p: { code: string; redirectUri: string }, fetchImpl: typeof fetch = fetch, now = Date.now()) {
  const { appId, appSecret } = creds();
  const short = await readJson(await fetchImpl(TOKEN, {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: p.redirectUri, code: p.code.replace(/#_$/, '') }),
  }), 'Instagram sign-in');
  // the answer is either flat or wrapped in data[0], depending on the API version
  const first = (Array.isArray(short.data) ? short.data[0] : short) as { access_token?: string };
  if (!first?.access_token) throw new InstagramError('Instagram did not return an access token.');
  const long = await readJson(await fetchImpl(`${GRAPH}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: appSecret, access_token: first.access_token })}`, { cache: 'no-store' }), 'Getting a long-lived Instagram token');
  return { accessToken: String(long.access_token), expiresAt: now + Number(long.expires_in ?? 0) * 1000 };
}

/** Swap a long-lived token for a fresh one (another ~60 days). */
export async function refreshInstagramToken(accessToken: string, fetchImpl: typeof fetch = fetch, now = Date.now()) {
  const j = await readJson(await fetchImpl(`${GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: accessToken })}`, { cache: 'no-store' }), 'Refreshing the Instagram token');
  return { accessToken: String(j.access_token), expiresAt: now + Number(j.expires_in ?? 0) * 1000 };
}

export function needsRefresh(c: { expiresAt: number; refreshedAt: number }, now = Date.now()): boolean {
  return c.expiresAt - now < REFRESH_WHEN_DAYS_LEFT * 86400_000 && now - c.refreshedAt > 86400_000;
}

export async function instagramMe(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ userId: string; username: string }> {
  const j = await readJson(await fetchImpl(`${GRAPH}/me?${new URLSearchParams({ fields: 'user_id,username', access_token: accessToken })}`, { cache: 'no-store' }), 'Reading your Instagram account');
  return { userId: String(j.user_id ?? j.id ?? ''), username: String(j.username ?? '') };
}

/** Step 1: Meta fetches the video from a public URL and starts processing it. Returns the container id. */
export async function createReelContainer(p: { accessToken: string; userId: string; videoUrl: string; caption?: string; shareToFeed?: boolean }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const j = await readJson(await fetchImpl(`${GRAPH}/${p.userId}/media`, {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ media_type: 'REELS', video_url: p.videoUrl, caption: p.caption ?? '', share_to_feed: String(p.shareToFeed ?? true), access_token: p.accessToken }),
  }), 'Sending the video to Instagram');
  return String(j.id);
}

export type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED' | string;

/** Step 2: FINISHED means ready to publish. Containers expire if not published within 24 hours. */
export async function containerStatus(accessToken: string, containerId: string, fetchImpl: typeof fetch = fetch): Promise<{ code: ContainerStatus; detail: string }> {
  const j = await readJson(await fetchImpl(`${GRAPH}/${containerId}?${new URLSearchParams({ fields: 'status_code,status', access_token: accessToken })}`, { cache: 'no-store' }), 'Checking the Instagram upload');
  return { code: String(j.status_code ?? ''), detail: String(j.status ?? '') };
}

/** Polls until the container is FINISHED (or failed / out of time). */
export async function waitForContainer(accessToken: string, containerId: string, maxMs = 45_000, everyMs = 4_000, fetchImpl: typeof fetch = fetch): Promise<{ code: ContainerStatus; detail: string }> {
  const until = Date.now() + maxMs;
  let s = await containerStatus(accessToken, containerId, fetchImpl);
  while (s.code === 'IN_PROGRESS' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    s = await containerStatus(accessToken, containerId, fetchImpl);
  }
  return s;
}

/** Step 3: the Reel goes live. */
export async function publishContainer(p: { accessToken: string; userId: string; containerId: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const j = await readJson(await fetchImpl(`${GRAPH}/${p.userId}/media_publish`, {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: p.containerId, access_token: p.accessToken }),
  }), 'Publishing the Reel');
  return String(j.id);
}

/** The public link of a published Reel. */
export async function mediaPermalink(accessToken: string, mediaId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const j = await readJson(await fetchImpl(`${GRAPH}/${mediaId}?${new URLSearchParams({ fields: 'permalink', access_token: accessToken })}`, { cache: 'no-store' }), 'Reading the Reel link');
  return String(j.permalink ?? '');
}

/**
 * Meta's signed_request (deauthorize / data deletion callbacks): "<sig>.<payload>", base64url, where
 * sig = HMAC-SHA256(payload, app secret). Returns the payload only when the signature is right.
 */
export function parseSignedRequest(signed: string | null | undefined, appSecret = process.env.IG_APP_SECRET ?? ''): { user_id?: string; algorithm?: string; issued_at?: number } | undefined {
  const secret = appSecret.trim();
  if (!signed || !secret) return undefined;
  const [sigPart, payloadPart] = signed.split('.');
  if (!sigPart || !payloadPart) return undefined;
  try {
    const got = Buffer.from(sigPart, 'base64url');
    const want = createHmac('sha256', secret).update(payloadPart).digest();
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    const p = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { user_id?: string | number; algorithm?: string; issued_at?: number };
    if (p.algorithm && p.algorithm.toUpperCase() !== 'HMAC-SHA256') return undefined;
    return { ...p, user_id: p.user_id === undefined ? undefined : String(p.user_id) };
  } catch { return undefined; }
}
