"use client";
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Calendar, ChevronLeft, ChevronRight, MessageSquare, Save,
    Loader2, RefreshCcw, TrendingUp, TrendingDown, Clock, Layers,
    CheckCircle2, XCircle
} from "lucide-react";

// --- Functional Helpers ---
const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const getMonthKey = (date: Date) => `${monthNames[date.getMonth()]}-${date.getFullYear()}`;
const formatMonthLabel = (monthKey: string) => {
    const [month, year] = monthKey.split('-');
    return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${year}`;
};
const buildDateKey = (year: number, monthIndex: number, day: number) => `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const parseMonthKey = (monthKey: string) => {
    const parts = monthKey.split('-');
    return { monthIndex: monthNames.indexOf(parts[0].toLowerCase()), year: Number(parts[1]) };
};

const formatCurrency = (num: number) => {
    const absNum = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (absNum >= 100000) return `${sign}₹${(absNum / 100000).toFixed(1)}L`;
    if (absNum >= 1000) return `${sign}₹${(absNum / 1000).toFixed(1)}K`;
    return `${sign}₹${absNum.toFixed(0)}`;
};

interface TradeEntry {
    TradeGroupId: string;
    date: string;
    Symbol: string;
    Direction: string;
    OrderType: string;
    Price: string;
    Qty: string;
    NetPnL: string;
    'Time (IST)': string;
    Comment: string;
    ExchTradeId: string;
    sheetTitle?: string;
}

export default function Journal() {
    const [analyticsData, setAnalyticsData] = useState<Record<string, TradeEntry[]>>(() => {
        if (typeof window === 'undefined') return {};
        const cached = localStorage.getItem('traderEye_analytics_ranged');
        return cached ? JSON.parse(cached) : {};
    });

    const [selectedMonth, setSelectedMonth] = useState<string>(getMonthKey(new Date()));
    const [selectedDateState, setSelectedDateState] = useState<string>(new Date().toISOString().split('T')[0]);
    const [pendingComments, setPendingComments] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error' | null; msg: string }>({ type: null, msg: '' });

    const showStatus = useCallback((type: 'success' | 'error', msg: string) => {
        setStatus({ type, msg });
        setTimeout(() => setStatus({ type: null, msg: '' }), 4000);
    }, []);

    const persistData = useCallback((data: Record<string, TradeEntry[]>) => {
        localStorage.setItem('traderEye_analytics_ranged', JSON.stringify(data));
    }, []);

    const refreshData = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/analytics?month=${selectedMonth}`);
            const result = await res.json();
            if (result.data) {
                const newData = { ...analyticsData, ...result.data };
                setAnalyticsData(newData);
                persistData(newData);
                showStatus('success', 'Data Synchronized');
            }
        } catch (e) {
            showStatus('error', 'Sync Failed');
        } finally {
            setLoading(false);
        }
    }, [selectedMonth, analyticsData, persistData, showStatus]);

    // --- Comment Persistance Logic (Fixed) ---
    const handleCommentChange = (groupId: string, comment: string) => {
        setPendingComments(prev => ({ ...prev, [groupId]: comment }));
    };

    // Inside your Journal component...

    const saveJournal = async () => {
        const entries = Object.entries(pendingComments);
        if (entries.length === 0) return;

        setSaving(true);
        try {
            // We iterate through every TradeGroupId that has a pending comment
            await Promise.all(entries.map(async ([groupId, commentText]) => {
                // Find the trade in your data to get the metadata (sheetTitle, ExchTradeId)
                const tradeRef = Object.values(analyticsData)
                    .flat()
                    .find(t => t.TradeGroupId === groupId);

                // Log for debugging if fields are missing
                if (!tradeRef?.sheetTitle || !tradeRef?.ExchTradeId) {
                    console.error(`Missing metadata for Group ${groupId}:`, tradeRef);
                    throw new Error(`Trade ${groupId} is missing sheet information.`);
                }

                const res = await fetch('/api/sheets/comment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sheetTitle: tradeRef.sheetTitle,
                        exchTradeId: tradeRef.ExchTradeId, // The API expects this specific key
                        comment: commentText,
                    }),
                });

                const result = await res.json();
                if (!res.ok || !result.success) {
                    throw new Error(result.error || 'Failed to save');
                }
            }));

            // Success: Update local state to reflect the new comments
            const updatedData = { ...analyticsData };
            Object.keys(updatedData).forEach(month => {
                updatedData[month] = updatedData[month].map(t => {
                    if (pendingComments[t.TradeGroupId] !== undefined) {
                        return { ...t, Comment: pendingComments[t.TradeGroupId] };
                    }
                    return t;
                });
            });

            setAnalyticsData(updatedData);
            persistData(updatedData); // Save to local storage
            setPendingComments({});
            showStatus('success', 'Journal Updated Successfully');
        } catch (e: any) {
            console.error("SAVE ERROR:", e.message);
            showStatus('error', e.message || 'Failed to save changes');
        } finally {
            setSaving(false);
        }
    };
    const monthKeys = useMemo(() => {
        return Object.keys(analyticsData).sort((a, b) => {
            const { monthIndex: am, year: ay } = parseMonthKey(a);
            const { monthIndex: bm, year: by } = parseMonthKey(b);
            return new Date(ay, am).getTime() - new Date(by, bm).getTime();
        });
    }, [analyticsData]);

    const displayMonth = monthKeys.includes(selectedMonth) ? selectedMonth : (monthKeys[monthKeys.length - 1] || selectedMonth);
    const currentMonthRows = analyticsData[displayMonth] ?? [];

    const groupedByDay = useMemo(() => {
        const dayMap = new Map<string, Record<string, { trades: TradeEntry[], pnl: number, direction: string }>>();
        currentMonthRows.forEach(row => {
            if (!dayMap.has(row.date)) dayMap.set(row.date, {});
            const dayGroups = dayMap.get(row.date)!;
            if (!dayGroups[row.TradeGroupId]) {
                dayGroups[row.TradeGroupId] = { trades: [], pnl: Number(row.NetPnL) || 0, direction: row.Direction };
            }
            dayGroups[row.TradeGroupId].trades.push(row);
        });
        return dayMap;
    }, [currentMonthRows]);

    const dailyPnlMap = useMemo(() => {
        const map = new Map<string, number>();
        groupedByDay.forEach((groups, date) => {
            map.set(date, Object.values(groups).reduce((sum, g) => sum + g.pnl, 0));
        });
        return map;
    }, [groupedByDay]);

    const monthTotal = useMemo(() => Array.from(dailyPnlMap.values()).reduce((sum, v) => sum + v, 0), [dailyPnlMap]);

    const calendarCells = useMemo(() => {
        const { monthIndex, year } = parseMonthKey(displayMonth);
        const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
        const firstDayOffset = new Date(year, monthIndex, 1).getDay();
        const cells = [];
        for (let i = 0; i < firstDayOffset; i++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) {
            const date = buildDateKey(year, monthIndex, d);
            cells.push({ day: d, date, pnl: dailyPnlMap.get(date) ?? 0, hasData: dailyPnlMap.has(date) });
        }
        return cells;
    }, [dailyPnlMap, displayMonth]);

    const selectedDayGroups = useMemo(() => Object.entries(groupedByDay.get(selectedDateState) || {}), [groupedByDay, selectedDateState]);
    console.log('Selected Day Groups:', selectedDayGroups);

    return (
        <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans pb-24">
            {status.type && (
                <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-full border shadow-2xl flex items-center gap-3 backdrop-blur-xl animate-in fade-in slide-in-from-top-4 ${status.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                    }`}>
                    {status.type === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                    <span className="text-[10px] font-black uppercase tracking-[0.2em]">{status.msg}</span>
                </div>
            )}

            <div className="max-w-[1600px] mx-auto p-4 md:p-8 grid gap-8 lg:grid-cols-[380px_1fr]">
                <aside className="space-y-6">
                    <header className="flex items-center justify-between px-2">
                        <h1 className="text-2xl font-black italic tracking-tighter text-white">TRADERE<span className="text-cyan-500">YE</span></h1>
                        <Button size="icon" variant="outline" onClick={refreshData} disabled={loading} className="rounded-full border-zinc-800 bg-zinc-900/50">
                            <RefreshCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        </Button>
                    </header>

                    <div className="bg-[#0c0c0c] border border-zinc-800 rounded-[32px] p-6 shadow-2xl">
                        <div className="flex items-center justify-between mb-8">
                            <h2 className="font-black text-xl uppercase tracking-tighter">{formatMonthLabel(displayMonth)}</h2>
                            <div className="flex gap-2">
                                <Button variant="secondary" size="icon" className="h-8 w-8 rounded-full bg-zinc-900 border-zinc-800" onClick={() => {
                                    const idx = monthKeys.indexOf(displayMonth);
                                    if (idx > 0) setSelectedMonth(monthKeys[idx - 1]);
                                }}><ChevronLeft size={16} /></Button>
                                <Button variant="secondary" size="icon" className="h-8 w-8 rounded-full bg-zinc-900 border-zinc-800" onClick={() => {
                                    const idx = monthKeys.indexOf(displayMonth);
                                    if (idx < monthKeys.length - 1) setSelectedMonth(monthKeys[idx + 1]);
                                }}><ChevronRight size={16} /></Button>
                            </div>
                        </div>

                        <div className="grid grid-cols-7 gap-1 text-center mb-3">
                            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                                <span key={`day-header-${i}`} className="text-[10px] font-black text-zinc-700">{d}</span>
                            ))}
                        </div>

                        <div className="grid grid-cols-7 gap-2">
                            {calendarCells.map((cell, i) => cell ? (
                                <button key={cell.date} onClick={() => setSelectedDateState(cell.date)} className={`aspect-square rounded-2xl flex flex-col items-center justify-center transition-all border ${selectedDateState === cell.date ? 'bg-cyan-500 border-cyan-400 shadow-[0_0_25px_rgba(34,211,238,0.3)]' : 'bg-zinc-900/30 border-zinc-800/50 hover:border-zinc-600'
                                    }`}>
                                    <span className={`text-[11px] font-black ${selectedDateState === cell.date ? 'text-black' : 'text-zinc-500'}`}>{cell.day}</span>
                                    {cell.hasData && (
                                        <span className={`text-[8px] font-black mt-1 leading-none ${selectedDateState === cell.date ? 'text-black' : cell.pnl >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                                            {formatCurrency(cell.pnl)}
                                        </span>
                                    )}
                                </button>
                            ) : <div key={`e-${i}`} />)}
                        </div>

                        <div className="mt-8 pt-6 border-t border-zinc-800/50 grid grid-cols-2 gap-4">
                            <div><p className="text-[10px] text-zinc-600 uppercase font-black">Day PnL</p><p className={`text-2xl font-black mt-1 ${dailyPnlMap.get(selectedDateState) || 0 >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>{formatCurrency(dailyPnlMap.get(selectedDateState) || 0)}</p></div>
                            <div className="text-right"><p className="text-[10px] text-zinc-600 uppercase font-black">Month Total</p><p className={`text-2xl font-black mt-1 ${monthTotal >= 0 ? 'text-white' : 'text-rose-500'}`}>{formatCurrency(monthTotal)}</p></div>
                        </div>
                    </div>
                </aside>

                <main className="space-y-6">
                    <div className="flex items-end justify-between px-2">
                        <h2 className="text-4xl font-black tracking-tighter">{selectedDateState}</h2>
                        <Badge variant="outline" className="border-zinc-800 text-zinc-500 font-mono py-1.5 px-4 rounded-full">{selectedDayGroups.length} TRADE(S)</Badge>
                    </div>

                    <div className="space-y-4">
                        {selectedDayGroups.length === 0 ? (
                            <div className="h-[450px] rounded-[40px] border-2 border-dashed border-zinc-900 flex flex-col items-center justify-center text-zinc-700 bg-zinc-900/10">
                                <Calendar className="w-12 h-12 mb-4 opacity-10" /><p className="font-black uppercase tracking-widest text-xs">No records for this date</p>
                            </div>
                        ) : selectedDayGroups.map(([groupId, group]) => (
                            <div key={groupId} className="bg-[#0c0c0c] border border-zinc-800 rounded-[32px] overflow-hidden shadow-xl">
                                <div className="p-6 flex items-center justify-between bg-zinc-900/30 border-b border-zinc-800/50">
                                    <div className="flex items-center gap-5">
                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${group.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                                            {group.pnl >= 0 ? <TrendingUp size={24} /> : <TrendingDown size={24} />}
                                        </div>
                                        <div>
                                            <h3 className="text-xl font-black tracking-tight">{group.trades[0].Symbol}</h3>
                                            <span className="text-[10px] font-bold text-zinc-600 uppercase flex items-center gap-1.5 mt-1"><Layers size={14} /> {group.trades.length} Executions <Badge className={`${group.direction.toUpperCase() === 'LONG' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'} border-none text-[9px] px-2`}>{group.direction}</Badge></span>
                                        </div>
                                    </div>
                                    <div className="text-right"><p className="text-[10px] font-black text-zinc-600 uppercase mb-1">Total PnL</p><p className={`text-3xl font-black ${group.pnl >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>{formatCurrency(group.pnl)}</p></div>
                                </div>
                                <div className="grid md:grid-cols-[1fr_360px]">
                                    <div className="p-6 overflow-x-auto border-r border-zinc-800/50">
                                        <table className="w-full text-left text-[11px] font-bold">
                                            <thead><tr className="text-[9px] font-black text-zinc-600 uppercase border-b border-zinc-800/50"><th className="pb-3">Time</th><th className="pb-3 text-center">Order Type</th><th className="pb-3 text-right">Qty</th><th className="pb-3 text-right">Price</th></tr></thead>
                                            <tbody className="text-zinc-400">
                                                {group.trades.map((t, idx) => (
                                                    <tr key={idx}><td className="py-3 font-mono text-[10px] text-zinc-500">{t['Time (IST)']}</td><td className="py-3 text-center"><Badge className={`${t.OrderType.toUpperCase() === 'BUY' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'} border-none text-[9px] px-2`}>{t.OrderType}</Badge></td><td className="py-3 text-right text-zinc-200">{t.Qty}</td><td className="py-3 text-right text-zinc-500">₹{t.Price}</td></tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="p-6 bg-zinc-950/40 flex flex-col">
                                        <div className="flex items-center gap-2 mb-4 text-zinc-600"><MessageSquare size={14} /><span className="text-[10px] font-black uppercase">Trade Journal</span></div>
                                        <textarea
                                            className="flex-1 bg-transparent border-none focus:ring-0 text-sm leading-relaxed text-zinc-400 min-h-[120px] resize-none font-medium"
                                            placeholder="Enter setup details..."
                                            value={pendingComments[groupId] ?? group.trades[0].Comment}
                                            onChange={(e) => handleCommentChange(groupId, e.target.value)}
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </main>
            </div>

            {Object.keys(pendingComments).length > 0 && (
                <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50">
                    <Button
                        onClick={saveJournal}
                        disabled={saving}
                        className="h-14 px-10 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white font-black uppercase tracking-widest text-xs shadow-[0_20px_50px_rgba(34,211,238,0.4)] gap-3 animate-in fade-in slide-in-from-bottom-4"
                    >
                        {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                        {saving ? 'Saving...' : `Save ${Object.keys(pendingComments).length} Journal Entries`}
                    </Button>
                </div>
            )}
        </div>
    );
}