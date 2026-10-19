import { NextResponse } from 'next/server';
import { symbolsMatching } from '@/lib/dhan';
import { ownerRequired } from '@/lib/auth/owner';

export const dynamic = 'force-dynamic';

/** Symbol autocomplete from Dhan's public instrument list. GET ?q=TATA */
export async function GET(req: Request) {
  const denied = ownerRequired(req); // signed-in owner only (second lock behind proxy.ts)
  if (denied) return denied;
  try {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    if (!/^[A-Za-z0-9&\-]{1,30}$/.test(q)) return NextResponse.json({ symbols: [] });
    return NextResponse.json({ symbols: await symbolsMatching(q) });
  } catch (e) {
    return NextResponse.json({ symbols: [], error: (e as Error).message }, { status: 502 });
  }
}
