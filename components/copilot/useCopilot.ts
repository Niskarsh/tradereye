"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { postWithToken } from '@/components/live/useLiveSession';
import type { Facts, ManageFacts } from '@/lib/copilot/features';
import type { Behaviour } from '@/lib/copilot/behaviour';

export type Dir = 'LONG' | 'SHORT';
export type SetupT = 'MOMENTUM' | 'REVERSAL';

export interface MarketResp {
  market: { date: string; live: boolean; asOf: string; first5?: number; nowPct?: number; last10?: number; state: string };
  you: { TradesToday: number; PnlToday: number; FirstTradeLost: boolean; OpenPositions: number };
  openSymbols: string[];
  asksLeft: number;
  checks: { checkId: string; time: string; symbol: string; direction: string; setup: string; mode: string; verdict: string; decision: string; tradeGroupId: string }[];
  recentSymbols: string[];
  riskInr: number;
  hasApiKey: boolean;
}

export interface CheckResp {
  checkId: string; mode: 'ENTRY' | 'MANAGE'; date: string; time: string; live: boolean;
  symbol: string; direction: Dir; setup: SetupT; price: number; priceSource: string;
  facts: Facts; manage?: ManageFacts; behaviour: Behaviour; notes: string[]; asksLeft: number;
  fitsNow: { direction: Dir; setup: SetupT; stop?: number; roomTo?: string; roomAtr?: number }[];
}

export interface AltResp { direction: Dir; setup: SetupT; stop?: number; reason: string }
export interface ScenarioResp { kind: 'SETUP' | 'WAIT'; setup?: SetupT; direction?: Dir; stop?: number; why: string; trigger: string }
export interface ReadResp { verdict: string; lines: string[]; watch: string; model: string; costInr: number; latencyMs: number; asksLeft: number; scenarios: ScenarioResp[] }

const MARKET_EVERY_MS = 60_000;

export function useCopilot(token: string) {
  const [market, setMarket] = useState<MarketResp | null>(null);
  const [marketErr, setMarketErr] = useState('');
  const [direction, setDirection] = useState<Dir | null>(null);
  const [setup, setSetup] = useState<SetupT | null>(null);
  const [check, setCheck] = useState<CheckResp | null>(null);
  const [read, setRead] = useState<ReadResp | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'ask'>('');
  const [error, setError] = useState('');
  const [decision, setDecision] = useState<'' | 'TOOK' | 'SKIPPED'>('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMarket = useCallback(async () => {
    if (!token) return;
    try { setMarket(await postWithToken<MarketResp>('/api/copilot/market', token)); setMarketErr(''); }
    catch (e) { setMarketErr((e as Error).message); }
  }, [token]);

  useEffect(() => {
    loadMarket();
    timer.current = setInterval(loadMarket, MARKET_EVERY_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [loadMarket]);

  const runCheck = useCallback(async (symbol: string, plannedStop?: number) => {
    if (!token || !direction || !setup || !symbol) return;
    // keep the current card on screen until the fresh one arrives (refresh), then replace it
    setBusy('check'); setError(''); setRead(null); setDecision('');
    try {
      const r = await postWithToken<CheckResp>('/api/copilot/check', token, { direction, setup, symbol, plannedStop });
      setCheck(r);
      setMarket((m) => (m ? { ...m, asksLeft: r.asksLeft } : m));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }, [token, direction, setup]);

  const ask = useCallback(async () => {
    if (!token || !check) return;
    setBusy('ask'); setError('');
    try {
      const r = await postWithToken<ReadResp>('/api/copilot/ask', token, { checkId: check.checkId, date: check.date });
      setRead(r);
      setMarket((m) => (m ? { ...m, asksLeft: r.asksLeft } : m));
      loadMarket();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }, [token, check, loadMarket]);

  const decide = useCallback(async (d: 'TOOK' | 'SKIPPED') => {
    if (!token || !check) return;
    setDecision(d);
    try { await postWithToken('/api/copilot/decision', token, { checkId: check.checkId, date: check.date, decision: d }); loadMarket(); }
    catch (e) { setError((e as Error).message); setDecision(''); }
  }, [token, check, loadMarket]);

  const saveRisk = useCallback(async (riskInr: number) => {
    if (!token) return;
    try {
      const r = await postWithToken<{ riskInr: number }>('/api/copilot/settings', token, { riskInr });
      setMarket((m) => (m ? { ...m, riskInr: r.riskInr } : m));
    } catch (e) { setError((e as Error).message); }
  }, [token]);

  return { saveRisk, market, marketErr, direction, setDirection, setup, setSetup, check, read, busy, error, decision, runCheck, ask, decide, reload: loadMarket };
}
