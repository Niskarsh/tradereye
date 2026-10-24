import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { instagramStatus, youtubeStatus } from '@/lib/social/connections';

export const dynamic = 'force-dynamic';

/** GET -> which accounts are connected (names and dates only, never tokens). Refreshes Instagram's token when due. */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const [youtube, instagram] = await Promise.all([
    youtubeStatus().catch((e) => ({ connected: false, problem: (e as Error).message })),
    instagramStatus().catch((e) => ({ connected: false, problem: (e as Error).message })),
  ]);
  return NextResponse.json({ youtube, instagram });
}
