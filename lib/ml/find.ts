import { INDEX_KEY, ML_LEDGER_KEY, getJson, mlIterKey, mlKey, type RunIndexItem, type Store } from '../setups/store';
import type { LedgerEntry } from './ledger';

type AnyMl = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The newest Algo Lab result that has a strategy (recent runs first, then the copies kept with each iteration), and
 * that strategy in it. Used for the live strategy (fCap2): its months (Model history) and its trades (My Setups).
 */
export async function newestWithStrategy(store: Store, strategy: string): Promise<{ ml: AnyMl; st: AnyMl } | null> {
  const runs = ((await getJson<RunIndexItem[]>(store, INDEX_KEY)) ?? []).map((r) => r.runId).slice(0, 15);
  const ledger = ((await getJson<LedgerEntry[]>(store, ML_LEDGER_KEY)) ?? []).slice().sort((a, b) => b.createdAt - a.createdAt);
  const tries = [...runs.map((runId) => ({ runId, key: mlKey(runId) })), ...ledger.map((e) => ({ runId: e.runId, key: mlIterKey(e.iteration, e.runId) }))];
  const seen = new Set<string>();
  for (const t of tries) {
    if (seen.has(t.runId)) continue;
    seen.add(t.runId);
    const ml = await getJson<AnyMl>(store, t.key).catch(() => undefined);
    const st = ml?.strategies?.find((x: AnyMl) => x.id === strategy);
    if (ml && st) return { ml, st };
  }
  return null;
}
