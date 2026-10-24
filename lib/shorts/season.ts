import { getJson, putJson } from '../setups/store';
import { store } from './store';
import type { WeekScore } from './trades';

/**
 * The Me vs Algo season ledger: every week's result, frozen the first time a short uses it, so a score shown to viewers
 * can never drift when the journal changes later (a stop backfilled, a trade edited). Kept in S3 at shorts/season.json.
 *
 * - Generating a Me vs Algo short freezes that week AND every earlier finished week not frozen yet, so the season score
 *   in the video ("ME 2 - 1 ALGO") is built only from frozen weeks.
 * - Later shorts read frozen weeks from here; they are never recomputed.
 * - Re-score (a deliberate button) recomputes one week from today's data; the old result is kept in its history.
 */

export const SEASON_KEY = 'shorts/season.json';

export interface FrozenWeek extends WeekScore {
  frozenAt: number;
  rescoredAt?: number;
  /** earlier results of this week, oldest first, kept when it was re-scored */
  history?: (WeekScore & { frozenAt: number })[];
}
export interface Ledger { v: 1; weeks: Record<string, FrozenWeek> }

export const emptyLedger = (): Ledger => ({ v: 1, weeks: {} });

export async function loadLedger(): Promise<Ledger> {
  const l = await getJson<Ledger>(store, SEASON_KEY);
  return l && l.v === 1 && l.weeks ? l : emptyLedger();
}
export async function saveLedger(l: Ledger): Promise<void> { await putJson(store, SEASON_KEY, l); }

const pick = (w: WeekScore): WeekScore => ({ week: w.week, me: { ...w.me }, algo: { ...w.algo }, winner: w.winner });

/** Freeze every computed week up to and including `upTo` that is not frozen yet. Returns the new ledger and whether it changed. */
export function freezeThrough(l: Ledger, computed: WeekScore[], upTo: string, now = Date.now()): { ledger: Ledger; changed: boolean } {
  const weeks = { ...l.weeks };
  let changed = false;
  for (const w of computed) {
    if (w.week > upTo || weeks[w.week]) continue;
    weeks[w.week] = { ...pick(w), frozenAt: now };
    changed = true;
  }
  return { ledger: { v: 1, weeks }, changed };
}

/** The season as shown: frozen weeks as frozen, the rest as computed today. */
export function mergedWeeks(l: Ledger, computed: WeekScore[]): (WeekScore & { frozenAt?: number; rescoredAt?: number })[] {
  const all = new Map<string, WeekScore & { frozenAt?: number; rescoredAt?: number }>();
  for (const w of computed) all.set(w.week, w);
  for (const f of Object.values(l.weeks)) all.set(f.week, { ...pick(f), frozenAt: f.frozenAt, rescoredAt: f.rescoredAt });
  return [...all.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

/** True when today's data would score a frozen week differently (shown as a warning next to the week). */
export function drifted(f: WeekScore | undefined, now: WeekScore | undefined): boolean {
  if (!f || !now) return false;
  return f.winner !== now.winner || f.me.r !== now.me.r || f.algo.r !== now.algo.r || f.me.n !== now.me.n || f.algo.n !== now.algo.n;
}

/** Re-score one week from today's data (deliberate). The previous result goes into the week's history. */
export function rescore(l: Ledger, now: WeekScore, at = Date.now()): Ledger {
  const old = l.weeks[now.week];
  const history = old ? [...(old.history ?? []), { ...pick(old), frozenAt: old.rescoredAt ?? old.frozenAt }] : [];
  return { v: 1, weeks: { ...l.weeks, [now.week]: { ...pick(now), frozenAt: old?.frozenAt ?? at, rescoredAt: at, history } } };
}
