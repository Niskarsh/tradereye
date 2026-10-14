/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SheetsClient } from '../sheetsApi';
import { LiveStore, type LiveTradeRow } from './store';
import { applyOrderSnaps, analyzeTrade, normalizeOrder, normalizeTrade } from './orders';
import { groupFills } from './grouping';
import { computePnl } from './pnl';
import { finalizeGroup, groupFillKeys, patchStopColumns } from './finalize';
import { istDateKey, istDateTime, istTime } from './time';
import type { OrderSnapIn, TradeGroup, TradeMeta, TrackedOrder } from './types';
import type { LiveStatus } from './schema';
import { checksForTrade } from '../copilot/store';

export interface SyncDeps {
  dhan: { orders(): Promise<any[]>; trades(): Promise<any[]>; positions(): Promise<any[]> };
  sheets: SheetsClient;
  now?: () => number;
}

export interface LiveGroupView {
  id: string; symbol: string; direction: 'LONG' | 'SHORT'; status: 'OPEN' | 'CLOSED';
  saved: LiveStatus; date: string; entryTime: string; lastTime: string; durationSec: number;
  netQty: number; avgCost: number; avgEntry: number; avgExit: number; peakQty: number; adds: number;
  realizedGross: number; unrealized: number | null;
  grossPnl: number | null; netPnl: number | null; charges: number | null;
  initialStop: number | null; lastStop: number | null; stopDist: number | null; riskInr: number | null; stopMoves: number;
  tpLast: number | null; exitType: string; rMultiple: number | null; fills: number;
}

export interface SyncResult {
  asOf: string;
  today: string;
  groups: LiveGroupView[];
  totals: { closedCount: number; openCount: number; closedNet: number; closedGross: number; charges: number; openUnrealized: number };
  newEvents: number;
  recentEvents?: Awaited<ReturnType<LiveStore['recentEvents']>>;
  finalized: { id: string; symbol: string; result: 'LOGGED' | 'DUPLICATE' | 'BUSY' }[];
  warnings: string[];
}

/** Applies order snapshots (from any feed) to the stored order state and appends change events. */
export async function ingestSnaps(deps: Pick<SyncDeps, 'sheets' | 'now'>, snaps: OrderSnapIn[], src: string, store?: LiveStore) {
  const s = store ?? new LiveStore(deps.sheets);
  const now = (deps.now ?? Date.now)();
  const { known, rowOf } = await s.loadOrders();
  const { events, updated } = applyOrderSnaps(known, snaps, src, now);
  if (updated.length || events.length) await s.saveOrders(updated, rowOf, events);
  for (const u of updated) known.set(u.orderId, u);
  return { events, updated, known };
}

const opt = (v: number | undefined) => (v === undefined ? null : v);

function toView(
  g: TradeGroup, meta: TradeMeta, saved: LiveStatus, unrealized: number | null,
): LiveGroupView {
  const closed = g.status === 'CLOSED';
  const pnl = closed ? computePnl(g) : null;
  return {
    id: g.id, symbol: g.symbol, direction: g.direction, status: g.status, saved, date: g.date,
    entryTime: istTime(g.entryTs), lastTime: istTime(g.lastTs),
    durationSec: Math.max(0, Math.round((g.lastTs - g.entryTs) / 1000)),
    netQty: g.netQty, avgCost: Number(g.avgCost.toFixed(2)), avgEntry: Number(g.avgEntry.toFixed(2)),
    avgExit: Number(g.avgExit.toFixed(2)), peakQty: g.peakQty, adds: g.adds,
    realizedGross: g.realizedGross, unrealized,
    grossPnl: pnl ? pnl.grossPnL : null, netPnl: pnl ? pnl.netPnL : null, charges: pnl ? pnl.totalCharges : null,
    initialStop: opt(meta.initialStop), lastStop: opt(meta.lastStop), stopDist: opt(meta.initialStopDist),
    riskInr: opt(meta.riskInr), stopMoves: meta.stopMoves, tpLast: opt(meta.tpLast), exitType: meta.exitType,
    rMultiple: pnl && meta.riskInr ? Number((pnl.netPnL / meta.riskInr).toFixed(2)) : null,
    fills: g.parts.length,
  };
}

function toRow(g: TradeGroup, meta: TradeMeta, status: LiveStatus, prev: LiveTradeRow | undefined, nowMs: number, note = ''): LiveTradeRow {
  return {
    rowNumber: prev?.rowNumber,
    GroupId: g.id, Date: g.date, Symbol: g.symbol, SecurityId: g.securityId, Direction: g.direction, Status: status,
    NetQty: g.netQty, AvgCost: Number(g.avgCost.toFixed(2)), RealizedGross: g.realizedGross, Adds: g.adds,
    EntryTime: istTime(g.entryTs), LastTime: istTime(g.lastTs),
    InitialStop: meta.initialStop ?? '', LastStop: meta.lastStop ?? '', StopMoves: meta.stopMoves,
    TpLast: meta.tpLast ?? '', RiskInr: meta.riskInr ?? '', FillCount: g.parts.length,
    FillKeys: JSON.stringify(groupFillKeys(g)),
    FinalizedAt: status === 'LOGGED' || status === 'DUPLICATE' ? (prev?.FinalizedAt || istDateTime(nowMs)) : '',
    UpdatedAt: istDateTime(nowMs), Note: note || prev?.Note || '',
  };
}

const sameRow = (a: LiveTradeRow | undefined, b: LiveTradeRow) =>
  !!a && a.Status === b.Status && a.NetQty === b.NetQty && a.AvgCost === b.AvgCost && a.RealizedGross === b.RealizedGross &&
  a.Adds === b.Adds && a.InitialStop === b.InitialStop && a.LastStop === b.LastStop && a.StopMoves === b.StopMoves &&
  a.TpLast === b.TpLast && a.RiskInr === b.RiskInr && a.FillCount === b.FillCount && a.LastTime === b.LastTime;

/**
 * One full reconciliation pass. Stateless: everything it needs is re-read from Dhan and the sheet,
 * so it can be called from the browser every few seconds, from several tabs, or after a restart.
 *
 *  1. order book -> change events + order history (stop moves, target changes ...)
 *  2. trade book -> trades (position lifecycle per symbol, direction from the first fill)
 *  3. OPEN trades are tracked in `live-trades` only (never in the monthly sheets)
 *  4. a trade that goes flat is written to its monthly sheet exactly once (duplicates are detected)
 */
export async function runSync(deps: SyncDeps, opts: { includeRecent?: boolean; finalize?: boolean } = {}): Promise<SyncResult> {
  const nowMs = (deps.now ?? Date.now)();
  const today = istDateKey(nowMs);
  const store = new LiveStore(deps.sheets);
  const warnings: string[] = [];

  // Dhan and the sheet are read in parallel; the sheet costs 2 requests however many tabs are involved.
  const preloaded = store.preload();
  preloaded.catch(() => { /* surfaced below */ });
  const [orders, trades, positions] = await Promise.all([
    deps.dhan.orders(), deps.dhan.trades(),
    deps.dhan.positions().catch((e: Error) => { warnings.push(`Positions unavailable: ${e.message}`); return [] as any[]; }),
  ]);

  await preloaded;

  // 1. orders
  const snaps = orders.map(normalizeOrder).filter((x): x is OrderSnapIn => !!x);
  const { events, known } = await ingestSnaps(deps, snaps, 'POLL', store);

  // 2. trades
  const fills = trades.map(normalizeTrade).filter((f): f is NonNullable<typeof f> => !!f && f.segment.endsWith('_EQ'));
  const groups = groupFills(fills);
  const allOrders: TrackedOrder[] = [...known.values()];

  // 3/4. persist + finalize
  const live = await store.loadTrades();
  const toSave: LiveTradeRow[] = [];
  const finalized: SyncResult['finalized'] = [];
  const views: LiveGroupView[] = [];

  for (const [id, row] of live) {
    if (row.Status === 'OPEN' && row.Date < today && !groups.some((g) => g.id === id)) {
      toSave.push({ ...row, Status: 'STALE', UpdatedAt: istDateTime(nowMs), Note: 'Position was not flat when the session ended' });
    }
  }

  const unrealizedBySymbol = new Map<string, number>();
  for (const p of positions) {
    const sym = String(p.tradingSymbol ?? '').toUpperCase();
    if (sym && Number(p.netQty) !== 0 && Number.isFinite(Number(p.unrealizedProfit))) unrealizedBySymbol.set(sym, Number(p.unrealizedProfit));
  }

  for (const g of groups) {
    const meta = analyzeTrade(g, allOrders);
    const prev = live.get(g.id);
    let status: LiveStatus = g.status === 'OPEN' ? 'OPEN' : 'CLOSED';
    let note = '';

    if (g.status === 'CLOSED') {
      if (prev && (prev.Status === 'LOGGED' || prev.Status === 'DUPLICATE')) {
        status = prev.Status;
        // logged before its stops were known (e.g. partial feed frames): fill them in now that they are
        if (prev.Status === 'LOGGED' && opts.finalize !== false && meta.initialStop !== undefined && (prev.InitialStop === '' || prev.InitialStop === undefined)) {
          try { await patchStopColumns(deps.sheets, g, meta); } catch (e) { warnings.push(`Could not add stops to ${g.symbol} in the sheet yet: ${(e as Error).message}`); }
        }
      } else if (opts.finalize !== false) {
        try {
          // co-pilot: copy the matching check onto the trade's rows (never blocks logging)
          let link: Awaited<ReturnType<typeof checksForTrade>> | null = null;
          try {
            link = await checksForTrade(deps.sheets, { date: g.date, symbol: g.symbol, direction: g.direction, entryTs: g.entryTs, lastTs: g.lastTs });
          } catch (e) { warnings.push(`Co-pilot checks not linked for ${g.symbol}: ${(e as Error).message}`); }
          const r = await finalizeGroup(deps.sheets, g, computePnl(g), meta, link?.columns ?? {});
          if (r === 'LOGGED' && link) await link.tag(g.id).catch((e: Error) => warnings.push(`Co-pilot checks not tagged for ${g.symbol}: ${e.message}`));
          finalized.push({ id: g.id, symbol: g.symbol, result: r });
          if (r === 'LOGGED') status = 'LOGGED';
          else if (r === 'DUPLICATE') { status = 'DUPLICATE'; note = 'Already in the sheet (logged by hand?), not written again'; }
        } catch (e) {
          warnings.push(`Could not save ${g.symbol} to the monthly sheet yet: ${(e as Error).message}`);
        }
      }
    }

    const row = toRow(g, meta, status, prev, nowMs, note);
    if (!sameRow(prev, row)) toSave.push(row);
    views.push(toView(g, meta, status, g.status === 'OPEN' ? unrealizedBySymbol.get(g.symbol) ?? null : null));
  }

  if (toSave.length) await store.saveTrades(toSave);

  const closed = views.filter((v) => v.status === 'CLOSED');
  const open = views.filter((v) => v.status === 'OPEN');
  const sum = (a: (number | null)[]) => Number(a.reduce<number>((s, x) => s + (x ?? 0), 0).toFixed(2));

  return {
    asOf: istDateTime(nowMs), today, groups: views,
    totals: {
      closedCount: closed.length, openCount: open.length,
      closedNet: sum(closed.map((v) => v.netPnl)), closedGross: sum(closed.map((v) => v.grossPnl)), charges: sum(closed.map((v) => v.charges)),
      openUnrealized: sum(open.map((v) => v.unrealized)),
    },
    newEvents: events.length,
    recentEvents: opts.includeRecent ? await store.recentEvents(30) : undefined,
    finalized, warnings,
  };
}
