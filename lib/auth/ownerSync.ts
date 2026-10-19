import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, cookieFrom, fromB64url, isOwnerAccount, type Session } from './session';

/**
 * The same session check as lib/auth/session.ts, done synchronously with Node's crypto so it can sit inside the
 * existing guard() (used by almost every API route) without changing how those routes call it.
 */
export function ownerSessionSync(req: Request, now = Date.now(), env: Record<string, string | undefined> = process.env): Session | undefined {
  const secret = (env.AUTH_SECRET ?? '').trim();
  const token = cookieFrom(req.headers.get('cookie'), SESSION_COOKIE);
  if (secret.length < 32 || !token) return undefined;
  const dot = token.indexOf('.');
  if (dot < 1 || dot !== token.lastIndexOf('.')) return undefined;
  const body = token.slice(0, dot);
  try {
    const want = createHmac('sha256', secret).update(body).digest();
    const got = Buffer.from(fromB64url(token.slice(dot + 1)));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    const s = JSON.parse(Buffer.from(fromB64url(body)).toString('utf8')) as Session;
    if (typeof s.exp !== 'number' || s.exp * 1000 <= now) return undefined;
    return isOwnerAccount(s.email, s.sub, env) ? s : undefined;
  } catch { return undefined; }
}
