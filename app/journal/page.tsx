"use client";
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Calendar, ChevronLeft, ChevronRight, MessageSquare, Save, Loader2, CheckCircle2, XCircle, Edit2, RefreshCcw } from "lucide-react";

const monthNames = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const getMonthKey = (date: Date) => `${monthNames[date.getMonth()]}-${date.getFullYear()}`;
const formatMonthLabel = (monthKey: string) => {
  const [month, year] = monthKey.split('-');
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${year}`;
};
const buildDateKey = (year: number, monthIndex: number, day: number) => `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const parseMonthKey = (monthKey: string) => {
  const [month, year] = monthKey.split('-');
  return {
    monthIndex: monthNames.indexOf(month.toLowerCase()),
    year: Number(year),
  };
};

interface TradeEntry {
  TradeGroupId: string;
  date: string;
  Symbol: string;
  Direction: string;
  OrderType: string;
  Price: string;
  Qty: string;
  GrossPnL: string;
  NetPnL: string;
  TotalCharges: string;
  Status: string;
  'Time (IST)': string;
  'Duration (Sec)': string;
  IsConsistent: string;
  ExchTradeId: string;
  Comment: string;
  sheetTitle?: string;
  rowNumber?: number | null;
}

interface CalendarCell {
  day: number;
  date: string;
  pnl: number;
  hasData: boolean;
}

export default function Journal() {
  const [analyticsData, setAnalyticsData] = useState<Record<string, TradeEntry[]>>(() => {
    if (typeof window === 'undefined') return {};
    const cached = localStorage.getItem('traderEye_analytics_ranged');
    if (!cached) return {};
    try {
      return JSON.parse(cached) as Record<string, TradeEntry[]>;
    } catch {
      return {};
    }
  });
  const [selectedMonth, setSelectedMonth] = useState<string>(getMonthKey(new Date()));
  const [selectedDateState, setSelectedDateState] = useState<string>(new Date().toISOString().split('T')[0]);
  const [comments, setComments] = useState<{ [tradeId: string]: string }>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | null; msg: string }>({ type: null, msg: '' });

  const showStatus = useCallback((type: 'success' | 'error', msg: string) => {
    setStatus({ type, msg });
    setTimeout(() => setStatus({ type: null, msg: '' }), 4000);
  }, []);

  const getDefaultRange = () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return {
      start: getMonthKey(start),
      end: getMonthKey(now),
    };
  };

  const persistRangeData = useCallback((data: Record<string, TradeEntry[]>) => {
    localStorage.setItem('traderEye_analytics_ranged', JSON.stringify(data));
    const currentKey = getMonthKey(new Date());
    if (data[currentKey]) {
      localStorage.setItem('traderEye_analytics', JSON.stringify(data[currentKey]));
    }
  }, []);

  const refreshData = useCallback(async (startMonth?: string, endMonth?: string) => {
    setLoading(true);
    try {
      const range = startMonth && endMonth ? { start: startMonth, end: endMonth } : getDefaultRange();
      const res = await fetch(`/api/analytics?start=${range.start}&end=${range.end}`);
      
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to fetch analytics data: ${res.status} ${errorText.substring(0, 100)}`);
      }
      
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      setAnalyticsData((prev) => {
        const merged = { ...prev, ...data.data };
        persistRangeData(merged);
        return merged;
      });
      setSelectedMonth(data.current || getMonthKey(new Date()));
      showStatus('success', 'Spreadsheet data refreshed.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      showStatus('error', message);
    } finally {
      setLoading(false);
    }
  }, [persistRangeData, showStatus]);

  useEffect(() => {
    const currentKey = getMonthKey(new Date());
    if (Object.keys(analyticsData).length === 0) {
      const fetchData = async () => {
        await refreshData();
      };
      void fetchData();
      return;
    }
    if (!analyticsData[currentKey]) {
      const fetchCurrentMonth = async () => {
        await refreshData(currentKey, currentKey);
      };
      void fetchCurrentMonth();
    }
  }, [analyticsData, refreshData]);

  const monthKeys = useMemo(() => {
    return Object.keys(analyticsData).sort((a, b) => {
      const aDate = new Date(parseMonthKey(a).year, parseMonthKey(a).monthIndex, 1).getTime();
      const bDate = new Date(parseMonthKey(b).year, parseMonthKey(b).monthIndex, 1).getTime();
      return aDate - bDate;
    });
  }, [analyticsData]);

  const displayMonth = useMemo(() => {
    if (monthKeys.includes(selectedMonth)) return selectedMonth;
    return monthKeys.length > 0 ? monthKeys[monthKeys.length - 1] : selectedMonth;
  }, [monthKeys, selectedMonth]);

  const selectedDate = useMemo(() => {
    const [monthName, yearString] = displayMonth.split('-');
    const monthIndex = monthNames.indexOf(monthName.toLowerCase());
    const parsedDate = new Date(selectedDateState);
    const selectedYear = parsedDate.getFullYear();
    const selectedMonthIndex = parsedDate.getMonth();
    if (selectedMonthIndex !== monthIndex || selectedYear !== Number(yearString)) {
      return `${yearString}-${String(monthIndex + 1).padStart(2, '0')}-01`;
    }
    return selectedDateState;
  }, [displayMonth, selectedDateState]);

  const currentMonthRows = useMemo(() => analyticsData[displayMonth] ?? [], [analyticsData, displayMonth]);

  const currentMonthUniqueRows = useMemo(() => {
    const seen = new Map<string, TradeEntry>();
    currentMonthRows.forEach((row) => {
      if (!seen.has(row.TradeGroupId)) {
        seen.set(row.TradeGroupId, row);
      }
    });
    return Array.from(seen.values());
  }, [currentMonthRows]);

  const dailyPnlMap = useMemo(() => {
    const map = new Map<string, number>();
    currentMonthUniqueRows.forEach((row) => {
      const value = Number(row.NetPnL) || 0;
      map.set(row.date, (map.get(row.date) || 0) + value);
    });
    return map;
  }, [currentMonthUniqueRows]);

  const calendarCells = useMemo(() => {
    const { monthIndex, year } = parseMonthKey(displayMonth);
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const firstDayOffset = new Date(year, monthIndex, 1).getDay();
    const cells: Array<CalendarCell | null> = [];

    for (let i = 0; i < firstDayOffset; i += 1) {
      cells.push(null);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = buildDateKey(year, monthIndex, day);
      const pnl = dailyPnlMap.get(date) ?? 0;
      cells.push({
        day,
        date,
        pnl,
        hasData: dailyPnlMap.has(date),
      });
    }

    while (cells.length < 42) {
      cells.push(null);
    }

    return cells;
  }, [dailyPnlMap, displayMonth]);

  const todaysTrades = useMemo(() => {
    return currentMonthRows.filter((row) => row.date === selectedDate);
  }, [currentMonthRows, selectedDate]);

  const monthTotal = useMemo(() => {
    return currentMonthUniqueRows.reduce((sum, row) => sum + (Number(row.NetPnL) || 0), 0);
  }, [currentMonthUniqueRows]);

  const selectedDayUniqueTrades = useMemo(() => {
    const seen = new Map<string, TradeEntry>();
    todaysTrades.forEach((row) => {
      if (!seen.has(row.TradeGroupId)) {
        seen.set(row.TradeGroupId, row);
      }
    });
    return Array.from(seen.values());
  }, [todaysTrades]);

  const selectedDayTotal = useMemo(() => {
    return selectedDayUniqueTrades.reduce((sum, row) => sum + (Number(row.NetPnL) || 0), 0);
  }, [selectedDayUniqueTrades]);

  const updateComment = (tradeId: string, comment: string) => {
    setComments((prev) => ({
      ...prev,
      [tradeId]: comment,
    }));
  };

  const saveComments = async () => {
    const entries = Object.entries(comments);
    if (entries.length === 0) {
      showStatus('error', 'NO COMMENTS TO SAVE');
      return;
    }

    setSaving(true);
    try {
      await Promise.all(entries.map(async ([tradeId, comment]) => {
        const matchingRow = Object.values(analyticsData)
          .flat()
          .find((row) => row.ExchTradeId === tradeId);

        if (!matchingRow) {
          throw new Error('Unable to find trade row for comment update');
        }

        const res = await fetch('/api/sheets/comment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheetTitle: matchingRow.sheetTitle,
            exchTradeId: matchingRow.ExchTradeId,
            comment,
          }),
        });

        const result = await res.json();
        if (!res.ok || !result.success) {
          throw new Error(result.error || 'Failed to save comment');
        }
      }));

      setAnalyticsData((prev) => {
        const updated: Record<string, TradeEntry[]> = {};
        Object.entries(prev).forEach(([month, rows]) => {
          updated[month] = rows.map((row) => {
            if (comments[row.ExchTradeId]) {
              return { ...row, Comment: comments[row.ExchTradeId] };
            }
            return row;
          });
        });
        persistRangeData(updated);
        return updated;
      });

      setComments({});
      setEditingId(null);
      showStatus('success', 'Comments saved to spreadsheet');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Save failed';
      showStatus('error', message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans pb-24 pt-16 md:pt-0">
      {status.type && (
        <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[92%] max-w-sm p-4 rounded-2xl border shadow-2xl flex items-center gap-3 backdrop-blur-xl ${
          status.type === 'success'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
        }`}>
          {status.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <span className="text-[11px] font-black uppercase tracking-wider">{status.msg}</span>
        </div>
      )}

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row justify-between items-start sm:items-center border-b border-zinc-900 pb-6">
          <div className="space-y-1">
            <h1 className="text-2xl font-black italic tracking-tighter text-cyan-400">TRADE JOURNAL</h1>
            <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-[0.2em]">Calendar view, local storage first, spreadsheet sync</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshData()}
            disabled={loading}
            className="h-8 border-zinc-800 bg-zinc-900/50 text-zinc-500 text-[10px] font-black hover:text-cyan-400"
          >
            <RefreshCcw className={`w-3 h-3 mr-2 ${loading ? 'animate-spin' : ''}`} />
            REFRESH
          </Button>
        </header>

        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-3xl border border-zinc-800 bg-[#0c0c0c] p-6 shadow-xl">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-black">Month Calendar</p>
                <h2 className="text-lg sm:text-xl font-black text-zinc-100 mt-2">{formatMonthLabel(displayMonth)}</h2>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const currentIndex = monthKeys.indexOf(displayMonth);
                    if (currentIndex > 0) {
                      setSelectedMonth(monthKeys[currentIndex - 1]);
                    }
                  }}
                  disabled={monthKeys.indexOf(displayMonth) <= 0}
                  className="h-8 border-zinc-700"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const currentIndex = monthKeys.indexOf(displayMonth);
                    if (currentIndex < monthKeys.length - 1) {
                      setSelectedMonth(monthKeys[currentIndex + 1]);
                    }
                  }}
                  disabled={monthKeys.indexOf(displayMonth) >= monthKeys.length - 1}
                  className="h-8 border-zinc-700"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-7 gap-1 sm:gap-2 text-[9px] sm:text-[10px] uppercase tracking-[0.25em] text-zinc-500 mb-3">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => (
                <div key={label} className="text-center font-black">{label}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1 sm:gap-2">
              {calendarCells.map((cell, index) => {
                if (!cell) {
                  return <div key={`empty-${index}`} className="min-h-[78px] rounded-3xl bg-zinc-950/60"></div>;
                }

                const isSelected = cell.date === selectedDate;
                const isProfit = cell.pnl >= 0;
                return (
                  <button
                    key={cell.date}
                    onClick={() => setSelectedDateState(cell.date)}
                    className={`group min-h-[72px] sm:min-h-[92px] rounded-3xl border p-2 sm:p-3 text-left transition ${
                      isSelected ? 'border-cyan-400 bg-cyan-500/10' : 'border-zinc-800 bg-zinc-950/70 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs sm:text-sm font-black text-zinc-100">{cell.day}</span>
                      <span className={`text-[10px] font-black uppercase tracking-[0.3em] ${cell.hasData ? 'text-zinc-400' : 'text-zinc-600'}`}>Day</span>
                    </div>
                    <div className="mt-auto">
                      {cell.hasData ? (
                        <p className={`text-xs sm:text-sm font-black ${isProfit ? 'text-emerald-400' : 'text-rose-500'}`}>
                          ₹{cell.pnl.toFixed(2)}
                        </p>
                      ) : (
                        <p className="text-[11px] text-zinc-600">No trades</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-4">
                <p className="text-[9px] uppercase tracking-[0.35em] text-zinc-500 font-black">Month PnL</p>
                <p className={`text-2xl font-black mt-3 ${monthTotal >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                  ₹{monthTotal.toFixed(2)}
                </p>
              </div>
              <div className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-4">
                <p className="text-[9px] uppercase tracking-[0.35em] text-zinc-500 font-black">Selected Day</p>
                <p className={`text-2xl font-black mt-3 ${selectedDayTotal >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                  ₹{selectedDayTotal.toFixed(2)}
                </p>
                <p className="text-[10px] text-zinc-500 mt-2">{todaysTrades.length} trade(s)</p>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-zinc-800 bg-[#0c0c0c] p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4 mb-6">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-black">Trades for</p>
                <h2 className="text-xl font-black text-zinc-100 mt-2">{selectedDate}</h2>
              </div>
              <Badge className="text-[11px] font-black uppercase tracking-[0.25em] bg-zinc-900 text-zinc-300 border-zinc-700">
                {todaysTrades.length} entries
              </Badge>
            </div>

            {todaysTrades.length === 0 ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center rounded-3xl border border-dashed border-zinc-800 bg-zinc-950/70 p-8 text-center text-zinc-500">
                <Calendar className="w-8 h-8 mb-4 text-zinc-600" />
                <p className="text-sm font-black">No journal entries found for this day.</p>
                <p className="text-[11px] text-zinc-500 mt-2">Click another day or refresh to pull spreadsheet data.</p>
              </div>
            ) : (
              <>
                <div className="space-y-3 sm:hidden">
                  {todaysTrades.map((trade) => (
                    <div key={`card-${trade.ExchTradeId}`} className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase tracking-[0.25em] text-zinc-500">{trade.Symbol}</p>
                          <p className="text-sm font-black text-zinc-100 mt-1 truncate">{trade.Direction}</p>
                        </div>
                        <p className={`text-sm font-black ${Number(trade.NetPnL) >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                          ₹{Number(trade.NetPnL).toFixed(2)}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-3 text-[11px] text-zinc-400">
                        <div>
                          <p className="uppercase tracking-[0.2em]">Qty</p>
                          <p className="font-black text-zinc-200">{trade.Qty}</p>
                        </div>
                        <div>
                          <p className="uppercase tracking-[0.2em]">Price</p>
                          <p className="font-black text-zinc-200">₹{trade.Price}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-[11px] text-zinc-400">
                        <span>{trade['Time (IST)']}</span>
                        <span>{trade.OrderType}</span>
                      </div>
                      <div className="mt-3">
                        {editingId === trade.ExchTradeId ? (
                          <Input
                            autoFocus
                            placeholder="Add comment..."
                            value={comments[trade.ExchTradeId] ?? trade.Comment}
                            onChange={(e) => updateComment(trade.ExchTradeId, e.target.value)}
                            onBlur={() => setEditingId(null)}
                            className="w-full h-10 bg-zinc-800 border-zinc-700 text-zinc-200 placeholder-zinc-600 text-[12px]"
                          />
                        ) : (
                          <button
                            onClick={() => setEditingId(trade.ExchTradeId)}
                            className="inline-flex items-center gap-2 rounded-full border border-zinc-700 px-3 py-2 text-[11px] text-zinc-300 hover:bg-zinc-900"
                          >
                            <Edit2 className="w-3 h-3" />
                            {comments[trade.ExchTradeId] || trade.Comment ? 'Edit comment' : 'Add comment'}
                          </button>
                        )}
                        {comments[trade.ExchTradeId] || trade.Comment ? (
                          <p className="mt-2 text-[11px] text-zinc-400 truncate">{comments[trade.ExchTradeId] || trade.Comment}</p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="overflow-x-auto hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow className="border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900/50">
                      <TableHead className="text-left text-[9px] font-black text-zinc-600 uppercase tracking-widest">Symbol</TableHead>
                      <TableHead className="text-center text-[9px] font-black text-zinc-600 uppercase tracking-widest">Side</TableHead>
                      <TableHead className="text-right text-[9px] font-black text-zinc-600 uppercase tracking-widest">Qty</TableHead>
                      <TableHead className="text-right text-[9px] font-black text-zinc-600 uppercase tracking-widest">Price</TableHead>
                      <TableHead className="text-right text-[9px] font-black text-zinc-600 uppercase tracking-widest">PnL</TableHead>
                      <TableHead className="text-left text-[9px] font-black text-zinc-600 uppercase tracking-widest">Time</TableHead>
                      <TableHead className="text-left text-[9px] font-black text-zinc-600 uppercase tracking-widest">Comment</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {todaysTrades.map((trade) => (
                      <TableRow key={trade.ExchTradeId} className="border-zinc-900/50 hover:bg-zinc-900/20 transition-colors">
                        <TableCell className="py-4">
                          <span className="font-black text-sm text-zinc-200">{trade.Symbol}</span>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge
                            variant={trade.Direction === 'BUY' ? 'default' : 'secondary'}
                            className={`text-[9px] font-black ${
                              trade.Direction === 'BUY'
                                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                                : 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                            }`}
                          >
                            {trade.Direction}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-black text-sm text-zinc-300">{trade.Qty}</TableCell>
                        <TableCell className="text-right font-mono font-black text-zinc-500">₹{trade.Price}</TableCell>
                        <TableCell className={`text-right font-black text-sm ${Number(trade.NetPnL) >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                          ₹{Number(trade.NetPnL).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-[9px] font-mono text-zinc-600 font-bold">
                          {trade['Time (IST)']}
                        </TableCell>
                        <TableCell className="py-4">
                          <div className="flex gap-2">
                            {editingId === trade.ExchTradeId ? (
                              <Input
                                autoFocus
                                placeholder="Add comment..."
                                value={comments[trade.ExchTradeId] ?? trade.Comment}
                                onChange={(e) => updateComment(trade.ExchTradeId, e.target.value)}
                                onBlur={() => setEditingId(null)}
                                className="h-8 bg-zinc-800 border-zinc-700 text-zinc-200 placeholder-zinc-600 text-[12px]"
                              />
                            ) : (
                              <button
                                onClick={() => setEditingId(trade.ExchTradeId)}
                                className="flex items-center gap-2 px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors text-[12px] text-zinc-400 hover:text-cyan-400"
                              >
                                {comments[trade.ExchTradeId] || trade.Comment ? (
                                  <>
                                    <MessageSquare className="w-3 h-3" />
                                    <span className="truncate max-w-xs">{comments[trade.ExchTradeId] || trade.Comment}</span>
                                  </>
                                ) : (
                                  <>
                                    <Edit2 className="w-3 h-3" />
                                    <span>Add comment</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              </>
            )}

            {Object.keys(comments).length > 0 && (
              <div className="fixed bottom-0 left-0 right-0 p-6 bg-black/80 backdrop-blur-2xl border-t border-zinc-900 md:relative md:bg-transparent md:border-none md:max-w-6xl md:mx-auto md:p-0">
                <Button
                  onClick={saveComments}
                  disabled={saving}
                  className="w-full h-12 bg-cyan-600 hover:bg-cyan-500 text-white font-black uppercase tracking-[0.2em] text-[11px] rounded-xl shadow-[0_0_50px_rgba(34,211,238,0.2)]"
                >
                  {saving ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Save className="w-5 h-5 mr-2" />}
                  {saving ? 'SAVING...' : `SAVE ${Object.keys(comments).length} COMMENT(S)`}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
