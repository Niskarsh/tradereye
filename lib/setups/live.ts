import { DhanError, type Candles, type DhanClient } from '../dhan';
import { toSessions, type Session } from '../live/enrich';
import { loadTradeCandles, type Store as CandleStore } from '../candles/store';
import { istParts, SESSION_OPEN_MIN } from '../live/time';
import { runDay } from './engine';
import { CASE_BY_ID, type Signal } from './cases';
import { lookupFor, passes, type Stats, type Summary } from './stats';

/**
 * Live setup alerts: the same engine as the backtest, run on today's candles so far for the stocks on his list, every
 * minute while the Order Book page is open. A signal is shown only when its bucket in the latest backtest passes the
 * alert bar (enough past cases, the hit rate, money after charges, steady in both halves).
 */

export interface LiveAlert {
  id: string;
  symbol: string;
  signal: Signal;
  name: string;
  family: 'MOMENTUM' | 'REVERSAL';
  /** the backtest bucket it matched and its numbers */
  bucket?: string;
  stats?: Stats;
  /** good enough to alert on */
  alert: boolean;
  /** epoch ms of the decision minute */
  at: number;
}

export interface ScanDeps {
  dhan: Pick<DhanClient, 'intraday' | 'daily'>;
  candleStore: CandleStore;
  lookupSecurityId: (symbol: string) => Promise<string | undefined>;
  daily: (securityId: string, date: string) => Promise<Candles>;
  nifty: (date: string) => Promise<Candles>;
  now?: () => number;
}

/** prior sessions of each stock, kept while the server instance lives (they do not change during the day) */
const historyCache = new Map<string, { securityId: string; sessions: Session[] }>();

async function historyFor(deps: ScanDeps, symbol: string, securityId: string | undefined, date: string) {
  const key = `${symbol}|${date}`;
  const hit = historyCache.get(key);
  if (hit) return hit;
  const t = await loadTradeCandles({ store: deps.candleStore, dhan: deps.dhan, lookupSecurityId: deps.lookupSecurityId, now: deps.now }, { symbol, date, securityId, parts: ['minute'] });
  const sessions = toSessions(t.minute).filter((s) => s.date < date);
  const v = { securityId: t.securityId ?? securityId ?? '', sessions };
  if (historyCache.size > 300) historyCache.clear();
  historyCache.set(key, v);
  return v;
}

const IST = 19800_000;

export async function scan(deps: ScanDeps, list: { symbol: string; securityId?: string }[], summary: Pick<Summary, 'lookup' | 'runId'> | undefined, opts: { minHit: number; recentMin?: number }): Promise<{ alerts: LiveAlert[]; errors: { symbol: string; message: string }[] }> {
  const nowMs = (deps.now ?? Date.now)();
  const date = new Date(nowMs + IST).toISOString().slice(0, 10);
  const asOf = Math.floor(nowMs / 60000) * 60000;
  const curSlot = istParts(nowMs).minuteOfDay - SESSION_OPEN_MIN;
  const nifty = toSessions(await deps.nifty(date)).find((s) => s.date === date);
  if (!nifty) return { alerts: [], errors: [] };
  const niftyBars = nifty.bars.filter((b) => b.t * 1000 < asOf);
  const alerts: LiveAlert[] = [], errors: { symbol: string; message: string }[] = [];
  const recent = opts.recentMin ?? 15;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
    while (i < list.length) {
      const it = list[i++];
      try {
        const h = await historyFor(deps, it.symbol, it.securityId, date);
        if (!h.securityId) continue;
        const [today, daily] = await Promise.all([
          deps.dhan.intraday({ securityId: h.securityId, segment: 'NSE_EQ', instrument: 'EQUITY', from: date, to: date }),
          deps.daily(h.securityId, date),
        ]);
        const day = toSessions(today).find((s) => s.date === date)?.bars.filter((b) => b.t * 1000 < asOf) ?? [];
        const sigs = runDay({ symbol: it.symbol, date, history: h.sessions, day, nifty: niftyBars, daily });
        for (const s of sigs) {
          if (s.slot < curSlot - recent) continue;
          const info = CASE_BY_ID.get(s.case)!;
          const m = summary ? lookupFor(summary, s) : undefined;
          alerts.push({
            id: `${date}|${it.symbol}|${s.case}|${s.dir}`, symbol: it.symbol, signal: s, name: info.name, family: info.family,
            bucket: m?.key, stats: m?.stats, alert: passes(m?.stats, { minHit: opts.minHit }),
            at: (nifty.bars[0]?.t ?? 0) * 1000 + s.slot * 60_000,
          });
        }
      } catch (e) {
        if (e instanceof DhanError && (e.isAuth || e.isNoDataPlan)) throw e; // the whole scan is off: say so once
        errors.push({ symbol: it.symbol, message: (e as Error).message });
      }
    }
  }));
  return { alerts, errors };
}
