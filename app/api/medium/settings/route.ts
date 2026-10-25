import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { loadSettings, saveSettings } from '@/lib/medium/articles';
import { mediumStore } from '@/lib/medium/store';

export const dynamic = 'force-dynamic';

/** GET / PUT the Medium settings: publications he writes for, and his secret terms (encrypted in S3). */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try { return NextResponse.json(await loadSettings(mediumStore)); } catch (e) { return errorResponse(e); }
}

export async function PUT(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try { return NextResponse.json(await saveSettings(mediumStore, await req.json())); } catch (e) { return errorResponse(e); }
}
