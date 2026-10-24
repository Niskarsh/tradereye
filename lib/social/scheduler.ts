import { randomUUID } from 'node:crypto';
import { signRequest } from '../aws/sigv4';

/**
 * EventBridge Scheduler: one-time "wake-ups" for posting. Each wake-up calls the Lambda "tradereye-social-timer"
 * (infra/social-timer), which calls POST /api/social/tick on tradereye with CRON_SECRET. One wake-up per step, each
 * with its own name, deleted by AWS after it runs. Cost: free (14M invocations a month free; this uses ~30).
 *
 * Env: SOCIAL_TIMER_LAMBDA_ARN, SOCIAL_TIMER_ROLE_ARN (the role Scheduler uses to call the Lambda), plus the same
 * AWS key / region as S3. The key needs scheduler:CreateSchedule + scheduler:DeleteSchedule on schedule/default/tr-*,
 * and iam:PassRole on the role.
 */

export class SchedulerError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

export const WAKE_PREFIX = 'tr-';

export function schedulerConfig(env: Record<string, string | undefined> = process.env) {
  const lambdaArn = env.SOCIAL_TIMER_LAMBDA_ARN?.trim(), roleArn = env.SOCIAL_TIMER_ROLE_ARN?.trim();
  const region = env.AWS_REGION?.trim(), accessKeyId = env.AWS_ACCESS_KEY_ID?.trim(), secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!lambdaArn || !roleArn) throw new SchedulerError('The posting timer is not set up: SOCIAL_TIMER_LAMBDA_ARN / SOCIAL_TIMER_ROLE_ARN are missing in Vercel.');
  if (!region || !accessKeyId || !secretAccessKey) throw new SchedulerError('AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are missing.');
  // the Lambda's own region (Scheduler must live in the same region as its schedules; the target may be anywhere)
  const schedRegion = /^arn:aws:lambda:([a-z0-9-]+):/.exec(lambdaArn)?.[1] ?? region;
  return { lambdaArn, roleArn, region: schedRegion, creds: { accessKeyId, secretAccessKey } };
}

/** "tr-ig-<shortId>-<minute>" (unique per step, so a running wake-up is never edited while AWS deletes it). */
export const wakeName = (platform: 'ig', shortId: string, at: number) => `${WAKE_PREFIX}${platform}-${shortId}-${Math.floor(at / 60_000)}`.slice(0, 64);

/** at(...) wants UTC without a zone suffix: "2026-10-26T13:00:00". */
export const atExpression = (at: number) => `at(${new Date(Math.ceil(at / 1000) * 1000).toISOString().slice(0, 19)})`;

async function call(method: 'POST' | 'DELETE', name: string, body: unknown, fetchImpl: typeof fetch, env?: Record<string, string | undefined>) {
  const c = schedulerConfig(env);
  const url = `https://scheduler.${c.region}.amazonaws.com/schedules/${encodeURIComponent(name)}${method === 'DELETE' ? `?clientToken=${randomUUID()}` : ''}`;
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = signRequest({ method, url, region: c.region, service: 'scheduler', creds: c.creds, body: text, headers: text ? { 'content-type': 'application/json' } : {} });
  const res = await fetchImpl(url, { method, headers, body: text || undefined, cache: 'no-store' });
  return { res, c };
}

async function why(res: Response): Promise<string> {
  const j = await res.json().catch(() => ({})) as { message?: string; Message?: string };
  const type = res.headers.get('x-amzn-errortype')?.split(':')[0] ?? '';
  const msg = j.message ?? j.Message ?? `HTTP ${res.status}`;
  const hint = res.status === 403 ? ' (the AWS key needs scheduler:CreateSchedule / DeleteSchedule and iam:PassRole on the timer role)' : '';
  return `${type ? `${type}: ` : ''}${msg}${hint}`;
}

/** A one-time wake-up at `at` (moved to a minute from now when that is already past). */
export async function createWake(name: string, at: number, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch, env?: Record<string, string | undefined>, now = Date.now()): Promise<void> {
  const when = Math.max(at, now + 60_000);
  const cfg = schedulerConfig(env);
  const body = {
    ClientToken: randomUUID(),  // required by the plain HTTPS API (the AWS SDKs add one themselves)
    ScheduleExpression: atExpression(when), ScheduleExpressionTimezone: 'UTC', FlexibleTimeWindow: { Mode: 'OFF' },
    ActionAfterCompletion: 'DELETE', State: 'ENABLED', Description: 'tradereye: Instagram posting step',
    Target: { Arn: cfg.lambdaArn, RoleArn: cfg.roleArn, Input: JSON.stringify(input), RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 900 } },
  };
  const { res } = await call('POST', name, body, fetchImpl, env);
  if (res.ok || res.status === 409) return;           // 409: already there (same name = same step)
  throw new SchedulerError(`Setting the posting timer failed: ${await why(res)}`, res.status);
}

/** Removes a wake-up; one that already ran (and was deleted by AWS) counts as removed. */
export async function deleteWake(name: string, fetchImpl: typeof fetch = fetch, env?: Record<string, string | undefined>): Promise<void> {
  const { res } = await call('DELETE', name, undefined, fetchImpl, env);
  if (res.ok || res.status === 404) return;
  throw new SchedulerError(`Removing the posting timer failed: ${await why(res)}`, res.status);
}
