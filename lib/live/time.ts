// Time helpers. Dhan reports order/trade times as "YYYY-MM-DD HH:mm:ss" in IST (no zone marker).
// Everything here converts to/from epoch milliseconds so the rest of the code never touches Date parsing.

export const IST_OFFSET_MS = 330 * 60 * 1000;

export const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "2026-10-12 09:31:05" (IST) or an ISO string with a zone -> epoch ms. NaN if unparseable. */
export function parseIst(input: string | number | null | undefined): number {
  if (input === null || input === undefined || input === '') return NaN;
  if (typeof input === 'number') return input;
  const s = String(input).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return NaN;
  const [, y, mo, d, hh = '0', mm = '0', ss = '0'] = m;
  return Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss) - IST_OFFSET_MS;
}

export interface IstParts {
  y: number; mo: number; d: number; hh: number; mm: number; ss: number;
  dateKey: string; minuteOfDay: number; weekday: number;
}

export function istParts(ms: number): IstParts {
  const t = new Date(ms + IST_OFFSET_MS);
  const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1, d = t.getUTCDate();
  const hh = t.getUTCHours(), mm = t.getUTCMinutes(), ss = t.getUTCSeconds();
  return { y, mo, d, hh, mm, ss, dateKey: `${y}-${pad(mo)}-${pad(d)}`, minuteOfDay: hh * 60 + mm, weekday: t.getUTCDay() };
}

export const istDateKey = (ms: number) => istParts(ms).dateKey;
export const istTime = (ms: number) => { const p = istParts(ms); return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`; };
export const istDateTime = (ms: number) => `${istDateKey(ms)} ${istTime(ms)}`;

/** "2026-10-12" -> epoch ms of 00:00 IST that day. */
export function dateKeyToMs(dateKey: string): number {
  return parseIst(`${dateKey} 00:00:00`);
}

/** "2026-10-12" -> "october-2026" (the monthly sheet naming the app already uses). */
export function monthSheetTitle(dateKey: string): string {
  const [y, m] = dateKey.split('-');
  return `${MONTHS[Number(m) - 1]}-${y}`;
}

/** Normalise whatever a sheet cell holds for a date into "YYYY-MM-DD" ('' if unknown). */
export function normDate(v: unknown): string {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // dd/mm/yyyy (India locale)
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  return '';
}

/** Normalise a sheet time cell ("9:31:05", "09:31:05", "9:31:05 AM") into "HH:mm:ss" ('' if unknown). */
export function normTime(v: unknown): string {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return '';
  let hh = +m[1];
  const ap = m[4]?.toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  return `${pad(hh)}:${m[2]}:${pad(+(m[3] ?? 0))}`;
}

/** NSE cash session in minutes since midnight IST. */
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

/** Polling gets lazy outside market hours. */
export function isMarketHours(ms: number): boolean {
  const p = istParts(ms);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.minuteOfDay >= 9 * 60 && p.minuteOfDay <= 15 * 60 + 45;
}

export interface JwtInfo { dhanClientId?: string; exp?: number; expMs?: number }

/** Reads (does NOT verify) the payload of a Dhan access token. Used only for display and for RenewToken. */
export function decodeJwt(token: string): JwtInfo | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function'
      ? decodeURIComponent(Array.from(atob(b64), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
      : Buffer.from(b64, 'base64').toString('utf8');
    const p = JSON.parse(json) as { dhanClientId?: string; exp?: number };
    return { dhanClientId: p.dhanClientId, exp: p.exp, expMs: p.exp ? p.exp * 1000 : undefined };
  } catch {
    return null;
  }
}
