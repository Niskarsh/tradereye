import { NextResponse } from 'next/server';
import { ownerSessionSync } from './ownerSync';
export { ownerSessionSync };

/** undefined when the owner is signed in, otherwise the 401 to send back. */
export function ownerRequired(req: Request): NextResponse | undefined {
  return ownerSessionSync(req) ? undefined : NextResponse.json({ error: 'LOGIN_REQUIRED', message: 'Sign in with Google first.' }, { status: 401 });
}
