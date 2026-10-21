/**
 * The Algo Lab iteration ledger: one line per iteration run (from iteration 5 on), kept for good in S3
 * (lib/setups/store.ts ML_LEDGER_KEY), with the exact code version, so any iteration can be gone back to.
 */
export interface StratStats { n: number; netR: number; gross?: number; t: number; monthsGreen?: number; monthsTraded?: number }
export interface MlStrategy {
  id: string; name: string; overall: StratStats; dev: StratStats; exam: StratStats; ic?: { mean: number | null };
  costs?: { id: string; overall: StratStats }[];
}
export interface MlResult { v: number; iteration: number; runId: string; createdAt: number; code?: string | null; best?: string; changes?: string[]; strategies?: MlStrategy[] }
export interface LedgerLine { id: string; name: string; n: number; netR: number; gross: number | null; t: number; monthsGreen: number; monthsTraded: number; dev: number | null; exam: number | null; ic: number | null; sizes?: Record<string, number> }
export interface LedgerEntry { iteration: number; runId: string; createdAt: number; code: string | null; best: string | null; changes: string[]; lines: LedgerLine[] }

export function ledgerEntry(ml: MlResult): LedgerEntry {
  return {
    iteration: ml.iteration, runId: ml.runId, createdAt: ml.createdAt, code: ml.code ?? null, best: ml.best ?? null, changes: ml.changes ?? [],
    lines: (ml.strategies ?? []).map((s) => ({
      id: s.id, name: s.name, n: s.overall.n, netR: s.overall.netR, gross: s.overall.gross ?? null, t: s.overall.t,
      monthsGreen: s.overall.monthsGreen ?? 0, monthsTraded: s.overall.monthsTraded ?? 0,
      dev: s.dev?.n ? s.dev.netR : null, exam: s.exam?.n ? s.exam.netR : null, ic: s.ic?.mean ?? null,
      sizes: s.costs ? Object.fromEntries(s.costs.map((c) => [c.id, c.overall.netR])) : undefined,
    })),
  };
}
