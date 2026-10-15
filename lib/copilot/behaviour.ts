import { rowToObject } from '../sheetsApi';
import { normDate, normTime, parseIst } from '../live/time';
import type { Direction } from '../live/types';
import type { Setup } from './features';

/**
 * Your day and your record, from the monthly sheet rows.
 *
 * The monthly sheets hold ONE ROW PER FILL and repeat group-level values (NetPnL, TotalCharges, ExitType) on every
 * row of a trade, so everything here is counted per TradeGroupId, never by adding rows up. Direction comes from
 * DirFromFills when present (the Direction column can be wrong when it was set by hand).
 */

export interface TradeSummary {
  groupId: string; date: string; symbol: string; direction: Direction;
  netPnl: number; charges: number; turnover: number; exitType: string; setup: string;
  firstTs: number; lastTs: number;
  /** Nifty 500 in the 30 minutes before entry (RISING / FALLING / FLAT; filled by Backfill). */
  niftyLast30: string;
}

const num = (v: unknown) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : NaN; };

export function summarizeTrades(headers: string[], rows: { cells: string[] }[]): TradeSummary[] {
  const m = new Map<string, TradeSummary>();
  for (const r of rows) {
    const o = rowToObject(headers, r.cells);
    const id = (o.TradeGroupId ?? '').trim();
    if (!id || !o.Symbol) continue;
    const date = normDate(o['Date (IST)']);
    const ts = parseIst(`${date} ${normTime(o['Time (IST)'])}`);
    const turnover = (num(o.Price) || 0) * (num(o.Qty) || 0);
    const prev = m.get(id);
    if (prev) {
      prev.turnover += turnover;
      if (Number.isFinite(ts)) { prev.firstTs = Math.min(prev.firstTs, ts); prev.lastTs = Math.max(prev.lastTs, ts); }
      continue;
    }
    const dirRaw = String(o.DirFromFills || o.Direction || '').trim().toUpperCase();
    m.set(id, {
      groupId: id, date, symbol: o.Symbol.trim().toUpperCase(),
      direction: dirRaw === 'SHORT' ? 'SHORT' : 'LONG',
      netPnl: num(o.NetPnL), charges: num(o.TotalCharges), turnover,
      exitType: String(o.ExitType ?? '').trim().toUpperCase(), setup: String(o.Setup ?? '').trim().toLowerCase(),
      firstTs: Number.isFinite(ts) ? ts : NaN, lastTs: Number.isFinite(ts) ? ts : NaN,
      niftyLast30: String(o.NiftyLast30Trend ?? '').trim().toUpperCase(),
    });
  }
  return [...m.values()].sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
}

/** Average charges per rupee of turnover over your last `n` trades that have both numbers. */
export function chargeRate(trades: TradeSummary[], n = 30): number | undefined {
  const ok = trades.filter((t) => Number.isFinite(t.charges) && t.charges > 0 && t.turnover > 0).slice(-n);
  if (ok.length < 3) return undefined;
  const c = ok.reduce((s, t) => s + t.charges, 0), v = ok.reduce((s, t) => s + t.turnover, 0);
  return v > 0 ? c / v : undefined;
}

export interface Behaviour {
  TradesToday: number; PnlToday: number; FirstTradeLost: boolean; SameSymbolStopped: boolean;
  MinSinceLoss?: number; SetupTrades: number; SetupWinRate?: number; SetupAvgPnl?: number; OpenPositions: number;
  /** Your record in this setup and direction when Nifty's last 30 minutes were like now (with you / flat / against you). */
  LikeNow?: string; LikeNowTrades?: number; LikeNowWinRate?: number; LikeNowAvgPnl?: number;
}

export function computeBehaviour(
  trades: TradeSummary[], p: { today: string; nowMs: number; symbol: string; direction: Direction; setup: Setup; openPositions: number; niftyLast30?: string },
): Behaviour {
  const today = trades.filter((t) => t.date === p.today);
  const pnl = today.reduce((s, t) => s + (Number.isFinite(t.netPnl) ? t.netPnl : 0), 0);
  const first = today[0];
  const losses = today.filter((t) => t.netPnl < 0 && Number.isFinite(t.lastTs));
  const lastLoss = losses.length ? Math.max(...losses.map((t) => t.lastTs)) : undefined;
  const setupKey = p.setup.toLowerCase();
  const same = trades.filter((t) => t.setup === setupKey && t.direction === p.direction && Number.isFinite(t.netPnl)).slice(-20);
  return {
    TradesToday: today.length,
    PnlToday: Number(pnl.toFixed(2)),
    FirstTradeLost: !!first && first.netPnl < 0 && p.openPositions === 0,
    SameSymbolStopped: today.some((t) => t.symbol === p.symbol.toUpperCase() && t.direction === p.direction && t.exitType === 'STOP'),
    MinSinceLoss: lastLoss !== undefined ? Math.max(0, Math.round((p.nowMs - lastLoss) / 60000)) : undefined,
    SetupTrades: same.length,
    SetupWinRate: same.length ? Number((same.filter((t) => t.netPnl > 0).length / same.length).toFixed(2)) : undefined,
    SetupAvgPnl: same.length ? Number((same.reduce((s, t) => s + t.netPnl, 0) / same.length).toFixed(2)) : undefined,
    OpenPositions: p.openPositions,
    ...likeNow(trades, p),
  };
}

const rel = (trend: string, dir: Direction) => (trend === 'FLAT' ? 'FLAT' : trend === (dir === 'LONG' ? 'RISING' : 'FALLING') ? 'WITH' : trend ? 'AGAINST' : '');
const LIKE_TEXT: Record<string, string> = { WITH: "Nifty's last 30 min with you", FLAT: "Nifty flat in the last 30 min", AGAINST: "Nifty's last 30 min against you" };

function likeNow(trades: TradeSummary[], p: { direction: Direction; setup: Setup; niftyLast30?: string }) {
  const now = rel(String(p.niftyLast30 ?? ''), p.direction);
  if (!now) return {};
  const setupKey = p.setup.toLowerCase();
  const same = trades.filter((t) => t.setup === setupKey && t.direction === p.direction && Number.isFinite(t.netPnl) && rel(t.niftyLast30, t.direction) === now).slice(-20);
  return {
    LikeNow: LIKE_TEXT[now], LikeNowTrades: same.length,
    LikeNowWinRate: same.length ? Number((same.filter((t) => t.netPnl > 0).length / same.length).toFixed(2)) : undefined,
    LikeNowAvgPnl: same.length ? Number((same.reduce((s, t) => s + t.netPnl, 0) / same.length).toFixed(2)) : undefined,
  };
}
