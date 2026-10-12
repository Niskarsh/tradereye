import { NextResponse } from 'next/server';
import { DhanClient, DhanError, clientIdFromToken } from '../dhan';
import { SheetsApiError } from '../sheetsApi';

/** Reads the Dhan token from the request. It is sent in a header, never in a URL, and never logged. */
export function tokenFrom(req: Request): string {
  const h = req.headers.get('x-dhan-token') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return h.trim();
}

export type Guarded = { ok: true; token: string; clientId?: string; dhan: DhanClient } | { ok: false; res: NextResponse };

/**
 * Every live/backfill route goes through this. These routes can write to your sheet, so when
 * ALLOWED_DHAN_CLIENT_ID is set only a token issued for that Dhan account is accepted.
 * (Dhan itself still validates the token on every call; this is an extra lock, not a replacement.)
 */
export function guard(req: Request): Guarded {
  const token = tokenFrom(req);
  if (!token) return { ok: false, res: NextResponse.json({ error: 'TOKEN_MISSING', message: 'Paste your Dhan access token first.' }, { status: 401 }) };
  const clientId = clientIdFromToken(token);
  const allowed = process.env.ALLOWED_DHAN_CLIENT_ID?.trim();
  if (allowed && clientId !== allowed) {
    return { ok: false, res: NextResponse.json({ error: 'FORBIDDEN', message: 'This token belongs to a different Dhan account.' }, { status: 403 }) };
  }
  return { ok: true, token, clientId, dhan: new DhanClient({ token }) };
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof DhanError) {
    if (e.isAuth) return NextResponse.json({ error: 'TOKEN_EXPIRED', message: 'Dhan rejected the token (expired or invalid). Generate a new one and paste it.' }, { status: 401 });
    if (e.isNoDataPlan) return NextResponse.json({ error: 'NO_DATA_PLAN', message: 'Market data needs the Dhan Data API plan, which is not active on this account.' }, { status: 402 });
    if (e.isRateLimited) return NextResponse.json({ error: 'RATE_LIMITED', message: 'Dhan is rate limiting. Try again in a few seconds.' }, { status: 429 });
    return NextResponse.json({ error: 'DHAN_ERROR', message: e.message }, { status: 502 });
  }
  if (e instanceof SheetsApiError) return NextResponse.json({ error: 'SHEETS_ERROR', message: e.message }, { status: 502 });
  return NextResponse.json({ error: 'SERVER_ERROR', message: (e as Error)?.message ?? 'Unexpected error' }, { status: 500 });
}
