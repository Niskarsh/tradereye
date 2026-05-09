"use client";
import React, { useState, useMemo, useCallback } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Calendar, ChevronLeft, ChevronRight, MessageSquare, Save,
    Loader2, RefreshCcw, TrendingUp, TrendingDown, Layers,
    CheckCircle2, XCircle, Camera, Upload, Maximize2, X, Download
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
    ScreenshotUrl?: string;
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
    const [pendingScreenshots, setPendingScreenshots] = useState<Record<string, string>>({});
    const [uploadStatus, setUploadStatus] = useState<Record<string, 'idle' | 'uploading' | 'success' | 'error'>>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error' | null; msg: string }>({ type: null, msg: '' });
    const [fullScreenImage, setFullScreenImage] = useState<string | null>(null);

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

    const handleDownload = async (url: string, symbol: string) => {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = `${symbol}_${selectedDateState}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(blobUrl);
        } catch (err) {
            showStatus('error', 'Download failed');
        }
    };

    const handleCommentChange = (groupId: string, comment: string) => {
        setPendingComments(prev => ({ ...prev, [groupId]: comment }));
    };

    const handleScreenshotUpload = async (groupId: string, file: File, trade: TradeEntry) => {
        setUploadStatus(prev => ({ ...prev, [groupId]: 'uploading' }));
        try {
            const res = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: file.name, fileType: file.type, tradeGroupId: groupId }),
            });
            const result = await res.json();
            if (!res.ok || !result.success) throw new Error(result.error || 'Failed to get upload URL');

            const uploadRes = await fetch(result.signedUrl, {
                method: 'PUT',
                body: file,
                headers: { 'Content-Type': file.type },
            });
            if (!uploadRes.ok) throw new Error('S3 Upload Failed');

            const sheetRes = await fetch('/api/sheets/comment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sheetTitle: trade.sheetTitle,
                    exchTradeId: trade.ExchTradeId,
                    comment: pendingComments[groupId] || trade.Comment,
                    screenshotUrl: result.publicUrl 
                }),
            });
            if (!sheetRes.ok) throw new Error('Spreadsheet update failed');

            setPendingScreenshots(prev => ({ ...prev, [groupId]: result.publicUrl }));
            setUploadStatus(prev => ({ ...prev, [groupId]: 'success' }));
            showStatus('success', 'Screenshot synced');
        } catch (error) {
            setUploadStatus(prev => ({ ...prev, [groupId]: 'error' }));
            showStatus('error', 'Sync failed');
        }
    };

    const saveJournal = async () => {
        const allEntries = [...new Set([...Object.keys(pendingComments), ...Object.keys(pendingScreenshots)])];
        if (allEntries.length === 0) return;
        setSaving(true);
        try {
            await Promise.all(allEntries.map(async (groupId) => {
                const tradeRef = Object.values(analyticsData).flat().find(t => t.TradeGroupId === groupId);
                if (!tradeRef?.sheetTitle || !tradeRef?.ExchTradeId) throw new Error(`Metadata missing for ${groupId}`);

                const res = await fetch('/api/sheets/comment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sheetTitle: tradeRef.sheetTitle,
                        exchTradeId: tradeRef.ExchTradeId,
                        comment: pendingComments[groupId] ?? tradeRef.Comment,
                        screenshotUrl: pendingScreenshots[groupId] || undefined,
                    }),
                });
                if (!res.ok) throw new Error('Failed to save');
            }));

            const updatedData = { ...analyticsData };
            Object.keys(updatedData).forEach(month => {
                updatedData[month] = updatedData[month].map(t => ({
                    ...t,
                    Comment: pendingComments[t.TradeGroupId] ?? t.Comment,
                    ScreenshotUrl: pendingScreenshots[t.TradeGroupId] ?? t.ScreenshotUrl
                }));
            });

            setAnalyticsData(updatedData);
            persistData(updatedData);
            setPendingComments({});
            setPendingScreenshots({});
            setUploadStatus({});
            showStatus('success', 'Journal Updated');
        } catch (e: any) {
            showStatus('error', e.message || 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const monthKeys = useMemo(() => Object.keys(analyticsData).sort((a, b) => {
        const { monthIndex: am, year: ay } = parseMonthKey(a);
        const { monthIndex: bm, year: by } = parseMonthKey(b);
        return new Date(ay, am).getTime() - new Date(by, bm).getTime();
    }), [analyticsData]);

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

    return (
        <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans pb-32">
            {/* Lightbox */}
            {fullScreenImage && (
                <div className="fixed inset-0 z-[100] bg-black/98 flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={() => setFullScreenImage(null)}>
                    <Button variant="ghost" className="absolute top-6 right-6 text-white rounded-full h-12 w-12 bg-white/5 hover:bg-white/10" onClick={() => setFullScreenImage(null)}>
                        <X size={32} />
                    </Button>
                    <img src={fullScreenImage} alt="Expanded chart" className="max-w-full max-h-[90vh] object-contain rounded-lg" />
                </div>
            )}

            {status.type && (
                <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[60] px-6 py-3 rounded-full border shadow-2xl flex items-center gap-3 backdrop-blur-xl animate-in fade-in slide-in-from-top-2 ${status.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-rose-500/10 border-rose-500/20 text-rose-400'}`}>
                    {status.type === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                    <span className="text-[10px] font-black uppercase tracking-widest">{status.msg}</span>
                </div>
            )}

            <div className="max-w-[1600px] mx-auto p-4 md:p-8 flex flex-col lg:flex-row gap-8">
                {/* Fixed sidebar logic to prevent mobile clipping */}
                <aside className="w-full lg:w-[380px] space-y-6 shrink-0">
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

                        <div className="grid grid-cols-7 gap-2">
                            {calendarCells.map((cell, i) => cell ? (
                                <button key={cell.date} onClick={() => setSelectedDateState(cell.date)} className={`aspect-square rounded-2xl flex flex-col items-center justify-center transition-all border ${selectedDateState === cell.date ? 'bg-cyan-500 border-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.25)]' : 'bg-zinc-900/30 border-zinc-800/50 hover:border-zinc-600'}`}>
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

                <main className="flex-1 min-w-0 space-y-6">
                    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 px-2">
                        <h2 className="text-4xl font-black tracking-tighter text-white">{selectedDateState}</h2>
                        <Badge variant="outline" className="w-fit border-zinc-800 text-zinc-500 font-mono py-1.5 px-4 rounded-full uppercase text-[10px] tracking-widest">{selectedDayGroups.length} Active Trades</Badge>
                    </div>

                    <div className="space-y-8">
                        {selectedDayGroups.length === 0 ? (
                            <div className="h-[400px] rounded-[40px] border-2 border-dashed border-zinc-900 flex flex-col items-center justify-center text-zinc-700 bg-zinc-900/5">
                                <Calendar className="w-12 h-12 mb-4 opacity-10" /><p className="font-black uppercase tracking-[0.2em] text-[10px]">No activity recorded</p>
                            </div>
                        ) : selectedDayGroups.map(([groupId, group]) => (
                            <div key={groupId} className="bg-[#0c0c0c] border border-zinc-800 rounded-[32px] overflow-hidden shadow-2xl flex flex-col">
                                {/* CARD HEADER */}
                                <div className="p-6 flex items-center justify-between bg-zinc-900/20 border-b border-zinc-800/40">
                                    <div className="flex items-center gap-4">
                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${group.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-400 shadow-[inset_0_0_20px_rgba(16,185,129,0.05)]' : 'bg-rose-500/10 text-rose-400 shadow-[inset_0_0_20px_rgba(244,63,94,0.05)]'}`}>
                                            {group.pnl >= 0 ? <TrendingUp size={24} /> : <TrendingDown size={24} />}
                                        </div>
                                        <div>
                                            <h3 className="text-xl font-black tracking-tight text-white">{group.trades[0].Symbol}</h3>
                                            <div className="flex items-center gap-2 mt-1">
                                                 <Badge className={`${group.direction.toUpperCase() === 'LONG' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'} border-none text-[9px] px-2 h-5 font-black`}>{group.direction}</Badge>
                                                 <span className="text-[10px] font-bold text-zinc-600 uppercase flex items-center gap-1.5"><Layers size={14} /> {group.trades.length} fills</span>
                                            </div>
                                        </div>
                                    </div>
                                    <p className={`text-3xl font-black ${group.pnl >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>{formatCurrency(group.pnl)}</p>
                                </div>

                                {/* SECTION 1: TRADE FILLS */}
                                <div className="px-6 py-4 overflow-x-auto scrollbar-hide">
                                    <table className="w-full text-left text-[11px] font-bold min-w-[450px]">
                                        <thead><tr className="text-[9px] font-black text-zinc-700 uppercase border-b border-zinc-800/30"><th className="pb-3">Time (IST)</th><th className="pb-3 text-center">Type</th><th className="pb-3 text-right">Qty</th><th className="pb-3 text-right">Execution Price</th></tr></thead>
                                        <tbody className="text-zinc-500">
                                            {group.trades.map((t, idx) => (
                                                <tr key={idx} className="border-b border-zinc-800/10 last:border-0"><td className="py-3 font-mono text-[10px] text-zinc-600">{t['Time (IST)']}</td><td className="py-3 text-center"><Badge className={`${t.OrderType.toUpperCase() === 'BUY' ? 'bg-emerald-500/5 text-emerald-500/70' : 'bg-rose-500/5 text-rose-500/70'} border-none text-[8px] px-2`}>{t.OrderType}</Badge></td><td className="py-3 text-right text-zinc-300">{t.Qty}</td><td className="py-3 text-right text-zinc-400">₹{t.Price}</td></tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                {/* SECTION 2: EXPANDED JOURNAL SPACE */}
                                <div className="px-6 py-6 bg-zinc-950/30 border-t border-zinc-800/50">
                                    <div className="flex items-center gap-2 mb-4 text-zinc-500"><MessageSquare size={14} /><span className="text-[10px] font-black uppercase tracking-widest">Setup & Psychology Journal</span></div>
                                    <textarea
                                        className="w-full bg-zinc-900/30 border border-zinc-800/80 rounded-[24px] p-5 text-sm leading-loose text-zinc-300 min-h-[220px] md:min-h-[300px] resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/40 transition-all placeholder:text-zinc-700"
                                        placeholder="Document your setup, entry triggers, and exit rationale..."
                                        value={pendingComments[groupId] ?? group.trades[0].Comment}
                                        onChange={(e) => handleCommentChange(groupId, e.target.value)}
                                    />
                                </div>

                                {/* SECTION 3: SCREENSHOT WITH DOWNLOAD */}
                                <div className="px-6 pb-8 bg-zinc-950/30">
                                    <div className="flex items-center gap-2 mb-4 text-zinc-500"><Camera size={14} /><span className="text-[10px] font-black uppercase tracking-widest">Chart Analysis</span></div>
                                    
                                    <div className="relative group w-full min-h-[260px] md:min-h-[450px] rounded-[24px] overflow-hidden border border-zinc-800/80 bg-zinc-900/20 shadow-inner">
                                        {(pendingScreenshots[groupId] || group.trades[0].ScreenshotUrl) ? (
                                            <>
                                                <img
                                                    src={pendingScreenshots[groupId] || group.trades[0].ScreenshotUrl}
                                                    alt="Trade Screenshot"
                                                    className="w-full h-auto min-h-[260px] object-contain bg-black/40 cursor-pointer"
                                                    onClick={() => setFullScreenImage(pendingScreenshots[groupId] || group.trades[0].ScreenshotUrl || null)}
                                                />
                                                <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <Button 
                                                        size="icon" 
                                                        className="bg-black/80 hover:bg-cyan-600 rounded-full h-10 w-10 backdrop-blur-md border border-white/10"
                                                        onClick={() => handleDownload(pendingScreenshots[groupId] || group.trades[0].ScreenshotUrl!, group.trades[0].Symbol)}
                                                    >
                                                        <Download size={18} />
                                                    </Button>
                                                    <Button 
                                                        size="icon" 
                                                        className="bg-black/80 hover:bg-cyan-600 rounded-full h-10 w-10 backdrop-blur-md border border-white/10"
                                                        onClick={() => setFullScreenImage(pendingScreenshots[groupId] || group.trades[0].ScreenshotUrl || null)}
                                                    >
                                                        <Maximize2 size={18} />
                                                    </Button>
                                                </div>
                                            </>
                                        ) : (
                                            <div className="absolute inset-0 flex flex-col items-center justify-center p-8">
                                                <input
                                                    type="file"
                                                    accept="image/*"
                                                    onChange={(e) => {
                                                        const file = e.target.files?.[0];
                                                        if (file) handleScreenshotUpload(groupId, file, group.trades[0]);
                                                    }}
                                                    className="hidden"
                                                    id={`screenshot-${groupId}`}
                                                />
                                                <label htmlFor={`screenshot-${groupId}`} className="w-full h-full cursor-pointer flex flex-col items-center justify-center gap-4">
                                                    <div className="w-16 h-16 rounded-full bg-zinc-800/50 flex items-center justify-center border border-zinc-700/50">
                                                        {uploadStatus[groupId] === 'uploading' ? <Loader2 className="w-8 h-8 animate-spin text-cyan-400" /> : <Upload className="w-8 h-8 text-zinc-600" />}
                                                    </div>
                                                    <div className="text-center">
                                                        <span className="text-[10px] font-black text-zinc-500 block uppercase tracking-[0.2em] mb-1">
                                                            {uploadStatus[groupId] === 'uploading' ? 'Syncing to Cloud' : 'Upload Technical Chart'}
                                                        </span>
                                                        <span className="text-[9px] text-zinc-700 block">PNG, JPG up to 10MB</span>
                                                    </div>
                                                </label>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </main>
            </div>

            {/* ACTION BAR */}
            {(Object.keys(pendingComments).length > 0 || Object.keys(pendingScreenshots).length > 0) && (
                <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 w-full max-w-[340px] px-6">
                    <Button
                        onClick={saveJournal}
                        disabled={saving}
                        className="w-full h-14 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white font-black uppercase tracking-[0.3em] text-[10px] shadow-[0_20px_50px_rgba(34,211,238,0.3)] gap-3 animate-in fade-in slide-in-from-bottom-6"
                    >
                        {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                        {saving ? 'Saving...' : `Push ${Object.keys(pendingComments).length + Object.keys(pendingScreenshots).length} Updates`}
                    </Button>
                </div>
            )}
        </div>
    );
}