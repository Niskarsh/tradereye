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
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans pb-24 pt-16 md:pt-0">

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

        {/* Navigation / Meta */}
        <header className="flex justify-between items-center border-b border-zinc-900 pb-6">
          <div className="space-y-0.5">
            <h1 className="text-2xl font-black italic tracking-tighter text-indigo-500">TRADEREYE</h1>
            <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-[0.2em]">NSE Scaling Interface • IST</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => handleSync('INIT_HEADERS')} className="h-8 border-zinc-800 bg-zinc-900/50 text-zinc-500 text-[10px] font-black hover:text-indigo-400">
            <Database className="w-3 h-3 mr-2" /> RE-INIT SCHEMA (IST)
          </Button>
        </header>

        {/* Credentials Interface */}
        <div className="flex gap-2 p-2 bg-zinc-900/40 rounded-2xl border border-zinc-800">
          <Input
            type="password" placeholder="Dhan Auth Token"
            className="bg-transparent border-none h-10 text-xs focus-visible:ring-0 placeholder:text-zinc-800 font-mono"
            value={token} onChange={(e) => setToken(e.target.value)}
          />
          <Button size="icon" className="h-10 w-10 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl" onClick={() => {}}><Save className="w-4 h-4" /></Button>
        </div>

        {/* PnL Terminal Board */}
        <div className="bg-[#0c0c0c] rounded-[2rem] p-8 border border-zinc-800 shadow-2xl space-y-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest">Net P&L (Realized)</p>
                <Badge variant="outline" className={`h-5 text-[9px] font-black uppercase tracking-tighter border-zinc-800 ${pnl.status === 'WIN' ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {pnl.status}
                </Badge>
              </div>
              <div className={`text-6xl md:text-7xl font-black tracking-tighter ${pnl.netPnL >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                ₹{pnl.netPnL.toFixed(2)}
              </div>
            </div>
            <div className="flex items-center gap-4 bg-zinc-900/80 p-3 px-5 rounded-2xl border border-zinc-800 shadow-inner">
              <span className={`text-[10px] font-black tracking-widest ${direction === 'LONG' ? 'text-emerald-500' : 'text-zinc-700'}`}>LONG</span>
              <Switch checked={direction === 'SHORT'} onCheckedChange={(s) => setDirection(s ? 'SHORT' : 'LONG')} />
              <span className={`text-[10px] font-black tracking-widest ${direction === 'SHORT' ? 'text-rose-500' : 'text-zinc-700'}`}>SHORT</span>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-6 pt-8 border-t border-zinc-900">
            <div className="space-y-1">
              <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">Gross Profit</p>
              <p className="text-xl font-black text-emerald-500/80">₹{pnl.grossPnL.toFixed(2)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">Total Charges</p>
              <p className="text-xl font-black text-rose-500/60">₹{pnl.totalCharges.toFixed(2)}</p>
            </div>
            <div className="space-y-1 hidden md:block">
              <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">Hold Time</p>
              <p className="text-xl font-black text-zinc-400 font-mono italic">{pnl.durationStr}</p>
            </div>
          </div>

          {!pnl.isConsistent && (pnl.buyQty > 0 || pnl.sellQty > 0) && (
            <div className="p-4 bg-rose-500/5 border border-rose-500/10 rounded-2xl flex items-center gap-4 text-xs font-black text-rose-500 uppercase tracking-tight">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Qty Mismatch (IST): {pnl.buyQty} Buy vs {pnl.sellQty} Sell
            </div>
          )}
        </div>

        {/* Data Fetch Action */}
        <Button size="lg" className="w-full h-16 bg-zinc-100 text-black hover:bg-zinc-300 font-black uppercase tracking-[0.2em] text-[11px] rounded-2xl shadow-xl transition-all" onClick={fetchTrades} disabled={loading}>
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCcw className="w-4 h-4 mr-3" />}
          {loading ? "SCANNING EXCHANGE LEDGER..." : "FETCH TODAY'S SESSION"}
        </Button>

        {/* Execution Ledger Table */}
        {trades.length > 0 && (
          <div className="bg-[#080808] rounded-3xl border border-zinc-900 shadow-2xl overflow-hidden pb-4">
            <Table>
              <TableHeader className="bg-zinc-900/30">
                <TableRow className="border-zinc-900 hover:bg-transparent">
                  <TableHead className="w-16 text-center text-[9px] font-black text-zinc-600 uppercase tracking-widest">INC.</TableHead>
                  <TableHead className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">SYMBOL</TableHead>
                  <TableHead className="text-right text-[9px] font-black text-zinc-600 uppercase tracking-widest">QTY</TableHead>
                  <TableHead className="text-right pr-8 text-[9px] font-black text-zinc-600 uppercase tracking-widest">PRICE (IST)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((trade: any) => (
                  <TableRow key={trade.exchangeTradeId} className="border-zinc-900/50 hover:bg-zinc-900/20 transition-colors">
                    <TableCell className="text-center">
                      <input
                        type="checkbox" className="w-5 h-5 accent-indigo-600 rounded-lg bg-black border-zinc-800"
                        checked={selectedIds.includes(trade.exchangeTradeId)}
                        onChange={() => setSelectedIds(prev => prev.includes(trade.exchangeTradeId) ? prev.filter(i => i !== trade.exchangeTradeId) : [...prev, trade.exchangeTradeId])}
                      />
                    </TableCell>
                    <TableCell className="py-5">
                      <div className="flex flex-col">
                        <span className="font-black text-sm text-zinc-200">{trade.tradingSymbol}</span>
                        <span className="text-[9px] font-mono text-zinc-700 font-bold">{trade.createTime.split(' ')[1].slice(0, 5)} IST</span>
                      </div>
                    </TableCell>
                    <TableCell className={`text-right font-black text-sm ${trade.transactionType === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                      {trade.tradedQuantity}
                    </TableCell>
                    <TableCell className="text-right font-mono font-black pr-8 text-zinc-500">₹{trade.tradedPrice}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Persistent Sync Action */}
      {trades.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-6 bg-black/80 backdrop-blur-2xl border-t border-zinc-900 md:relative md:bg-transparent md:border-none md:max-w-4xl md:mx-auto md:p-0">
          <Button onClick={() => handleSync('SYNC_DATA')} disabled={syncing || selectedIds.length === 0} className="w-full h-16 bg-emerald-600 hover:bg-emerald-500 text-white font-black uppercase tracking-[0.2em] text-[11px] rounded-2xl shadow-[0_0_50px_rgba(16,185,129,0.2)]">
            {syncing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5 mr-3" />}
            {syncing ? "JOURNALING SESSION..." : `SYNC ${selectedIds.length} EXECUTIONS`}
          </Button>
        </div>
      )}
    </div>
  );
}