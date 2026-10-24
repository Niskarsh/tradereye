import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { decryptJson, encryptJson } from '../lib/social/store';
import { isExpectedChannel, uploadVideo, youtubeAuthUrl, YOUTUBE_SCOPES } from '../lib/social/youtube';
import { instagramAuthUrl, needsRefresh, parseSignedRequest, exchangeInstagramCode } from '../lib/social/instagram';
import { gate } from '../lib/auth/gate';

const SECRET = 'y'.repeat(48);

test('saved connections: encrypted, readable only with the same AUTH_SECRET, and tamper-proof', () => {
  const conn = { refreshToken: '1//secret-refresh', handle: '@candlesbeforecubicles' };
  const box = encryptJson(conn, SECRET);
  assert.ok(!box.includes('secret-refresh'));
  assert.deepEqual(decryptJson(box, SECRET), conn);
  assert.throws(() => decryptJson(box, 'z'.repeat(48)));
  const [iv, body] = box.split('.');
  const flipped = Buffer.from(body, 'base64url'); flipped[0] ^= 1;
  assert.throws(() => decryptJson(`${iv}.${flipped.toString('base64url')}`, SECRET));
  assert.throws(() => encryptJson(conn, 'short'));
});

test('YouTube: only the Candles Before Cubicles channel is accepted', () => {
  assert.equal(isExpectedChannel('@candlesbeforecubicles', {}), true);
  assert.equal(isExpectedChannel('@CandlesBeforeCubicles', {}), true);
  assert.equal(isExpectedChannel('@quoter01', {}), false);
  assert.equal(isExpectedChannel('@Nik.always', {}), false);
  assert.equal(isExpectedChannel('', {}), false);
  assert.equal(isExpectedChannel('@other', { YOUTUBE_CHANNEL_HANDLE: '@other' }), true);
});

test('YouTube connect link asks for offline access, the account picker and both scopes', () => {
  const u = new URL(youtubeAuthUrl({ clientId: 'cid', redirectUri: 'https://app.test/api/youtube/oauth/callback', state: 's', challenge: 'c' }));
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.match(u.searchParams.get('prompt') ?? '', /select_account/);
  assert.match(u.searchParams.get('prompt') ?? '', /consent/);
  assert.equal(u.searchParams.get('scope'), YOUTUBE_SCOPES.join(' '));
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});

test('YouTube upload: details first, then the bytes to the upload address; scheduled videos must be private', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response('', { status: 200, headers: { location: 'https://upload.test/session-1' } });
    return Response.json({ id: 'vid123' });
  }) as typeof fetch;
  const r = await uploadVideo('at', new Uint8Array([1, 2, 3]), { title: 'T', privacy: 'private', publishAt: '2026-10-27T13:30:00Z' }, fake);
  assert.equal(r.id, 'vid123');
  assert.match(calls[0].url, /uploadType=resumable/);
  const meta = JSON.parse(String(calls[0].init?.body));
  assert.equal(meta.status.privacyStatus, 'private');
  assert.equal(meta.status.publishAt, '2026-10-27T13:30:00Z');
  assert.equal(calls[1].url, 'https://upload.test/session-1');
  await assert.rejects(uploadVideo('at', new Uint8Array([1]), { title: 'T', privacy: 'public', publishAt: '2026-10-27T13:30:00Z' }, fake));
});

test('Instagram connect link asks for exactly the publishing permissions', () => {
  const u = new URL(instagramAuthUrl({ appId: '114', redirectUri: 'https://app.test/api/instagram/oauth/callback', state: 's' }));
  assert.equal(u.origin + u.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(u.searchParams.get('scope'), 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights');
});

test('Instagram code exchange strips "#_" and swaps for a long-lived token', async () => {
  process.env.IG_APP_ID = '114'; process.env.IG_APP_SECRET = 'appsecret';
  const seen: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push(url);
    if (url.startsWith('https://api.instagram.com')) {
      assert.equal(new URLSearchParams(String(init?.body)).get('code'), 'abc');
      return Response.json({ data: [{ access_token: 'short', user_id: '1' }] });
    }
    return Response.json({ access_token: 'long', expires_in: 5184000 });
  }) as typeof fetch;
  const t = await exchangeInstagramCode({ code: 'abc#_', redirectUri: 'https://app.test/cb' }, fake, 1000);
  assert.equal(t.accessToken, 'long');
  assert.equal(t.expiresAt, 1000 + 5184000 * 1000);
  assert.match(seen[1], /ig_exchange_token/);
});

test('Instagram token refresh: only when under 20 days left and at least a day old', () => {
  const now = 100 * 86400_000;
  assert.equal(needsRefresh({ expiresAt: now + 50 * 86400_000, refreshedAt: now - 10 * 86400_000 }, now), false);
  assert.equal(needsRefresh({ expiresAt: now + 10 * 86400_000, refreshedAt: now - 10 * 86400_000 }, now), true);
  assert.equal(needsRefresh({ expiresAt: now + 10 * 86400_000, refreshedAt: now - 3600_000 }, now), false);
});

test('Meta signed_request: accepted only with the app secret\'s signature', () => {
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 42, issued_at: 1 })).toString('base64url');
  const sig = createHmac('sha256', 'appsecret').update(payload).digest('base64url');
  assert.equal(parseSignedRequest(`${sig}.${payload}`, 'appsecret')?.user_id, '42');
  assert.equal(parseSignedRequest(`${sig}.${payload}`, 'wrong'), undefined);
  assert.equal(parseSignedRequest(`AAAA.${payload}`, 'appsecret'), undefined);
  assert.equal(parseSignedRequest(undefined, 'appsecret'), undefined);
  assert.equal(parseSignedRequest(`${sig}.${payload}`, ''), undefined);
});

test('gate: Meta\'s two callbacks are public; connecting, testing and the YouTube page are owner-only', () => {
  assert.equal(gate('/api/instagram/deauthorize', false), 'allow');
  assert.equal(gate('/api/instagram/data-deletion', false), 'allow');
  for (const p of ['/api/youtube/oauth/login', '/api/youtube/oauth/callback', '/api/instagram/oauth/login', '/api/instagram/oauth/callback', '/api/social/status', '/api/social/test', '/api/social/disconnect'])
    assert.equal(gate(p, false), 'deny-api', p);
  assert.equal(gate('/youtube', false), 'redirect-home');
});
