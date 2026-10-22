import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The bridge to trading-scaler (the app on the EC2 server whose fixed IP Dhan allows to place orders).
 *
 * Every call is sealed with AES-256-GCM under a key both apps derive from TE_SHARED_SECRET: nobody without the secret can
 * read it (it carries the Dhan token) or forge it, even over plain HTTP. Each call carries the time and a random nonce;
 * trading-scaler refuses anything older than a minute or seen before. (The same code lives in trading-scaler's
 * src/lib/te.ts.)
 */

const AAD = Buffer.from('tradereye-scaler-v1');

export interface Sealed { v: 1; iv: string; tag: string; data: string }

const keyOf = (secret: string) => createHash('sha256').update(secret, 'utf8').digest();

export function seal(secret: string, payload: Record<string, unknown>, now = Date.now()): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  c.setAAD(AAD);
  const data = Buffer.concat([c.update(JSON.stringify({ ...payload, ts: now, nonce: randomBytes(12).toString('hex') }), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** opens a sealed message; throws when the key is wrong or anything was changed */
export function open<T = Record<string, unknown>>(secret: string, s: Sealed): T & { ts: number; nonce: string } {
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(s.iv, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  const text = Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8');
  return JSON.parse(text);
}

export interface ScalerOrder { symbol: string; securityId: string; qty: number; targetPrice: number; stopLossPrice: number; correlationId: string }
export interface ScalerPlaced { symbol: string; correlationId: string; orderId?: string; orderStatus?: string; error?: string }
export interface ScalerLeg { legName: string; orderStatus: string; price: number }
export interface ScalerSuper { orderId: string; correlationId: string; symbol: string; orderStatus: string; qty: number; filledQty: number; avgPrice: number; legs: ScalerLeg[]; error?: string }
export interface ScalerStatus { orders: ScalerSuper[]; positions: { symbol: string; securityId: string; netQty: number; realized: number; unrealized: number }[]; squaredOffAt?: number | null; maxPerDay: number }

export class ScalerError extends Error {}

function config() {
  const url = process.env.TRADING_SCALER_URL?.replace(/\/+$/, '');
  const secret = process.env.TE_SHARED_SECRET;
  if (!url || !secret) throw new ScalerError('trading-scaler is not set up: TRADING_SCALER_URL and TE_SHARED_SECRET are missing on Vercel.');
  return { url, secret };
}

async function call<T>(action: string, token: string, body: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  const { url, secret } = config();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/api/te`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seal(secret, { action, token, ...body })), signal: ctl.signal, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ScalerError(String((j as { error?: string }).error ?? `trading-scaler answered HTTP ${r.status}`));
    return j as T;
  } catch (e) {
    if (e instanceof ScalerError) throw e;
    throw new ScalerError(`trading-scaler could not be reached: ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message}`);
  } finally { clearTimeout(timer); }
}

export const scaler = {
  ping: (token: string) => call<{ ok: true; now: number; ip?: string; maxPerDay: number }>('ping', token),
  place: (token: string, orders: ScalerOrder[]) => call<{ placed: ScalerPlaced[] }>('place', token, { orders }, 30_000),
  status: (token: string) => call<ScalerStatus>('status', token),
  squareOff: (token: string) => call<{ done: string[]; errors: string[] }>('squareoff', token, {}, 60_000),
};
