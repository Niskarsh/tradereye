/**
 * YouTube Data API v3: connect (OAuth with offline access), find the connected channel, upload a video.
 * Uses the same Google OAuth client as sign-in (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), with the YouTube scopes on
 * top. The app must be "In production" on Google's Audience page, or Google expires the refresh token after 7 days.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';

export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

/** The only channel tradereye will post to. Anything else connected is refused, so nothing lands on another channel. */
export const expectedHandle = (env: Record<string, string | undefined> = process.env) =>
  (env.YOUTUBE_CHANNEL_HANDLE?.trim() || '@CandlesBeforeCubicles');

export function isExpectedChannel(handle: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const want = expectedHandle(env).replace(/^@/, '').toLowerCase();
  return !!handle && handle.replace(/^@/, '').toLowerCase() === want;
}

export class YouTubeError extends Error {
  constructor(message: string, public status = 0, public reason = '') { super(message); }
}

function creds() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new YouTubeError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in Vercel.');
  return { clientId, clientSecret };
}

export function youtubeAuthUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline', include_granted_scopes: 'false',
    // select_account: pick the Candles Before Cubicles brand channel; consent: always hand back a refresh token
    prompt: 'select_account consent',
    state: p.state, code_challenge: p.challenge, code_challenge_method: 'S256',
  });
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `${AUTH_ENDPOINT}?${q}`;
}

async function tokenCall(body: Record<string, string>, fetchImpl: typeof fetch): Promise<{ access_token: string; refresh_token?: string; scope?: string; expires_in?: number }> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, cache: 'no-store', body: new URLSearchParams(body),
  });
  const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; scope?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    const why = j.error_description ?? j.error ?? `HTTP ${res.status}`;
    throw new YouTubeError(j.error === 'invalid_grant' ? 'YouTube access was revoked or expired. Connect YouTube again.' : `Google refused the token request (${why}).`, res.status, j.error ?? '');
  }
  return j as { access_token: string; refresh_token?: string; scope?: string; expires_in?: number };
}

export async function exchangeYouTubeCode(p: { code: string; verifier: string; redirectUri: string }, fetchImpl: typeof fetch = fetch) {
  const { clientId, clientSecret } = creds();
  const t = await tokenCall({ code: p.code, code_verifier: p.verifier, client_id: clientId, client_secret: clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code' }, fetchImpl);
  if (!t.refresh_token) throw new YouTubeError('Google did not return a refresh token. Remove TraderEye under your Google account\'s third-party connections, then connect again.');
  return { accessToken: t.access_token, refreshToken: t.refresh_token, scope: t.scope ?? '' };
}

/** A fresh (1-hour) access token from the saved refresh token. */
export async function youtubeAccessToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { clientId, clientSecret } = creds();
  return (await tokenCall({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }, fetchImpl)).access_token;
}

async function apiError(res: Response, what: string): Promise<YouTubeError> {
  const j = await res.json().catch(() => ({})) as { error?: { message?: string; errors?: { reason?: string }[] } };
  const reason = j.error?.errors?.[0]?.reason ?? '';
  const hint = reason === 'quotaExceeded' ? ' (daily YouTube API quota used up; try again tomorrow)'
    : reason === 'uploadLimitExceeded' ? ' (YouTube\'s upload limit for this channel was reached)' : '';
  return new YouTubeError(`${what} failed: ${j.error?.message ?? `HTTP ${res.status}`}${hint}`, res.status, reason);
}

export interface ChannelInfo { id: string; title: string; handle: string }

/** The channel the token belongs to (the one picked in Google's account picker). */
export async function myChannel(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<ChannelInfo> {
  const res = await fetchImpl(`${API}/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store' });
  if (!res.ok) throw await apiError(res, 'Reading your channel');
  const j = await res.json() as { items?: { id: string; snippet?: { title?: string; customUrl?: string } }[] };
  const c = j.items?.[0];
  if (!c) throw new YouTubeError('That Google account has no YouTube channel. Pick the Candles Before Cubicles channel when connecting.');
  return { id: c.id, title: c.snippet?.title ?? '', handle: c.snippet?.customUrl ?? '' };
}

export interface UploadMeta {
  title: string;               // max 100 characters
  description?: string;        // max 5000 bytes
  tags?: string[];
  categoryId?: string;         // 27 = Education
  privacy: 'private' | 'unlisted' | 'public';
  publishAt?: string;          // ISO time; YouTube makes a private video public then
}

/** Resumable upload in two calls: start a session with the details, then send the bytes. Returns the video id. */
export async function uploadVideo(accessToken: string, bytes: Uint8Array, meta: UploadMeta, fetchImpl: typeof fetch = fetch): Promise<{ id: string; url: string }> {
  if (meta.publishAt && meta.privacy !== 'private') throw new YouTubeError('A scheduled video must be uploaded as private.');
  const body = {
    snippet: { title: meta.title.slice(0, 100), description: meta.description ?? '', tags: meta.tags ?? [], categoryId: meta.categoryId ?? '27' },
    status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false, ...(meta.publishAt ? { publishAt: meta.publishAt } : {}) },
  };
  const start = await fetchImpl(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: 'POST', cache: 'no-store',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(bytes.byteLength) },
    body: JSON.stringify(body),
  });
  if (!start.ok) throw await apiError(start, 'Starting the upload');
  const session = start.headers.get('location');
  if (!session) throw new YouTubeError('YouTube did not return an upload address.');
  const put = await fetchImpl(session, { method: 'PUT', cache: 'no-store', headers: { 'content-type': 'video/mp4' }, body: bytes as BodyInit });
  if (!put.ok) throw await apiError(put, 'Uploading the video');
  const v = await put.json() as { id?: string };
  if (!v.id) throw new YouTubeError('YouTube accepted the upload but returned no video id.');
  return { id: v.id, url: `https://youtube.com/shorts/${v.id}` };
}
