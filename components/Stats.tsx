"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CalendarDays, Loader2, RefreshCcw, TrendingUp, Clock, Box, ShieldCheck } from "lucide-react";

const GLOBAL_CACHE_KEY = "traderEye_analytics_ranged";

// --- Types ---
interface TradeRow {
  date?: string;
  ["Date (IST)"]?: string;
  TradeGroupId?: string;
  OrderType?: string;
  Qty?: string | number;
  NetPnL?: string | number;
  GrossPnL?: string | number;
  Duration?: string | number;
  ["Duration (Sec)"]?: string | number;
  [key: string]: unknown;
}

// --- Helpers ---
const parseNumber = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(String(v).replace(/,/g, "")) || 0);

// FIXED: Removed the "(L)" suffix for a cleaner look
const formatCurrency = (v: number) => {
  return `₹${Math.abs(v).toLocaleString("en-IN", { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  })}`;
};

const formatDuration = (s: number) => {
  const total = Math.max(0, Math.round(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return [h, m, sec].map(v => String(v).padStart(2, "0")).join(":");
};

export default function Stats() {
  const [startDate, setStartDate] = useState(new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString().split("T")[0]);
  const [endDate, setEndDate] = useState(new Date().toISOString().split("T")[0]);
  const [allTrades, setAllTrades] = useState<Record<string, TradeRow[]>>({});
  const [loading, setLoading] = useState(false);

  const loadStats = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      const cachedData = localStorage.getItem(GLOBAL_CACHE_KEY);
      let localStore: Record<string, TradeRow[]> = cachedData ? JSON.parse(cachedData) : {};

      if (forceRefresh || Object.keys(localStore).length === 0) {
        const startD = new Date(startDate);
        const endD = new Date(endDate);
        const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
        const startKey = `${monthNames[startD.getMonth()]}-${startD.getFullYear()}`;
        const endKey = `${monthNames[endD.getMonth()]}-${endD.getFullYear()}`;

        const response = await fetch(`/api/analytics?start=${startKey}&end=${endKey}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Failed to fetch");

        const newData = result.data || {};
        const updatedStore = { ...localStore };
        Object.entries(newData).forEach(([monthKey, rows]) => {
          if (Array.isArray(rows)) {
            if (!updatedStore[monthKey]) updatedStore[monthKey] = [];
            const existingMap = new Set(updatedStore[monthKey].map(r => JSON.stringify(r)));
            const uniqueNewRows = (rows as TradeRow[]).filter(r => !existingMap.has(JSON.stringify(r)));
            updatedStore[monthKey] = [...updatedStore[monthKey], ...uniqueNewRows];
          }
        });
        localStorage.setItem(GLOBAL_CACHE_KEY, JSON.stringify(updatedStore));
        localStore = updatedStore;
      }
      setAllTrades(localStore);
    } catch (err) {
      console.error("Stats load error:", err);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    (async () => { await loadStats(false); })();
  }, [loadStats]);

  const metrics = useMemo(() => {
    const startD = new Date(startDate);
    const endD = new Date(endDate);
    const allTradesFlat: TradeRow[] = Object.values(allTrades).flat();

    const filtered = allTradesFlat.filter((row: TradeRow) => {
      const d = new Date(row.date || row["Date (IST)"] || "");
      return d >= startD && d <= endD;
    });

    const groups: Record<string, TradeRow[]> = {};
    filtered.forEach((t: TradeRow) => {
      const id = t.TradeGroupId || "unassigned";
      if (!groups[id]) groups[id] = [];
      groups[id].push(t);
    });

    const groupedTrades = Object.values(groups).map(rows => {
      const first = rows[0];
      return {
        pnl: parseNumber(first.NetPnL ?? first.GrossPnL ?? 0),
        duration: parseNumber(first["Duration (Sec)"] ?? first.Duration ?? 0),
        posSize: rows.filter(r => r.OrderType?.toLowerCase() === "sell").reduce((s, r) => s + parseNumber(r.Qty), 0)
      };
    });

    const winners = groupedTrades.filter(t => t.pnl > 0);
    const losers = groupedTrades.filter(t => t.pnl < 0);
    const avgWin = winners.length ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0;
    const avgLoss = losers.length ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0;

    return {
      total: groupedTrades.length,
      winRate: groupedTrades.length ? (winners.length / groupedTrades.length) * 100 : 0,
      rr: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0,
      avgWin,
      avgLoss,
      avgPos: groupedTrades.length ? groupedTrades.reduce((s, t) => s + t.posSize, 0) / groupedTrades.length : 0,
      avgHoldWin: winners.length ? winners.reduce((s, t) => s + t.duration, 0) / winners.length : 0,
      avgHoldLoss: losers.length ? losers.reduce((s, t) => s + t.duration, 0) / losers.length : 0,
    };
  }, [allTrades, startDate, endDate]);

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-6 md:py-10">
      {/* Header Section */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-indigo-400">
            <ShieldCheck className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-[0.3em]">Verified Performance</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-black tracking-tight text-white">Performance Stats</h1>
        </div>

        {/* Date Filters Card */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 backdrop-blur-md">
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <div className="space-y-1.5">
              <p className="text-[9px] font-bold uppercase text-zinc-500 px-1">From</p>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-9 w-full sm:w-36 border-zinc-700 bg-zinc-950 text-white text-xs" />
            </div>
            <div className="space-y-1.5">
              <p className="text-[9px] font-bold uppercase text-zinc-500 px-1">To</p>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="h-9 w-full sm:w-36 border-zinc-700 bg-zinc-950 text-white text-xs" />
            </div>
          </div>
          <Button onClick={() => loadStats(true)} disabled={loading} className="h-9 bg-indigo-600 hover:bg-indigo-500 transition-colors">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Total Trade Groups" value={metrics.total} sub="Calculated from Grouped IDs" />
        <StatCard label="Win Rate" value={`${metrics.winRate.toFixed(1)}%`} color="text-emerald-400" icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="W/L R-Ratio" value={metrics.rr.toFixed(2)} color="text-indigo-400" sub="Reward to Risk Ratio" />
        
        <StatCard label="Avg Winning Trade" value={formatCurrency(metrics.avgWin)} color="text-emerald-400" />
        <StatCard label="Avg Losing Trade" value={formatCurrency(metrics.avgLoss)} color="text-rose-500" />
        <StatCard label="Avg Position Size" value={Math.round(metrics.avgPos)} sub="Units (Sell Order Sum)" icon={<Box className="h-4 w-4" />} />

        <StatCard label="Avg Hold (Wins)" value={formatDuration(metrics.avgHoldWin)} icon={<Clock className="h-4 w-4 text-emerald-500/50" />} />
        <StatCard label="Avg Hold (Loss)" value={formatDuration(metrics.avgHoldLoss)} icon={<Clock className="h-4 w-4 text-rose-500/50" />} />
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color = "text-white", icon }: { label: string; value: string | number; sub?: string; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="group relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 p-6 md:p-8 transition-all hover:border-zinc-700 hover:bg-zinc-900/30">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">{label}</span>
        {icon && <div className="transition-transform group-hover:scale-110">{icon}</div>}
      </div>
      <div className="space-y-1">
        <p className={`text-3xl md:text-4xl font-black tracking-tighter ${color}`}>{value}</p>
        {sub && <p className="text-[10px] font-medium text-zinc-600 uppercase tracking-wider">{sub}</p>}
      </div>
      {/* Subtle Background Glow on Hover */}
      <div className="absolute -right-4 -bottom-4 h-24 w-24 rounded-full bg-indigo-500/5 blur-3xl transition-opacity opacity-0 group-hover:opacity-100" />
    </div>
  );
}