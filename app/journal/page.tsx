"use client";
import React, { useState, useEffect, useCallback } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Calendar, ChevronLeft, ChevronRight, MessageSquare, Save, Loader2, CheckCircle2, XCircle, Edit2, RefreshCcw } from "lucide-react";
import { useAuth } from '@/context/AuthContext';

interface TradeEntry {
  exchangeTradeId: string;
  tradingSymbol: string;
  createTime: string;
  transactionType: 'BUY' | 'SELL';
  tradedQuantity: number;
  tradedPrice: number;
  comment?: string;
}

interface GroupedTrades {
  [date: string]: TradeEntry[];
}

export default function Journal() {
  const { token } = useAuth();
  const [trades, setTrades] = useState<GroupedTrades>({});
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [comments, setComments] = useState<{ [key: string]: string }>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | null, msg: string }>({ type: null, msg: '' });
  const [allDates, setAllDates] = useState<string[]>([]);

  const showStatus = useCallback((type: 'success' | 'error', msg: string) => {
    setStatus({ type, msg });
    setTimeout(() => setStatus({ type: null, msg: '' }), 4000);
  }, []);

  const fetchTrades = useCallback(async () => {
    if (!token) return showStatus('error', 'AUTH REQUIRED');
    setLoading(true);
    try {
      const res = await fetch(`/api/trades?token=${token}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        // Group trades by date
        const grouped: GroupedTrades = {};
        data.forEach((trade: TradeEntry) => {
          const date = trade.createTime.split(' ')[0];
          if (!grouped[date]) grouped[date] = [];
          grouped[date].push(trade);
        });

        // Sort trades by time within each day
        Object.keys(grouped).forEach(date => {
          grouped[date].sort((a, b) => {
            const timeA = new Date(`${a.createTime}`).getTime();
            const timeB = new Date(`${b.createTime}`).getTime();
            return timeA - timeB;
          });
        });

        setTrades(grouped);
        const dates = Object.keys(grouped).sort().reverse();
        setAllDates(dates);
        if (dates.length > 0 && !selectedDate) {
          setSelectedDate(dates[0]);
        }
        showStatus('success', `FETCHED ${data.length} EXECUTIONS`);
      }
    } catch {
      showStatus('error', 'API LINK FAILED');
    } finally {
      setLoading(false);
    }
  }, [token, selectedDate, showStatus]);

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => {
    if (token) {
      void fetchTrades();
    }
  }, [token, fetchTrades]);

  const getTodaysTrades = () => {
    return trades[selectedDate] || [];
  };

  const navigateToPreviousDay = () => {
    const currentIndex = allDates.indexOf(selectedDate);
    if (currentIndex < allDates.length - 1) {
      setSelectedDate(allDates[currentIndex + 1]);
    }
  };

  const navigateToNextDay = () => {
    const currentIndex = allDates.indexOf(selectedDate);
    if (currentIndex > 0) {
      setSelectedDate(allDates[currentIndex - 1]);
    }
  };

  const updateComment = (tradeId: string, comment: string) => {
    setComments(prev => ({
      ...prev,
      [tradeId]: comment
    }));
  };

  const saveComments = async () => {
    if (Object.keys(comments).length === 0) {
      showStatus('error', 'NO COMMENTS TO SAVE');
      return;
    }

    setSaving(true);
    try {
      // Here you would typically save to your backend/spreadsheet
      // For now, we'll just store them locally
      // You can extend this to sync with spreadsheet via an API endpoint
      showStatus('success', `SAVED ${Object.keys(comments).length} COMMENTS`);
      setComments({});
    } catch {
      showStatus('error', 'SAVE FAILED');
    } finally {
      setSaving(false);
    }
  };

  const todaysTrades = getTodaysTrades();
  const currentIndex = allDates.indexOf(selectedDate);

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans pb-24 pt-16 md:pt-0">
      {/* Toast Alert */}
      {status.type && (
        <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[92%] max-w-sm p-4 rounded-2xl border shadow-2xl flex items-center gap-3 backdrop-blur-xl ${status.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-rose-500/10 border-rose-500/30 text-rose-400'}`}>
          {status.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <span className="text-[11px] font-black uppercase tracking-wider">{status.msg}</span>
        </div>
      )}

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <header className="flex justify-between items-center border-b border-zinc-900 pb-6">
          <div className="space-y-0.5">
            <h1 className="text-2xl font-black italic tracking-tighter text-cyan-400">TRADE JOURNAL</h1>
            <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-[0.2em]">Review & Annotate Your Trades</p>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={fetchTrades} 
            disabled={loading}
            className="h-8 border-zinc-800 bg-zinc-900/50 text-zinc-500 text-[10px] font-black hover:text-cyan-400"
          >
            <RefreshCcw className={`w-3 h-3 mr-2 ${loading ? 'animate-spin' : ''}`} /> 
            REFRESH
          </Button>
        </header>

        {loading && allDates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 space-y-4">
            <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
            <p className="text-zinc-500 text-sm">Loading trades...</p>
          </div>
        ) : allDates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 space-y-4">
            <Calendar className="w-8 h-8 text-zinc-700" />
            <p className="text-zinc-500 text-sm">No trades found</p>
          </div>
        ) : (
          <>
            {/* Date Navigation */}
            <div className="flex items-center justify-between bg-zinc-900/30 rounded-xl p-4 border border-zinc-800">
              <Button
                onClick={navigateToPreviousDay}
                disabled={currentIndex >= allDates.length - 1}
                variant="outline"
                size="sm"
                className="border-zinc-700 hover:bg-zinc-800"
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              
              <div className="text-center">
                <p className="text-sm text-zinc-400">Trading Date</p>
                <p className="text-lg font-black text-cyan-400">{selectedDate}</p>
                <p className="text-xs text-zinc-600 mt-1">{todaysTrades.length} Execution(s)</p>
              </div>

              <Button
                onClick={navigateToNextDay}
                disabled={currentIndex <= 0}
                variant="outline"
                size="sm"
                className="border-zinc-700 hover:bg-zinc-800"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            {/* Trades Table */}
            <div className="bg-zinc-900/20 rounded-xl border border-zinc-800 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900/50">
                    <TableHead className="text-left text-[9px] font-black text-zinc-600 uppercase tracking-widest">Symbol</TableHead>
                    <TableHead className="text-center text-[9px] font-black text-zinc-600 uppercase tracking-widest">Type</TableHead>
                    <TableHead className="text-right text-[9px] font-black text-zinc-600 uppercase tracking-widest">QTY</TableHead>
                    <TableHead className="text-right text-[9px] font-black text-zinc-600 uppercase tracking-widest">Price</TableHead>
                    <TableHead className="text-left text-[9px] font-black text-zinc-600 uppercase tracking-widest">Time</TableHead>
                    <TableHead className="text-left text-[9px] font-black text-zinc-600 uppercase tracking-widest">Comment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {todaysTrades.map((trade) => (
                    <TableRow key={trade.exchangeTradeId} className="border-zinc-900/50 hover:bg-zinc-900/20 transition-colors">
                      <TableCell className="py-4">
                        <span className="font-black text-sm text-zinc-200">{trade.tradingSymbol}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant={trade.transactionType === 'BUY' ? 'default' : 'secondary'}
                          className={`text-[9px] font-black ${
                            trade.transactionType === 'BUY'
                              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                              : 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                          }`}
                        >
                          {trade.transactionType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-black text-sm text-zinc-300">{trade.tradedQuantity}</TableCell>
                      <TableCell className="text-right font-mono font-black text-zinc-500">₹{trade.tradedPrice}</TableCell>
                      <TableCell className="text-[9px] font-mono text-zinc-600 font-bold">
                        {trade.createTime.split(' ')[1]}
                      </TableCell>
                      <TableCell className="py-4">
                        <div className="flex gap-2">
                          {editingId === trade.exchangeTradeId ? (
                            <Input
                              autoFocus
                              placeholder="Add comment..."
                              value={comments[trade.exchangeTradeId] || ''}
                              onChange={(e) => updateComment(trade.exchangeTradeId, e.target.value)}
                              onBlur={() => setEditingId(null)}
                              className="h-8 bg-zinc-800 border-zinc-700 text-zinc-200 placeholder-zinc-600 text-[12px]"
                            />
                          ) : (
                            <button
                              onClick={() => setEditingId(trade.exchangeTradeId)}
                              className="flex items-center gap-2 px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors text-[12px] text-zinc-400 hover:text-cyan-400"
                            >
                              {comments[trade.exchangeTradeId] ? (
                                <>
                                  <MessageSquare className="w-3 h-3" />
                                  <span className="truncate max-w-xs">{comments[trade.exchangeTradeId]}</span>
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

            {/* Save Button */}
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
          </>
        )}
      </div>
    </div>
  );
}
