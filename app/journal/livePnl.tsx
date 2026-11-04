import React, { useMemo, useRef, useState } from 'react';
import { Camera, Loader2, Maximize2, RefreshCcw, TrendingDown, TrendingUp, Upload } from 'lucide-react';
import { ModePills, PnlCurveChart, useDayCurve } from '@/components/journal/PnlCurve';
import { positionsFromRows, type CurveMode, type JournalRow } from '@/lib/pnlCurve/curve';
import { inr } from '@/lib/pnlCurve/draw';
import { UploadFolderKey } from './page';

interface LivePnlProps {
    todayPnl: number;
    selectedDate: string;
    rows: JournalRow[];
    token: string;
    handleScreenshotUpload: (groupId: string, file: File, trade: any, key: UploadFolderKey) => Promise<void>;
    dailyScreenshotUrl?: string;
    uploadStatus?: string;
    onFullScreen: (url: string) => void;
    sheetTitle?: string;
}

/**
 * The day's P&L curve, drawn from the fills and saved candles (no screenshot needed), the same way as the trade charts:
 * saved in S3 after the first time. A picture uploaded by hand stays available from a button; when the curve cannot be
 * drawn (a day without fill times, or candles not saved and no Dhan login) the picture is shown, or the upload offered.
 */
export default function LivePnl({ todayPnl, selectedDate, rows, token, handleScreenshotUpload, dailyScreenshotUrl, uploadStatus, onFullScreen, sheetTitle }: LivePnlProps) {
    const [mode, setMode] = useState<CurveMode>('net');
    const fileInput = useRef<HTMLInputElement>(null);
    const rowsKey = JSON.stringify(rows);
    const { positions, undrawable } = useMemo(() => positionsFromRows(selectedDate, JSON.parse(rowsKey)), [selectedDate, rowsKey]);
    const canDraw = positions.length > 0 && undrawable.length === 0;
    const { answer, err, code, busy, reload } = useDayCurve(selectedDate, positions, token, canDraw);
    const curve = answer?.curve;
    const shown = curve ? curve.overall[mode].at(-1) ?? 0 : todayPnl;
    const uploading = uploadStatus === 'uploading';
    const pick = () => fileInput.current?.click();
    const pill = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] font-bold transition-colors disabled:opacity-60';

    return (
        <div key={selectedDate} className="bg-brand-card border border-zinc-800 rounded-[32px] overflow-hidden shadow-2xl flex flex-col">
            <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleScreenshotUpload(`daily-${selectedDate}`, file, { sheetTitle, date: selectedDate }, 'live-pnl');
                e.target.value = '';
            }} />
            <div className="p-6 flex flex-wrap items-center justify-between gap-4 bg-zinc-900/20 border-b border-zinc-800/40">
                <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${shown >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                        {shown >= 0 ? <TrendingUp size={24} /> : <TrendingDown size={24} />}
                    </div>
                    <div>
                        <h3 className="text-xl font-black tracking-tight text-white">P&amp;L Curve</h3>
                        <p className="mt-1 text-[11px] text-zinc-500">
                            {answer?.live ? 'Today · live, saved after the close' : curve ? (answer?.fromS3 ? 'From S3' : answer?.saved ? 'Worked out from candles, saved to S3' : 'Worked out from candles') : 'One point a minute'}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    {curve && <ModePills mode={mode} onChange={setMode} />}
                    <p className={`text-3xl font-black ${shown >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>{inr(shown)}</p>
                </div>
            </div>

            <div className="px-6 py-6 bg-zinc-950/30 space-y-3">
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {curve && (
                        <span className="mr-auto text-[11px] text-zinc-500">
                            Gross <span className="font-mono text-zinc-300">{inr(curve.overall.gross.at(-1) ?? 0)}</span> · Charges <span className="font-mono text-zinc-300">₹{Math.round(curve.charges).toLocaleString('en-IN')}</span> · Net <span className="font-mono text-zinc-300">{inr(curve.overall.net.at(-1) ?? 0)}</span>
                        </span>
                    )}
                    {curve && dailyScreenshotUrl && (
                        <button onClick={() => onFullScreen(dailyScreenshotUrl)} className={`${pill} border-brand-accent/60 text-brand-accent hover:bg-brand-accent/10`}><Camera className="h-3.5 w-3.5" />Uploaded chart</button>
                    )}
                    {!curve && dailyScreenshotUrl && (
                        <button onClick={() => onFullScreen(dailyScreenshotUrl)} className={`${pill} border-zinc-800 text-zinc-400 hover:text-white`}><Maximize2 className="h-3.5 w-3.5" />Full screen</button>
                    )}
                    <button onClick={pick} disabled={uploading} className={`${pill} border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-white`}>
                        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {uploading ? 'Uploading…' : dailyScreenshotUrl ? 'Replace' : 'Upload chart'}
                    </button>
                </div>

                {curve ? <PnlCurveChart curve={curve} mode={mode} />
                    : busy ? <div className="flex h-40 items-center justify-center gap-2 text-xs text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Working out the curve…</div>
                    : dailyScreenshotUrl ? <img src={dailyScreenshotUrl} alt="P&L chart" className="w-full rounded-[24px] object-contain bg-black/40 cursor-pointer" onClick={() => onFullScreen(dailyScreenshotUrl)} />
                    : canDraw && err ? (
                        <div className="flex items-center gap-3 text-xs text-zinc-400">
                            {code === 'NEEDS_DHAN' ? <span>{err} <a href="/dhan-login" className="font-bold text-brand-accent underline">Dhan login</a>, or upload a chart.</span> : <span className="text-data-red-text">Could not work out the curve: {err}</span>}
                            <button onClick={() => void reload()} className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 hover:text-white"><RefreshCcw className="h-3 w-3" />Retry</button>
                        </div>
                    )
                    : <p className="py-8 text-center text-xs text-zinc-600">{undrawable.length ? 'These fills have no usable times, so no curve can be drawn. Upload a chart instead.' : 'No trades on this day.'}</p>}
            </div>
        </div>
    );
}
