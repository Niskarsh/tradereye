import { b64url, fromB64url } from './session';

/**
 * "Sign in with Google", server side (OpenID Connect authorization-code flow with PKCE).
 *
 *  1. /api/auth/google/login sends the browser to Google with a random `state`, `nonce` and PKCE challenge (kept in a
 *     short-lived signed cookie).
 *  2. Google sends the browser back to /api/auth/google/callback with a one-time `code`.
 *  3. The server swaps the code for an ID token directly with Google, using GOOGLE_CLIENT_SECRET (never sent to the
 *     browser) and the PKCE verifier. The browser never hands us an email to trust.
 *  4. The ID token is still checked fully: Google's RS256 signature against Google's published keys, issuer, audience
 *     (our client id), expiry, nonce, email verified. Only then is the owner check made (email + Google account id).
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleClaims { sub: string; email: string; email_verified: boolean; name?: string; picture?: string; aud: string; iss: string; exp: number; iat: number; nonce?: string }
export interface LoginState { state: string; nonce: string; verifier: string; next: string; exp: number }

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

/** Only same-site paths are allowed as the place to go back to after login (no open redirect). */
export function safeNext(next: string | null | undefined): string {
  const n = (next ?? '').trim();
  return /^\/(?![/\\])[^\s]*$/.test(n) ? n : '/';
}

export function authUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', scope: 'openid email profile',
    state: p.state, nonce: p.nonce, code_challenge: p.challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `${AUTH_ENDPOINT}?${q}`;
}

export async function exchangeCode(p: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, cache: 'no-store',
    body: new URLSearchParams({ code: p.code, code_verifier: p.verifier, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code' }),
  });
  const j = await res.json().catch(() => ({})) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !j.id_token) throw new Error(`Google did not complete the sign-in (${j.error_description ?? j.error ?? `HTTP ${res.status}`}).`);
  return j.id_token;
}

type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { at: number; keys: Jwk[] } | undefined;
async function googleKeys(fetchImpl: typeof fetch, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetchImpl(JWKS_URL, { cache: 'no-store' });
  const j = await r.json() as { keys?: Jwk[] };
  if (!r.ok || !Array.isArray(j.keys)) throw new Error('Could not load Google\'s signing keys.');
  jwksCache = { at: Date.now(), keys: j.keys };
  return j.keys;
}

/** A Google ID token's claims, only if every check passes; otherwise it throws with the reason. */
export async function verifyIdToken(idToken: string, p: { clientId: string; nonce: string; now?: number }, fetchImpl: typeof fetch = fetch): Promise<GoogleClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token.');
  const dec = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)));
  const header = dec(parts[0]) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unexpected ID token algorithm.');
  let jwk = (await googleKeys(fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(fetchImpl, true)).find((k) => k.kid === header.kid); // Google rotated its keys
  if (!jwk) throw new Error('ID token signed with an unknown key.');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]) as BufferSource, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('ID token signature is not valid.');
  const c = dec(parts[1]) as GoogleClaims;
  const now = Math.floor((p.now ?? Date.now()) / 1000);
  if (!ISSUERS.includes(c.iss)) throw new Error('ID token is not from Google.');
  if (c.aud !== p.clientId) throw new Error('ID token was issued for a different app.');
  if (typeof c.exp !== 'number' || c.exp + 60 < now) throw new Error('ID token has expired.');
  if (!c.nonce || c.nonce !== p.nonce) throw new Error('ID token does not belong to this sign-in.');
  if (c.email_verified !== true && (c.email_verified as unknown) !== 'true') throw new Error('Google has not verified this email.');
  if (!c.sub || !c.email) throw new Error('ID token has no account id or email.');
  return c;
}

/** Where Google sends the browser back to (APP_URL wins, else the site the request came to). */
export function redirectUri(req: Request): string {
  const base = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '') || new URL(req.url).origin;
  return `${base}/api/auth/google/callback`;
}
