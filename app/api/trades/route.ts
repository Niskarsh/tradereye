import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

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