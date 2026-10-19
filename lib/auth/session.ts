/**
 * The owner's login session: a small signed cookie, no database.
 *
 *   te_session = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, AUTH_SECRET))
 *
 * Only the server knows AUTH_SECRET, so nobody can make or change a session cookie: editing the email inside breaks
 * the signature. The cookie is httpOnly (page scripts cannot read it), Secure (HTTPS only) and SameSite=Lax.
 * A session is accepted only if the signature is right, it has not expired, AND it is still the owner by today's
 * settings (OWNER_EMAIL, and OWNER_GOOGLE_ID when set), so changing those in Vercel logs old sessions out.
 * Without AUTH_SECRET nothing is ever accepted (fails closed).
 *
 * Web Crypto only (no packages), so the same code runs in proxy.ts and in route handlers.
 */

export const SESSION_COOKIE = 'te_session';
export const OAUTH_COOKIE = 'te_oauth';
export const SESSION_DAYS = 30;

export interface Session { email: string; sub: string; name?: string; picture?: string; iat: number; exp: number }

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) { k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); keyCache.set(secret, k); }
  return k;
}
const secretOf = (s?: string) => { const x = (s ?? process.env.AUTH_SECRET ?? '').trim(); return x.length >= 32 ? x : ''; };

/** Sign any small JSON value (sessions, and the short-lived login state). */
export async function sign(value: unknown, secret?: string): Promise<string> {
  const key = secretOf(secret);
  if (!key) throw new Error('AUTH_SECRET is not set (or shorter than 32 characters).');
  const body = b64url(enc.encode(JSON.stringify(value)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(key), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

/** The value inside a signed token, or undefined when it is missing, malformed or the signature is wrong. */
export async function unsign<T>(token: string | undefined, secret?: string): Promise<T | undefined> {
  const key = secretOf(secret);
  if (!key || !token) return undefined;
  const dot = token.indexOf('.');
  if (dot < 1 || dot !== token.lastIndexOf('.')) return undefined;
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  try {
    // crypto.subtle.verify compares in constant time
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(key), fromB64url(sig) as BufferSource, enc.encode(body));
    return ok ? JSON.parse(dec.decode(fromB64url(body))) as T : undefined;
  } catch { return undefined; }
}

/** Is this Google account the owner (by the settings in Vercel right now)? */
export function isOwnerAccount(email: string | undefined, sub: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const owner = (env.OWNER_EMAIL ?? '').trim().toLowerCase();
  const ownerId = (env.OWNER_GOOGLE_ID ?? '').trim();
  if (!owner || !email || !sub) return false;
  if (email.trim().toLowerCase() !== owner) return false;
  return !ownerId || sub === ownerId;
}

export async function createSession(p: { email: string; sub: string; name?: string; picture?: string }, now = Date.now(), secret?: string): Promise<string> {
  const iat = Math.floor(now / 1000);
  const s: Session = { email: p.email.toLowerCase(), sub: p.sub, name: p.name, picture: p.picture, iat, exp: iat + SESSION_DAYS * 86400 };
  return sign(s, secret);
}

/** The owner's session from a cookie value, or undefined (missing, forged, expired, or no longer the owner). */
export async function readSession(cookieValue: string | undefined, now = Date.now(), secret?: string, env: Record<string, string | undefined> = process.env): Promise<Session | undefined> {
  const s = await unsign<Session>(cookieValue, secret);
  if (!s || typeof s.exp !== 'number' || s.exp * 1000 <= now) return undefined;
  return isOwnerAccount(s.email, s.sub, env) ? s : undefined;
}

/** One cookie out of a Cookie header. */
export function cookieFrom(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** The owner's session for a request (route handlers). */
export function sessionFromRequest(req: Request): Promise<Session | undefined> {
  return readSession(cookieFrom(req.headers.get('cookie'), SESSION_COOKIE));
}
