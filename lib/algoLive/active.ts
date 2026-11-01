import type { LiveModel } from './model';

/**
 * Which Algo Lab iteration Algo Live is trading: the model says so itself (scripts/ml_live.py writes `iteration` and
 * `strategyName` from Nov 2026). Models made before that all traded fCap2, which iteration 10 picked.
 */
export interface Active { iteration: number | null; strategy: string; name: string; month: string; runId: string | null; runAt: string | null; dataTo: string | null; createdAt: number; standAside: boolean }

const BEFORE_LABEL: Record<string, { iteration: number; name: string }> = { fCap2: { iteration: 10, name: 'F to 10:55, first 2 a day' } };

/** a run id is `YYYY-MM-DD-HH-MM-xxxx` (IST): its date and time, for showing */
export function runAt(runId?: string | null): string | null {
  const m = runId?.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${d}, ${m[4]}:${m[5]}`;
}

export function activeOf(m: Pick<LiveModel, 'strategy' | 'iteration' | 'strategyName' | 'month' | 'runId' | 'dataTo' | 'createdAt' | 'standAside'>): Active {
  const old = BEFORE_LABEL[m.strategy];
  return {
    iteration: typeof m.iteration === 'number' ? m.iteration : old?.iteration ?? null,
    strategy: m.strategy, name: m.strategyName ?? old?.name ?? m.strategy, month: m.month,
    runId: m.runId ?? null, runAt: runAt(m.runId), dataTo: m.dataTo ?? null, createdAt: m.createdAt, standAside: m.standAside,
  };
}
