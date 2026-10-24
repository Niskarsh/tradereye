import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { liveYouTube } from '@/lib/social/connections';
import { myPlaylists } from '@/lib/social/youtube';

export const dynamic = 'force-dynamic';

/** GET -> the Candles Before Cubicles channel's playlists (for the schedule editor). */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ playlists: await myPlaylists((await liveYouTube()).accessToken) });
  } catch (e) {
    return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 502 });
  }
}
