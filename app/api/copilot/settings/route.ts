import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { errorResponse, guard } from '@/lib/live/guard';
import { getRiskInr, setRiskInr } from '@/lib/copilot/userSettings';

export const dynamic = 'force-dynamic';

/** Read or change your max risk per trade. Body: {} to read, { riskInr: 400 } to change. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const sheets = getSheetsClient();
    if (b?.riskInr !== undefined) {
      const n = Number(b.riskInr);
      if (!(Number.isFinite(n) && n > 0)) return NextResponse.json({ error: 'BAD_VALUE', message: 'Risk must be a positive number of rupees.' }, { status: 400 });
      return NextResponse.json({ riskInr: await setRiskInr(sheets, n) });
    }
    return NextResponse.json({ riskInr: await getRiskInr(sheets) });
  } catch (e) {
    return errorResponse(e);
  }
}
