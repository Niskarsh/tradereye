"use client";
import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Save, RefreshCcw, Send, AlertTriangle, Database, Loader2, CheckCircle2, XCircle } from "lucide-react";
import TradeAnalytics from '@/components/TradeAnalytics';
import { useAuth } from '@/context/AuthContext';

export default function TraderEye() {
  const { token, setToken } = useAuth();
  // Fix: Explicitly typing the state to avoid 'never[]' build errors
  const [trades, setTrades] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('SHORT');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | null, msg: string }>({ type: null, msg: '' });

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const showStatus = (type: 'success' | 'error', msg: string) => {
    setStatus({ type, msg });
    setTimeout(() => setStatus({ type: null, msg: '' }), 4000);
  };

  const fetchTrades = async () => {
    if (!token) return showStatus('error', "AUTH REQUIRED");
    setLoading(true);
    try {
      const res = await fetch(`/api/trades?token=${token}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setTrades(data);
        setSelectedIds(data.map((t: any) => t.exchangeTradeId));
        showStatus('success', `FETCHED ${data.length} EXECUTIONS`);
      }
    } catch (e) { showStatus('error', "API LINK FAILED"); }
    finally { setLoading(false); }
  };

  const calculateDetailedPnL = () => {
    const selected = trades.filter((t: any) => selectedIds.includes(t.exchangeTradeId));
    let bVal = 0, sVal = 0, bQty = 0, sQty = 0, fTime = Infinity, lTime = 0;

    selected.forEach((t: any) => {
      const val = Number((t.tradedPrice * t.tradedQuantity).toFixed(2));
      const time = new Date(t.createTime).getTime();
      if (t.transactionType === 'BUY') { bVal += val; bQty += t.tradedQuantity; }
      else { sVal += val; sQty += t.tradedQuantity; }
      if (time < fTime) fTime = time;
      if (time > lTime) lTime = time;
    });

    const turnover = Number((bVal + sVal).toFixed(2));
    const grossPnL = Number((sVal - bVal).toFixed(2));
    const brokerage = Number((Math.min(bVal * 0.0003, 20) + Math.min(sVal * 0.0003, 20)).toFixed(2));
    const exchTxn = Number((turnover * 0.00003071).toFixed(2));
    const stt = Number((sVal * 0.00025).toFixed(2));
    const sebi = Number((turnover * 0.000001).toFixed(2));
    const stamp = Number((bVal * 0.00003).toFixed(2));
    const gst = Number(((brokerage + exchTxn + sebi) * 0.18).toFixed(2));
    const totalCharges = Number((brokerage + exchTxn + sebi + stt + stamp + gst).toFixed(2));
    const netPnL = Number((grossPnL - totalCharges).toFixed(2));

    // Duration Logic for Sheets (Raw Seconds) and UI (Human Readable)
    const durationSec = Math.max(0, Math.round((lTime - fTime) / 1000));
    const displayDuration = durationSec > 60
      ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
      : `${durationSec}s`;

    return {
      grossPnL, netPnL, totalCharges, durationSec,
      status: netPnL >= 0 ? "WIN" : "LOSS",
      isConsistent: bQty === sQty && bQty > 0,
      buyQty: bQty, sellQty: sQty,
      durationStr: displayDuration
    };
  };

  const pnl = calculateDetailedPnL();

  const handleSync = async (type: 'INIT_HEADERS' | 'SYNC_DATA') => {
    setSyncing(true);
    try {
      const payload = type === 'INIT_HEADERS' ? { type } : { trades: trades.filter((t: any) => selectedIds.includes(t.exchangeTradeId)), direction, pnl };
      const res = await fetch('/api/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) showStatus('success', type === 'INIT_HEADERS' ? "IST SCHEMA APPLIED" : `LOGGED ${pnl.status}`);
      else showStatus('error', "DB WRITE FAILED");
    } catch (e) { showStatus('error', "LINK TIMEOUT"); }
    finally { setSyncing(false); }
  };

  return (
    <div className="min-h-screen bg-brand-bg text-zinc-100 font-sans pb-24 pt-0">

      {/* Toast Alert */}
      {status.type && (
        <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[92%] max-w-sm p-4 rounded-2xl border shadow-2xl flex items-center gap-3 backdrop-blur-xl ${status.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-rose-500/10 border-rose-500/30 text-rose-400'}`}>
          {status.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <span className="text-[11px] font-black uppercase tracking-wider">{status.msg}</span>
        </div>
      )}

      <div className="max-w-4xl mx-auto px-4 pt-10 space-y-8">

        {/* NEW ANALYTICS SECTION */}
        <TradeAnalytics />
      </div>

    </div>
  );
}