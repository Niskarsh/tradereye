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

/* ---- iteration 9: confirm one rule fixed in advance (no search) -------------------------------------------- */

/** the add rule iteration 8 picked for B on the second half of its decide months, fixed before iteration 9 ran */
export const CONFIRM: Record<string, string> = { wideShort: 'a1-p0.4-x1-b1-tx1.5-r1' };

type Trade = (string | number | null)[];
interface Part { n: number; base: number; rule: number; diff: number; t: number; monthsGreenBase: number; monthsGreenRule: number; months: number; addRate: number }
export interface Confirmed { strategy: string; rule: string; label: string; decide: Part; exam: { pass: boolean | null; n: number }; untouched: Part | null; shadow: Part | null; baseMismatch: number; skippedNoData: number }

async function loadDays(store: Store, items: { sym: string; date: string }[]) {
  const need = new Map<string, Set<string>>();
  for (const { sym, date } of items) {
    const key = `${sym}|${date.slice(0, 7)}`;
    if (!need.has(key)) need.set(key, new Set());
    need.get(key)!.add(date);
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
  return { days, dailies };
}

function part(rows: { month: string; base: number; rule: number; added: boolean }[]): Part | null {
  const n = rows.length;
  if (!n) return null;
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const d = rows.map((r) => r.rule - r.base), md = mean(d);
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - md) ** 2, 0) / Math.max(1, n - 1));
  const byMonth = new Map<string, { b: number; r: number }>();
  for (const r of rows) { const m = byMonth.get(r.month) ?? { b: 0, r: 0 }; m.b += r.base; m.r += r.rule; byMonth.set(r.month, m); }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n, base: r3(mean(rows.map((r) => r.base))), rule: r3(mean(rows.map((r) => r.rule))), diff: r3(md), t: sd > 0 ? Math.round((md / (sd / Math.sqrt(n))) * 100) / 100 : 0,
    monthsGreenBase: [...byMonth.values()].filter((m) => m.b > 0).length, monthsGreenRule: [...byMonth.values()].filter((m) => m.r > 0).length, months: byMonth.size,
    addRate: r3(rows.filter((r) => r.added).length / n),
  };
}

/**
 * Replays the fixed rule (and "as now") on every trade of the strategy: decide months, exam months (Pass / Fail only),
 * the untouched months (that strategy's untouched trades) and the shadow months. Nothing is chosen here.
 */
export async function confirmAll(ml: { examFrom: string; shadowFrom?: string; strategies: Strat[]; untouched?: (Strat & { trades?: Trade[] })[] }, store: Store, log: (m: string) => void = () => {}): Promise<Confirmed[]> {
  const shadowFrom = ml.shadowFrom ?? '9999-99';
  const jobs: { st: Strat; rule: Variant; sets: Record<'decide' | 'exam' | 'untouched' | 'shadow', Trade[]>; cols: string[] }[] = [];
  const all = variants();
  for (const st of ml.strategies) {
    const ruleId = CONFIRM[st.id];
    const rule = all.find((v) => v.id === ruleId);
    if (!rule || !st.trades?.length || !st.targetAdr) continue;
    const cols = st.tradeCols ?? [];
    const iDay = cols.indexOf('day');
    const m = (t: Trade) => String(t[iDay]).slice(0, 7);
    const un = (ml.untouched ?? []).find((u) => u.id === st.id);
    jobs.push({ st, rule, cols, sets: {
      decide: st.trades.filter((t) => m(t) < ml.examFrom),
      exam: st.trades.filter((t) => m(t) >= ml.examFrom && m(t) < shadowFrom),
      shadow: st.trades.filter((t) => m(t) >= shadowFrom),
      untouched: un?.trades ?? [],
    } });
  }
  const items = jobs.flatMap((j) => Object.values(j.sets).flat().map((t) => ({ sym: String(t[j.cols.indexOf('sym')]), date: String(t[j.cols.indexOf('day')]) })));
  const { days, dailies } = await loadDays(store, items);
  const out: Confirmed[] = [];
  for (const { st, rule, sets, cols } of jobs) {
    const [iDay, iSym, iTime, iNet] = ['day', 'sym', 'time', 'net'].map((c) => cols.indexOf(c));
    let mismatch = 0, skipped = 0;
    const replay = (list: Trade[]) => list.flatMap((t) => {
      const date = String(t[iDay]), sym = String(t[iSym]), [hh, mm] = String(t[iTime]).split(':').map(Number);
      const k = hh * 60 + mm - 555;
      const day = days.get(`${sym}|${date}`), daily = dailies.get(sym);
      const before = daily ? daily.t.map(dateOf).filter((x) => x < date).length : 0;
      if (!day || !daily || before < 10) { skipped++; return []; }
      let adr = 0;
      for (let i = before - 10; i < before; i++) adr += daily.h[i] - daily.l[i];
      const tr: ManagedTrade = { day, k, close: day.c[k - 1], adr: adr / 10, targetAdr: st.targetAdr! };
      const base = manage(tr, { id: 'base', family: 'base', label: '' }), r = manage(tr, rule);
      if (Math.abs(base.net - Number(t[iNet])) > 0.002) mismatch++;
      return [{ month: date.slice(0, 7), base: base.net, rule: r.net, added: r.adds > 0 }];
    });
    const decide = part(replay(sets.decide));
    const exam = part(replay(sets.exam));
    const res: Confirmed = {
      strategy: st.id, rule: rule.id, label: rule.label, decide: decide!,
      exam: { pass: exam && exam.n >= 30 ? exam.rule > exam.base && exam.rule > 0 : null, n: exam?.n ?? 0 },
      untouched: part(replay(sets.untouched)), shadow: part(replay(sets.shadow)), baseMismatch: mismatch, skippedNoData: skipped,
    };
    log(`confirm ${st.id} ${rule.id}: decide ${decide?.base}→${decide?.rule}, untouched ${res.untouched?.base}→${res.untouched?.rule} (t ${res.untouched?.t}), mismatches ${mismatch}`);
    out.push(res);
  }
  return out;
}
