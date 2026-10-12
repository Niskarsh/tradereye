import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';

/** Swaps a still-valid token for a fresh 24h one (Dhan's RenewToken). The old token stops working. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  if (!g.clientId) return NextResponse.json({ error: 'NO_CLIENT_ID', message: 'Could not read the client id from this token.' }, { status: 400 });
  try {
    const r = await g.dhan.renewToken(g.clientId);
    const accessToken = r.accessToken ?? r.token;
    if (!accessToken) return NextResponse.json({ error: 'RENEW_FAILED', message: 'Dhan did not return a new token.' }, { status: 502 });
    return NextResponse.json({ accessToken, expiryTime: r.expiryTime ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}
