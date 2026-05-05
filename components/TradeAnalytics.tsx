"use client";
import React, { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';
import { RefreshCcw, CalendarDays, Loader2, Maximize2, X } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

// High-Contrast Tooltip with White Text and Defined Background
const CustomTooltip = ({ active, payload, label, mode }: any) => {
  if (active && payload && payload.length) {
    const value = payload[0].value;
    return (
      <div className="bg-zinc-950 border border-zinc-700 p-3 rounded-xl shadow-2xl">
        <p className="text-[10px] font-black text-zinc-500 uppercase mb-1">Day {label} (IST)</p>
        <p className={`text-xs font-black ${value >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
          {mode.toUpperCase()}: ₹{value.toFixed(2)}
        </p>
      </div>
    );
  }
  return null;
};

export default function TradeAnalytics() {
  const [rawData, setRawData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'gross' | 'net'>('net');
  const [expandedChart, setExpandedChart] = useState<'equity' | 'daily' | null>(null);

  useEffect(() => {
    const cached = localStorage.getItem('traderEye_analytics');
    if (cached) setRawData(JSON.parse(cached));
  }, []);

  const refreshData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/analytics');
      const data = await res.json();
      if (Array.isArray(data)) {
        setRawData(data);
        localStorage.setItem('traderEye_analytics', JSON.stringify(data));
      }
    } finally { setLoading(false); }
  };

  const stats = useMemo(() => {
    if (!rawData || rawData.length === 0) return { chartData: [], totalGross: 0, totalNet: 0, charges: 0 };
    
    const now = new Date();
    const tradeGroups = new Map();
    
    rawData.forEach(item => {
      if (item.TradeGroupId && !tradeGroups.has(item.TradeGroupId)) {
        tradeGroups.set(item.TradeGroupId, {
          date: item.date,
          gross: parseFloat(item.GrossPnL) || 0,
          net: parseFloat(item.NetPnL) || 0,
          charges: parseFloat(item.TotalCharges) || 0
        });
      }
    });

    const uniqueTrades = Array.from(tradeGroups.values());
    let totalGross = 0, totalNet = 0, charges = 0;
    const dailyMap: Record<string, number> = {};

    uniqueTrades.forEach(trade => {
      const tDate = new Date(trade.date);
      if (tDate.getMonth() === now.getMonth() && tDate.getFullYear() === now.getFullYear()) {
        totalGross += trade.gross;
        totalNet += trade.net;
        charges += trade.charges;
        const val = viewMode === 'gross' ? trade.gross : trade.net;
        dailyMap[trade.date] = (dailyMap[trade.date] || 0) + val;
      }
    });

    const chartData = Object.entries(dailyMap)
      .map(([date, val]) => ({
        date: date.split('-')[2],
        fullDate: date,
        val: Number(val.toFixed(2))
      }))
      .sort((a, b) => a.fullDate.localeCompare(b.fullDate));

    return { chartData, totalGross, totalNet, charges };
  }, [rawData, viewMode]);

  const renderChart = (type: 'equity' | 'daily', isExpanded = false) => {
    const height = isExpanded ? "90%" : 220; // Use numeric height for stable rendering

    return (
      <div className={`flex flex-col w-full h-full`}>
        <div className="flex justify-between items-center mb-4">
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest italic">
            {type === 'equity' ? `Equity Path (${viewMode})` : `Daily Breakdown (${viewMode})`}
          </p>
          {!isExpanded && (
            <button onClick={() => setExpandedChart(type)} className="p-1 hover:bg-zinc-800 rounded transition-colors">
              <Maximize2 size={14} className="text-zinc-600" />
            </button>
          )}
        </div>
        
        {/* Wrapper with explicit height to prevent 0px rendering */}
        <div style={{ width: '100%', height: height }}>
          <ResponsiveContainer width="100%" height="100%">
            {type === 'equity' ? (
              <LineChart data={stats.chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#18181b" vertical={false} />
                <XAxis dataKey="date" stroke="#3f3f46" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis stroke="#3f3f46" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip mode={viewMode} />} cursor={{ stroke: '#52525b', strokeWidth: 1 }} />
                <Line 
                  type="monotone" 
                  dataKey="val" 
                  stroke={viewMode === 'gross' ? '#6366f1' : '#10b981'} 
                  strokeWidth={4} 
                  dot={{ r: 4, fill: '#09090b', strokeWidth: 2 }} 
                  activeDot={{ r: 6, strokeWidth: 0 }} 
                />
              </LineChart>
            ) : (
              <BarChart data={stats.chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#18181b" vertical={false} />
                <XAxis dataKey="date" stroke="#3f3f46" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis stroke="#3f3f46" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip mode={viewMode} />} cursor={{ fill: '#18181b', opacity: 0.4 }} />
                <ReferenceLine y={0} stroke="#3f3f46" />
                <Bar dataKey="val" radius={[4, 4, 0, 0]}>
                  {stats.chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.val >= 0 ? '#10b981' : '#f43f5e'} />
                  ))}
                </Bar>
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Modal Expansion */}
      {expandedChart && (
        <div className="fixed inset-0 z-[100] bg-[#050505]/98 backdrop-blur-2xl p-6 md:p-16 flex flex-col animate-in fade-in zoom-in-95 duration-200">
          <div className="flex justify-end mb-4">
            <button onClick={() => setExpandedChart(null)} className="p-2 bg-zinc-900 rounded-full text-zinc-400 hover:text-white">
              <X size={24} />
            </button>
          </div>
          <div className="flex-1">
            {renderChart(expandedChart, true)}
          </div>
        </div>
      )}

      {/* Analytics Controls */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="bg-zinc-900 p-2 rounded-lg border border-zinc-800"><CalendarDays className="w-5 h-5 text-indigo-500" /></div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-zinc-100">Performance Terminal (IST)</h2>
            <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-tighter">Aggregated unique trade groups</p>
          </div>
        </div>

        <div className="flex items-center gap-4 w-full md:w-auto">
          <div className="flex items-center gap-3 bg-zinc-900 p-2 px-4 rounded-xl border border-zinc-800 grow md:grow-0">
            <span className={`text-[10px] font-black uppercase tracking-tighter ${viewMode === 'gross' ? 'text-indigo-400' : 'text-zinc-700'}`}>Gross</span>
            <Switch checked={viewMode === 'net'} onCheckedChange={(s) => setViewMode(s ? 'net' : 'gross')} />
            <span className={`text-[10px] font-black uppercase tracking-tighter ${viewMode === 'net' ? 'text-emerald-400' : 'text-zinc-700'}`}>Net</span>
          </div>
          <Button variant="outline" size="sm" onClick={refreshData} disabled={loading} className="h-10 border-zinc-800 bg-zinc-900 hover:text-indigo-400 font-bold">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCcw className="w-4 h-4 mr-2" />} REFRESH
          </Button>
        </div>
      </div>

      {/* Analysis Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#0c0c0c] border border-zinc-800/60 p-6 rounded-2xl shadow-xl">
          <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-1 font-bold">Gross Profit</p>
          <p className={`text-2xl font-black ${stats.totalGross >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
            ₹{stats.totalGross.toFixed(2)}
          </p>
        </div>
        <div className="bg-[#0c0c0c] border border-zinc-800/60 p-6 rounded-2xl shadow-xl">
          <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-1 font-bold">Deductions (Taxes)</p>
          {/* Neutral Zinc color as requested */}
          <p className="text-2xl font-black text-zinc-400 italic">
            ₹{stats.charges.toFixed(2)}
          </p>
        </div>
        <div className="bg-zinc-100 border border-zinc-200 p-6 rounded-2xl shadow-2xl">
          <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest mb-1 font-bold">Month Net Realized</p>
          <p className={`text-2xl font-black italic ${stats.totalNet >= 0 ? 'text-black' : 'text-rose-600'}`}>
            ₹{stats.totalNet.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Main Graphs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-[#0c0c0c] border border-zinc-800 p-6 rounded-3xl h-[300px]">
          {renderChart('equity')}
        </div>
        <div className="bg-[#0c0c0c] border border-zinc-800 p-6 rounded-3xl h-[300px]">
          {renderChart('daily')}
        </div>
      </div>
    </div>
  );
}