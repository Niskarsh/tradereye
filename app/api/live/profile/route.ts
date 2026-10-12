import { NextResponse } from 'next/server';
import { decodeJwt } from '@/lib/live/time';
import { errorResponse, guard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';

/** Checks the token against Dhan and reports when it expires and whether the Data API plan is active. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const p = await g.dhan.profile();
    const jwt = decodeJwt(g.token);
    return NextResponse.json({
      clientId: p.dhanClientId, tokenValidity: p.tokenValidity ?? null, expiresAtMs: jwt?.expMs ?? null,
      dataPlan: p.dataPlan ?? null, dataValidity: p.dataValidity ?? null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
