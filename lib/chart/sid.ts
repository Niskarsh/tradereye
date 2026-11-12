import { lookupSecurityId } from '../dhan';
import { getChunk, putChunk } from '../book/s3';

/**
 * A symbol's Dhan security id without downloading Dhan's whole instrument list each time (tens of MB, and every new
 * serverless instance would fetch it again: several chart tabs opening at once meant several parallel downloads).
 * Order: the id the page already knows, then S3 (charts/sid/<SYMBOL>.txt), then the instrument list once (saved).
 */
const mem = new Map<string, string>();
const key = (s: string) => `charts/sid/${s.replace(/&/g, '_')}.txt`;

export async function resolveSid(symbol: string, given?: string): Promise<string | undefined> {
  const s = symbol.toUpperCase();
  if (given && /^\d{1,10}$/.test(given)) { mem.set(s, given); return given; }
  const m = mem.get(s);
  if (m) return m;
  try {
    const b = await getChunk(key(s));
    const v = b ? new TextDecoder().decode(b).trim() : '';
    if (/^\d{1,10}$/.test(v)) { mem.set(s, v); return v; }
  } catch { /* not saved yet (AccessDenied without list rights) */ }
  const id = await lookupSecurityId(s);
  if (id) { mem.set(s, id); await putChunk(key(s), new TextEncoder().encode(id)).catch(() => undefined); }
  return id;
}
