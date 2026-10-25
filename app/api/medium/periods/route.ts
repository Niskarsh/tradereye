import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { periods } from '@/lib/medium/source';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** GET -> defaults for the Medium page's format picker (last week, last month, Me vs Algo weeks, Algo Lab iterations). */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try { return NextResponse.json(await periods()); } catch (e) { return errorResponse(e); }
}
