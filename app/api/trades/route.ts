import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';

export async function GET(request: Request) {
  const denied = ownerRequired(request); // signed-in owner only (second lock behind proxy.ts)
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  // the token comes in a header (never in the URL, where it would be logged); the query is a fallback for old clients
  const token = request.headers.get('x-dhan-token')?.trim() || searchParams.get('token');

  if (!token) return NextResponse.json({ error: 'Token is required' }, { status: 400 });

  try {
    const response = await fetch('https://api.dhan.co/v2/trades', {
      headers: {
        'Accept': 'application/json',
        'access-token': token,
      },
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch trades' }, { status: 500 });
  }
}