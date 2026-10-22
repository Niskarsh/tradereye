import type { Candles } from '../dhan';
import { toSessions } from '../live/enrich';
import { toSlots } from '../setups/engine';
import { dailyKey, getJson, monthKey, type Store } from '../setups/store';
import { combo, manage, stage, variants, type ManagedTrade, type Row, type Staged, type Variant } from './manage';

/**
 * Runs the trade-management experiment on the trades of a finished Algo Lab result (decide months only: the exam
 * months and the untouched test never see a management variant). Reads each trade's day from the 1-minute candles the
 * backtest saved in S3. "As now" is replayed too and must match the model's own result for every trade.
 */

const IST = 19800_000;
const dateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);

export interface Management extends Staged { strategy: string; variantsTested: number; trades: number; baseChecked: number; baseMismatch: number; skippedNoData: number }

interface Strat { id: string; name: string; targetAdr?: number; tradeCols?: string[]; trades?: (string | number | null)[][] }

export async function manageAll(ml: { examFrom: string; strategies: Strat[] }, store: Store, log: (m: string) => void = () => {}): Promise<Management[]> {
  // load only the days the trades need (one S3 read per stock-month), keeping the minute slots of those days only
  const need = new Map<string, Set<string>>(); // "SYM|YYYY-MM" -> dates
  for (const st of ml.strategies) {
    const iDay = (st.tradeCols ?? []).indexOf('day'), iSym = (st.tradeCols ?? []).indexOf('sym');
    for (const t of st.trades ?? []) {
      const date = String(t[iDay]);
      if (date.slice(0, 7) >= ml.examFrom) continue;
      const key = `${t[iSym]}|${date.slice(0, 7)}`;
      if (!need.has(key)) need.set(key, new Set());
      need.get(key)!.add(date);
    }
  }
  const days = new Map<string, NonNullable<ReturnType<typeof toSlots>>>();
  const dailies = new Map<string, Candles>();
  const keys = [...need.keys()];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < keys.length) {
      const key = keys[next++];
      const [sym, month] = key.split('|');
      const m = await getJson<{ c: Candles }>(store, monthKey(sym, month)).catch(() => undefined);
      for (const s of m ? toSessions(m.c) : []) {
        if (!need.get(key)!.has(s.date)) continue;
        const sl = toSlots(s.bars);
        if (sl) { sl.bars = []; days.set(`${sym}|${s.date}`, sl); }
      }
      if (!dailies.has(sym)) { const dl = await getJson<{ c: Candles }>(store, dailyKey(sym)).catch(() => undefined); if (dl?.c) dailies.set(sym, dl.c); }
    }
  }));
  log(`management: ${days.size} trade days loaded from ${keys.length} stock-months`);
  const all = variants();
  const out: Management[] = [];
  for (const st of ml.strategies) {
    if (!st.trades?.length || !st.targetAdr) continue;
    const col = (name: string) => (st.tradeCols ?? []).indexOf(name);
    const [iDay, iSym, iTime, iNet] = [col('day'), col('sym'), col('time'), col('net')];
    const decide = st.trades.filter((t) => String(t[iDay]).slice(0, 7) < ml.examFrom);
    const rows: Row[] = [];
    const kept: ManagedTrade[] = [];
    let checked = 0, mismatch = 0, skipped = 0;
    for (const t of decide) {
      const date = String(t[iDay]), sym = String(t[iSym]), [hh, mm] = String(t[iTime]).split(':').map(Number);
      const k = hh * 60 + mm - 555;
      const day = days.get(`${sym}|${date}`), daily = dailies.get(sym);
      if (!day || !daily) { skipped++; continue; }
      const before = daily.t.map(dateOf).filter((x) => x < date).length;
      if (before < 10) { skipped++; continue; }
      let adr = 0;
      for (let i = before - 10; i < before; i++) adr += daily.h[i] - daily.l[i];
      adr /= 10;
      const tr = { day, k, close: day.c[k - 1], adr, targetAdr: st.targetAdr };
      const net: Record<string, number> = {}, adds: Record<string, number> = {};
      for (const v of all) { const o = manage(tr, v); net[v.id] = o.net; adds[v.id] = o.adds; }
      checked++;
      if (Math.abs(net.base - Number(t[iNet])) > 0.002) mismatch++;
      rows.push({ month: date.slice(0, 7), net, adds });
      kept.push(tr);
    }
    // stage 2 combinations: the best break-even with each of the best adds, replayed on every trade
    const comboNets = (be: Variant, as: Variant[]) => as.map((a) => {
      const c = combo(be, a);
      rows.forEach((r, i) => { const o = manage(kept[i], c); r.net[c.id] = o.net; r.adds[c.id] = o.adds; });
      return c;
    });
    const staged = stage(rows, all, comboNets);
    log(`management ${st.id}: ${rows.length} trades, ${all.length} variants, "as now" matched ${checked - mismatch}/${checked}, winner ${staged.winner}`);
    out.push({ strategy: st.id, variantsTested: all.length, trades: rows.length, baseChecked: checked, baseMismatch: mismatch, skippedNoData: skipped, ...staged });
  }
  return out;
}
