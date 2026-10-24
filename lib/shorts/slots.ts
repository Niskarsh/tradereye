/**
 * Posting times, all in IST (fixed +05:30, India has no daylight saving). Pure: used by the Socials page and the server.
 */

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Default posting days and times: Monday, Wednesday, Friday; Instagram at 11:00 IST, YouTube at 15:30 IST, same day. */
export const DEFAULT_DAYS = [1, 3, 5];
export const DEFAULT_TIME = '15:30';
export const DEFAULT_TIMES = { youtube: '15:30', instagram: '11:00' };
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

/** "Mon 26 Oct" in IST. */
export function istDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).replace(',', '');
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

/**
 * Default slots for the next `n` shorts: Mon / Wed / Fri, Instagram 11:00 and YouTube 15:30 IST on the same day.
 * A day is used only when its earlier post (Instagram) is still far enough ahead and neither time is taken.
 */
export function nextSlotPairs(n: number, now: number, taken: number[] = [], days = DEFAULT_DAYS, times = DEFAULT_TIMES): { youtube: number; instagram: number }[] {
  const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return (h * 60 + m) * 60_000; };
  const gap = mins(times.youtube) - mins(times.instagram);
  const out: { youtube: number; instagram: number }[] = [];
  const used = [...taken];
  while (out.length < n) {
    const [ig] = nextSlots(1, now, used.flatMap((t) => [t, t - gap]), days, times.instagram);
    if (ig === undefined) break;
    out.push({ instagram: ig, youtube: ig + gap });
    used.push(ig, ig + gap);
  }
  return out;
}
