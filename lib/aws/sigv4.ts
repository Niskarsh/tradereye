import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for a plain HTTPS call (used for EventBridge Scheduler, which has no SDK package here).
 * Returns the headers to send: host, x-amz-date, authorization (+ the ones given).
 */

export interface Creds { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signRequest(p: {
  method: string; url: string; region: string; service: string; creds: Creds; body?: string; headers?: Record<string, string>; now?: Date;
}): Record<string, string> {
  const u = new URL(p.url);
  const amzDate = (p.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20150830T123600Z
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...(p.headers ?? {}), host: u.host, 'x-amz-date': amzDate };
  if (p.creds.sessionToken) headers['x-amz-security-token'] = p.creds.sessionToken;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(lower).sort();
  const path = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/') || '/';
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [p.method.toUpperCase(), path, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), sha256(p.body ?? '')].join('\n');
  const scope = `${day}/${p.region}/${p.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${p.creds.secretAccessKey}`, day), p.region), p.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${p.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}
