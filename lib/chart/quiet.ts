/**
 * Algo Live needs Dhan's data API right after each of its 10-minute closes (09:25 shortlist, then 09:35 .. 10:55): it
 * fetches every stock on its list within a few seconds and places orders. The charts stay off Dhan's REST API in the
 * two minutes after each of those closes so they never compete with it (Dhan allows a few data requests a second).
 * The live price feed (websocket) is not affected: it is a different Dhan service.
 */

const IST_MS = 330 * 60_000;
const OPEN_MIN = 9 * 60 + 15;
/** minutes after 09:15 of Algo Live's closes */
export const ALGO_CLOSES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
export const QUIET_SEC = 120;

/** ms until the charts may call Dhan's REST API again (0 = now is fine) */
export function algoQuietMs(nowMs: number = Date.now()): number {
  const t = new Date(nowMs + IST_MS);
  const wd = t.getUTCDay();
  if (wd === 0 || wd === 6) return 0;
  const sec = t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds() + t.getUTCMilliseconds() / 1000 - OPEN_MIN * 60;
  for (const k of ALGO_CLOSES) {
    const from = k * 60;
    if (sec >= from && sec < from + QUIET_SEC) return Math.ceil((from + QUIET_SEC - sec) * 1000);
  }
  return 0;
}
