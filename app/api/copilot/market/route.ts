import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { errorResponse, guard } from '@/lib/live/guard';
import { marketStrip, recentTrades } from '@/lib/copilot/service';
import { computeBehaviour } from '@/lib/copilot/behaviour';
import { askedToday, readChecks } from '@/lib/copilot/store';
import { settings } from '@/lib/copilot/settings';
import { getRiskInr } from '@/lib/copilot/userSettings';

export const dynamic = 'force-dynamic';

/** The page's top strip (no Claude): Nifty 500 state, your day so far, asks left, and today's checks. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const sheets = getSheetsClient();
    const now = Date.now();
    const market = await marketStrip({ dhan: g.dhan, sheets });
    const [trades, positions, checks, riskInr] = await Promise.all([
      recentTrades(sheets, market.date, now).catch(() => []),
      g.dhan.positions().catch(() => [] as { netQty?: unknown; tradingSymbol?: unknown }[]),
      readChecks(sheets, market.date).catch(() => ({ rows: [] as { o: Record<string, string> }[] })),
      getRiskInr(sheets),
    ]);
    const open = positions.filter((p) => Number(p.netQty) !== 0);
    const you = computeBehaviour(trades, { today: market.date, nowMs: now, symbol: '', direction: 'LONG', setup: 'MOMENTUM', openPositions: open.length });
    const today = checks.rows.filter((r) => r.o.Date === market.date).map((r) => ({
      checkId: r.o.CheckId, time: r.o.Time, symbol: r.o.Symbol, direction: r.o.Direction, setup: r.o.Setup, mode: r.o.Mode,
      verdict: r.o.Verdict, decision: r.o.Decision, tradeGroupId: r.o.TradeGroupId,
    })).reverse();
    const recentSymbols = [...new Set([...today.map((c) => c.symbol), ...trades.filter((t) => t.date === market.date).map((t) => t.symbol), ...open.map((p) => String(p.tradingSymbol ?? '').toUpperCase())].filter(Boolean))].slice(0, 8);
    return NextResponse.json({
      market, you: { TradesToday: you.TradesToday, PnlToday: you.PnlToday, FirstTradeLost: you.FirstTradeLost, OpenPositions: you.OpenPositions },
      openSymbols: open.map((p) => String(p.tradingSymbol ?? '').toUpperCase()),
      asksLeft: Math.max(0, settings().dailyLimit - askedToday(checks.rows, market.date)),
      checks: today, recentSymbols, riskInr, hasApiKey: !!process.env.ANTHROPIC_API_KEY?.trim(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
