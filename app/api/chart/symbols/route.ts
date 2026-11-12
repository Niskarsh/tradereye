import { NextResponse } from 'next/server';
import { symbolsMatching } from '@/lib/dhan';
import { ownerRequired } from '@/lib/auth/owner';

export const dynamic = 'force-dynamic';

/** Symbol search for the Charts page: NSE equities from Dhan's instrument list, plus the Nifty 500 index. GET ?q=TATA */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  try {
    const q = (new URL(req.url).searchParams.get('q') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9&\-]{1,30}$/.test(q)) return NextResponse.json({ symbols: [] });
    const list = await symbolsMatching(q, 25);
    if ('NIFTY500'.startsWith(q) || q.startsWith('NIFTY')) list.unshift('NIFTY500');
    return NextResponse.json({ symbols: [...new Set(list)] });
  } catch (e) {
    return NextResponse.json({ symbols: [], error: (e as Error).message }, { status: 502 });
  }
}
