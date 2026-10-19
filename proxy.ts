import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, readSession } from '@/lib/auth/session';
import { gate } from '@/lib/auth/gate';

/**
 * The gate in front of the whole app. Without the owner's Google session:
 *  - pages: only Home ("/"); anything else goes to Home with the sign-in prompt
 *  - APIs:  only the few public ones in lib/auth/gate.ts; anything else answers 401
 * Every private route also checks the session itself (guard() / ownerRequired), so this is the first of two locks.
 */
export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (gate(path, false) === 'allow') return NextResponse.next();
  const signedIn = !!(await readSession(req.cookies.get(SESSION_COOKIE)?.value));
  const g = gate(path, signedIn);
  if (g === 'allow') return NextResponse.next();
  if (g === 'deny-api') return NextResponse.json({ error: 'LOGIN_REQUIRED', message: 'Sign in with Google first.' }, { status: 401 });
  const to = new URL('/', req.url);
  to.searchParams.set('login', '1');
  to.searchParams.set('next', path + req.nextUrl.search);
  return NextResponse.redirect(to);
}

export const config = {
  // every API path, and every page except Next's own static files and public assets (paths with a file extension)
  matcher: ['/api/:path*', '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]{2,5}$).*)'],
};
