import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { inspectVolume } from '@/lib/live/backfill';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, guard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Raw volume per session for one trade, to sanity-check relative volume against a chart. Read-only. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const { tab, groupId } = await req.json();
    return NextResponse.json(await inspectVolume({ dhan: g.dhan, sheets: getSheetsClient(), lookupSecurityId: (s) => lookupSecurityId(s) }, { tab, groupId }));
  } catch (e) {
    return errorResponse(e);
  }
}
