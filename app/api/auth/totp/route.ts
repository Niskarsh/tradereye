import { NextResponse } from 'next/server';
import { decodeJwt } from '@/lib/live/time';
import { ownerRequired } from '@/lib/auth/owner';

export const dynamic = 'force-dynamic';

/**
 * Dhan access token from a TOTP (Dhan's generateAccessToken). The client id and MPIN live only in Vercel env
 * (DHAN_CLIENT_ID, DHAN_MPIN) and are never sent to the browser or logged. Body: { totp: "123456" }.
 */
export async function POST(req: Request) {
  const denied = ownerRequired(req); // signed-in owner only (second lock behind proxy.ts)
  if (denied) return denied;
  const clientId = (process.env.DHAN_CLIENT_ID || process.env.ALLOWED_DHAN_CLIENT_ID || '').trim();
  const pin = (process.env.DHAN_MPIN || '').trim();
  if (!clientId || !pin) {
    return NextResponse.json({ error: 'NOT_CONFIGURED', message: 'Set DHAN_CLIENT_ID and DHAN_MPIN in Vercel (Settings → Environment Variables), then redeploy.' }, { status: 503 });
  }
  const b = await req.json().catch(() => ({}));
  const totp = String(b?.totp ?? '').trim();
  if (!/^\d{6}$/.test(totp)) return NextResponse.json({ error: 'BAD_TOTP', message: 'Enter the 6-digit code from your authenticator.' }, { status: 400 });
  try {
    const qs = new URLSearchParams({ dhanClientId: clientId, pin, totp });
    const res = await fetch(`https://auth.dhan.co/app/generateAccessToken?${qs}`, { method: 'POST', cache: 'no-store' });
    const text = await res.text();
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    const accessToken = String(j.accessToken ?? '');
    if (!res.ok || !accessToken) {
      const msg = String(j.message ?? j.errorMessage ?? j.remarks ?? j.status ?? (text.slice(0, 160) || `HTTP ${res.status}`));
      return NextResponse.json({ error: 'DHAN_LOGIN_FAILED', message: `Dhan did not issue a token: ${msg}` }, { status: res.status >= 400 ? res.status : 502 });
    }
    return NextResponse.json({ accessToken, expiresAtMs: decodeJwt(accessToken)?.expMs ?? null });
  } catch (e) {
    return NextResponse.json({ error: 'DHAN_UNREACHABLE', message: `Could not reach Dhan: ${(e as Error).message}` }, { status: 502 });
  }
}
