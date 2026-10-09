import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Upload, Maximize2, Download, TrendingUp, TrendingDown } from "lucide-react";

const formatCurrency = (num: number) => {
    const absNum = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (absNum >= 100000) return `${sign}₹${(absNum / 100000).toFixed(1)}L`;
    if (absNum >= 1000) return `${sign}₹${(absNum / 1000).toFixed(1)}K`;
    return `${sign}₹${absNum.toFixed(0)}`;
};

interface LivePnlProps {
    todayPnl: number;
    selectedDate: string;
    handleScreenshotUpload: (groupId: string, file: File, trade: any, key: string) => Promise<void>;
    dailyScreenshotUrl?: string;
    uploadStatus?: string;
    onFullScreen: (url: string) => void;
    sheetTitle?: string;
}

export default function LivePnl({
    todayPnl,
    selectedDate,
    handleScreenshotUpload,
    dailyScreenshotUrl,
    uploadStatus,
    onFullScreen,
    sheetTitle
}: LivePnlProps) {
    const [downloading, setDownloading] = useState(false);

    const handleDownload = async (url: string) => {
        try {
            setDownloading(true);
            const response = await fetch(url);
            const blob = await response.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = `Live_PnL_${selectedDate}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(blobUrl);
        } catch (err) {
            console.error('Download failed', err);
        } finally {
            setDownloading(false);
        }
    };

    return (
        <div key={selectedDate} className="bg-[#0c0c0c] border border-zinc-800 rounded-[32px] overflow-hidden shadow-2xl flex flex-col">
            {/* CARD HEADER */}
            <div className="p-6 flex items-center justify-between bg-zinc-900/20 border-b border-zinc-800/40">
                <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${todayPnl >= 0 ? 'bg-emerald-500/10 text-emerald-400 shadow-[inset_0_0_20px_rgba(16,185,129,0.05)]' : 'bg-rose-500/10 text-rose-400 shadow-[inset_0_0_20px_rgba(244,63,94,0.05)]'}`}>
                        {todayPnl >= 0 ? <TrendingUp size={24} /> : <TrendingDown size={24} />}
                    </div>
                    <div>
                        <h3 className="text-xl font-black tracking-tight text-white">Live PnL Chart</h3>
                        <div className="flex items-center gap-2 mt-1">
                            <Badge className={`${todayPnl >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'} border-none text-[9px] px-2 h-5 font-black`}>
                                {todayPnl >= 0 ? 'PROFIT' : 'LOSS'}
                            </Badge>
                        </div>
                    </div>
                </div>
                <p className={`text-3xl font-black ${todayPnl >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                    {formatCurrency(todayPnl)}
                </p>
            </div>

            {/* SCREENSHOT SECTION */}
            <div className="px-6 py-6 bg-zinc-950/30">
                <div className="relative group w-full min-h-[260px] md:min-h-[450px] rounded-[24px] overflow-hidden border border-zinc-800/80 bg-zinc-900/20 shadow-inner">
                    {dailyScreenshotUrl ? (
                        <>
                            <img
                                src={dailyScreenshotUrl}
                                alt="Live PnL Chart"
                                className="w-full h-auto min-h-[260px] object-contain bg-black/40 cursor-pointer"
                                onClick={() => onFullScreen(dailyScreenshotUrl)}
                            />
                            <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Button
                                    size="icon"
                                    className="bg-black/80 hover:bg-cyan-600 rounded-full h-10 w-10 backdrop-blur-md border border-white/10"
                                    onClick={() => handleDownload(dailyScreenshotUrl)}
                                    disabled={downloading}
                                >
                                    <Download size={18} />
                                </Button>
                                <Button
                                    size="icon"
                                    className="bg-black/80 hover:bg-cyan-600 rounded-full h-10 w-10 backdrop-blur-md border border-white/10"
                                    onClick={() => onFullScreen(dailyScreenshotUrl)}
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
                                    if (file) {
                                        // Pass dummy/placeholder identifiers for the daily live-pnl upload
                                        handleScreenshotUpload(
                                            `daily-${selectedDate}`,
                                            file,
                                            { sheetTitle, date: selectedDate },
                                            'live-pnl'
                                        );
                                    }
                                }}
                                className="hidden"
                                id={`screenshot-live-pnl-${selectedDate}`}
                            />
                            <label htmlFor={`screenshot-live-pnl-${selectedDate}`} className="w-full h-full cursor-pointer flex flex-col items-center justify-center gap-4">
                                <div className="w-16 h-16 rounded-full bg-zinc-800/50 flex items-center justify-center border border-zinc-700/50">
                                    {uploadStatus === 'uploading' ? (
                                        <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
                                    ) : (
                                        <Upload className="w-8 h-8 text-zinc-600" />
                                    )}
                                </div>
                                <div className="text-center">
                                    <span className="text-[10px] font-black text-zinc-500 block uppercase tracking-[0.2em] mb-1">
                                        {uploadStatus === 'uploading' ? 'Syncing to Cloud' : 'Upload Daily PnL Chart'}
                                    </span>
                                    <span className="text-[9px] text-zinc-700 block">PNG, JPG up to 10MB</span>
                                </div>
                            </label>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}