"use client";
import { useEffect, useState } from 'react';
import { Workspace } from '@/components/chart/Workspace';

/**
 * Charts (My Live Trading): TradingView-style charts on Dhan data, built on tradereye's own chart engine
 * (packages/candle-chart). Opens with the saved layout (default: 5m top left, 1D bottom left, 10m big on the right).
 *   /chart?symbol=HDFIRE            that symbol
 *   /chart?symbol=HDFIRE&algo=DATE  that symbol with Algo Live's view of that day (the Algo Live shortlist links here)
 */
export default function ChartPage() {
  const [params, setParams] = useState<{ symbol?: string; algo?: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const symbol = q.get('symbol')?.trim().toUpperCase();
    const algo = q.get('algo') ?? undefined;
    setParams({ symbol: symbol && /^[A-Z0-9&-]{1,30}$/.test(symbol) ? symbol : undefined, algo: algo && /^\d{4}-\d{2}-\d{2}$/.test(algo) ? algo : undefined });
    if (symbol) document.title = `${symbol} · Charts · tradereye`;
  }, []);
  if (!params) return null;
  return <Workspace initialSymbol={params.symbol} algoDate={params.algo} />;
}
