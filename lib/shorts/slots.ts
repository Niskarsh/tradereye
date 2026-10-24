/**
 * Posting times, all in IST (fixed +05:30, India has no daylight saving). Pure: used by the Socials page and the server.
 */

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Default posting days and time: Monday, Wednesday, Friday at 18:30 IST (after market, evening scroll). */
export const DEFAULT_DAYS = [1, 3, 5];
export const DEFAULT_TIME = '18:30';
/** YouTube needs the publish time comfortably in the future; the page asks for at least this much. */
export const MIN_LEAD_MS = 15 * 60_000;

/** "2026-10-26T18:30" (what <input type="datetime-local"> shows) for a moment, in IST. */
export function toIstInput(ms: number): string {
  return new Date(ms + IST_MS).toISOString().slice(0, 16);
}

/** The moment an IST "2026-10-26T18:30" stands for, or NaN. */
export function fromIstInput(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST_MS;
}

/** "Mon 26 Oct, 6:30 pm" in IST. */
export function istLabel(ms: number): string {
  return new Date(ms).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}

/**
 * The next `n` free default slots after `now` (+ lead time): Mon / Wed / Fri 18:30 IST, skipping any slot already
 * taken by another scheduled short (within 30 minutes of it).
 */
export function nextSlots(n: number, now: number, taken: number[] = [], days = DEFAULT_DAYS, time = DEFAULT_TIME): number[] {
  const [hh, mm] = time.split(':').map(Number);
  const out: number[] = [];
  const ist = new Date(now + IST_MS);
  let day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  for (let i = 0; i < 400 && out.length < n; i++, day += DAY_MS) {
    if (!days.includes(new Date(day).getUTCDay())) continue;
    const at = day + (hh * 60 + mm) * 60_000 - IST_MS;
    if (at < now + MIN_LEAD_MS) continue;
    if ([...taken, ...out].some((t) => Math.abs(t - at) < 30 * 60_000)) continue;
    out.push(at);
  }
  return out;
}
