import { timingSafeEqual } from 'node:crypto';

/**
 * The lock on the timer-only endpoints (called by AWS Lambdas, not by a signed-in browser): the request must carry
 * "Authorization: Bearer <CRON_SECRET>". 'unset' when CRON_SECRET is missing or shorter than 24 characters.
 */
export function cronCheck(req: Request, env: Record<string, string | undefined> = process.env): 'ok' | 'unset' | 'denied' {
  const secret = env.CRON_SECRET?.trim() ?? '';
  if (secret.length < 24) return 'unset';
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'denied';
}
