import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { findCheck, updateCheck } from '@/lib/copilot/store';

export const dynamic = 'force-dynamic';

/** "Took it" / "Skipped" on a check. Body: { checkId, date, decision: 'TOOK'|'SKIPPED' }. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const decision = b?.decision === 'TOOK' ? 'TOOK' : b?.decision === 'SKIPPED' ? 'SKIPPED' : '';
    const date = String(b?.date ?? '');
    if (!decision || !b?.checkId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing check or decision.' }, { status: 400 });
    const sheets = getSheetsClient();
    const found = await findCheck(sheets, date, String(b.checkId));
    if (!found) return NextResponse.json({ error: 'NOT_FOUND', message: 'That check is not in the sheet.' }, { status: 404 });
    await updateCheck(sheets, found, { Decision: decision });
    return NextResponse.json({ ok: true, decision });
  } catch (e) {
    return errorResponse(e);
  }
}
