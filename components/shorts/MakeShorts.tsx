"use client";
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { TradeCharts } from '@/components/journal/TradeCharts';
import { PostStatus, ScheduleEditor } from '@/components/shorts/SchedulePanel';
import { blocksDelete, takenSlots, type PostPlan } from '@/lib/shorts/posts';
import { istLabel, nextSlots } from '@/lib/shorts/slots';

/**
 * "Make a short" on the Socials page. Pick up to 3 shorts in total from either tab (any mix: 3 mystery charts, 2 + 1,
 * the same week twice...), each with its own tell / notes, then Generate them all. Every row opens to the journal's own
 * chart of that trade (entries, adds, exits, stop, target), so an old trade can be recalled before writing its tell.
 * Rendering runs on GitHub Actions; each short shows below when ready. Nothing stops a trade or week being used again.
 */

const MAX_PICKS = 3;

type Kind = 'mystery' | 'vs';
interface Result { value: number; unit: 'R' | '%' }
interface ChartInfo { symbol: string; date: string; dir: 'LONG' | 'SHORT'; securityId?: string; initialStop?: string; lastStop?: string; target?: string; fills: { time: string; side: 'BUY' | 'SELL'; qty: number; price: number }[] }
interface MysteryTrade { id: string; date: string; symbol: string; dir: 'LONG' | 'SHORT'; entryTime: string; holdMin: number; result: Result; chart: ChartInfo }
interface Side { r: number; n: number; uncounted: number }
interface WeekTrade { symbol: string; date: string; dir: string; r?: number; chart: ChartInfo }
type Winner = 'me' | 'algo' | 'tie' | 'none';
interface Week {
  week: string; label: string; me: Side; algo: Side; winner: Winner; meTrade?: WeekTrade; algoTrade?: WeekTrade;
  /** the season ledger: frozen the first time a short uses the week; `drift` = today's data would score it differently */
  frozenAt?: number; rescoredAt?: number; drift?: boolean; now?: { me: Side; algo: Side; winner: Winner };
}
interface SocialText { tell?: string; notes?: { me: string; algo: string }; youtube: { title: string; description: string; tags: string[] }; instagram: { caption: string }; costInr?: number }
interface Short { id: string; kind: Kind; label: string; createdAt: number; status: { state: 'queued' | 'rendering' | 'done' | 'failed'; error?: string }; video?: string; poster?: string; text?: SocialText | { error: string }; post?: PostPlan }

type Pick =
  | { key: number; kind: 'mystery'; trade: MysteryTrade; tell: string; state?: 'sending' | 'sent' | string }
  | { key: number; kind: 'vs'; week: Week; notes: { me: string; algo: string }; state?: 'sending' | 'sent' | string };

const fmt = (r: Result) => `${r.value > 0 ? '+' : ''}${r.value}${r.unit}`;
const fmtR = (x?: number) => (x === undefined ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(1)}R`);
const tone = (x: number) => (x >= 0 ? 'text-data-green' : 'text-data-red-text');
const dateFmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const input = 'mt-1 w-full rounded-lg border border-line-strong bg-brand-bg px-3 py-2 text-sm text-white placeholder:text-ink-4 disabled:opacity-40';

/** The journal's chart for one trade (same component as My Journal). */
function Chart({ c, token }: { c: ChartInfo; token: string }) {
  return (
    <TradeCharts symbol={c.symbol} date={c.date} direction={c.dir} token={token} securityId={c.securityId}
      initialStop={c.initialStop} lastStop={c.lastStop} target={c.target} fills={c.fills} />
  );
}

export default function MakeShorts() {
  const { token } = useAuth();
  const [kind, setKind] = useState<Kind>('mystery');
  const [trades, setTrades] = useState<MysteryTrade[] | null>(null);
  const [cutoff, setCutoff] = useState('');
  const [weeks, setWeeks] = useState<Week[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);        // the expanded row
  const [picks, setPicks] = useState<Pick[]>([]);
  const [chartFor, setChartFor] = useState<number | null>(null); // the pick whose chart is shown in the tray
  const [shorts, setShorts] = useState<Short[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ai, setAi] = useState(true);              // Claude writes the tell / reasons, titles and captions
  const [textOpen, setTextOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);  // the short being scheduled
  const [posting, setPosting] = useState<string | null>(null);  // "Post now" on Instagram
  const [now, setNow] = useState(() => Date.now());

  const loadShorts = useCallback(async () => {
    const r = await fetch('/api/shorts/list', { cache: 'no-store' }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (r?.ok && j?.shorts) { setShorts(j.shorts); setNow(j.now ?? Date.now()); }
  }, []);
  useEffect(() => { void loadShorts(); }, [loadShorts]);
  const working = shorts.some((s) => s.status.state === 'queued' || s.status.state === 'rendering');
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => void loadShorts(), 10_000);
    return () => clearInterval(id);
  }, [working, loadShorts]);

  useEffect(() => {
    setOpen(null); setErr('');
    if (kind === 'mystery' && !trades) {
      fetch('/api/shorts/candidates?kind=mystery', { cache: 'no-store' }).then(async (r) => {
        const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
        setTrades(j.trades); setCutoff(j.cutoff);
      }).catch((e) => setErr((e as Error).message));
    }
    if (kind === 'vs' && !weeks) {
      fetch('/api/shorts/candidates?kind=vs', { cache: 'no-store' }).then(async (r) => {
        const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
        setWeeks(j.weeks);
      }).catch((e) => setErr((e as Error).message));
    }
  }, [kind, trades, weeks]);

  const full = picks.length >= MAX_PICKS;
  const addMystery = (t: MysteryTrade) => !full && setPicks((p) => [...p, { key: Date.now() + Math.random(), kind: 'mystery', trade: t, tell: '' }]);
  const addWeek = (w: Week) => !full && setPicks((p) => [...p, { key: Date.now() + Math.random(), kind: 'vs', week: w, notes: { me: '', algo: '' } }]);
  const update = (key: number, f: (p: Pick) => Pick) => setPicks((ps) => ps.map((p) => (p.key === key ? f(p) : p)));
  const removePick = (key: number) => setPicks((ps) => ps.filter((p) => p.key !== key));

  /** one request per pick, in order; a failed pick stays in the tray with its reason */
  const generate = async () => {
    setBusy(true); setErr('');
    const left: Pick[] = [];
    for (const p of picks) {
      update(p.key, (x) => ({ ...x, state: 'sending' }));
      const body = p.kind === 'mystery' ? { kind: 'mystery', tradeId: p.trade.id, date: p.trade.date, tell: p.tell, ai } : { kind: 'vs', week: p.week.week, notes: p.notes, ai };
      try {
        const r = await fetch('/api/shorts/generate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dhan-token': token ?? '' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) left.push({ ...p, state: j.message ?? `HTTP ${r.status}` });
        else if (j.textError) setErr(`Made, but Claude could not write the text: ${j.textError}`);
      } catch (e) { left.push({ ...p, state: (e as Error).message }); }
    }
    if (picks.some((p) => p.kind === 'vs')) setWeeks(null); // a Me vs Algo short freezes weeks: show them frozen
    setPicks(left); setChartFor(null); setBusy(false);
    if (left.length) setErr(`${left.length} of them could not start; the reason is on each.`);
    void loadShorts();
  };

  /** a deliberate correction: the week is scored again from today's data (the old result stays in its history) */
  const rescoreWeek = async (w: Week) => {
    if (!window.confirm(`Re-score ${w.label} from today's data? Shorts made from now on will show the corrected season; videos already posted keep the old score.`)) return;
    const r = await fetch('/api/shorts/season', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ week: w.week }) }).catch(() => null);
    const j = await r?.json().catch(() => ({}));
    if (!r?.ok) { setErr(j?.message ?? 'Could not re-score that week.'); return; }
    setWeeks(null); // reload with the new result
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this short?')) return;
    const r = await fetch('/api/shorts/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => null);
    const j = await r?.json().catch(() => ({}));
    if (!r?.ok) setErr(j?.message ?? 'Could not delete it.');
    void loadShorts();
  };

  /** Instagram right now (also the retry after a failure) */
  const postNow = async (id: string) => {
    if (!window.confirm('Publish this Reel on Instagram now?')) return;
    setPosting(id);
    const r = await fetch('/api/shorts/post-now', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => null);
    const j = await r?.json().catch(() => ({}));
    if (!r?.ok) setErr(j?.message ?? 'Could not post it.');
    setPosting(null); void loadShorts();
  };

  // default slots for shorts not scheduled yet: the next free Mon / Wed / Fri 18:30 IST, oldest short first
  const waiting = shorts.filter((s) => s.status.state === 'done' && !s.post).sort((a, b) => a.createdAt - b.createdAt);
  const slots = nextSlots(waiting.length, now, takenSlots(Object.fromEntries(shorts.filter((s) => s.post).map((s) => [s.id, s.post!])), now));
  const defaultAt = new Map(waiting.map((s, i) => [s.id, slots[i]]));
  const editingShort = shorts.find((s) => s.id === editing);

  const tab = (k: Kind, label: string) => (
    <button onClick={() => setKind(k)} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${kind === k ? 'bg-brand-accent text-brand-bg' : 'text-ink-3 hover:text-white'}`}>{label}</button>
  );
  const addBtn = (onClick: () => void) => (
    <button onClick={onClick} disabled={full}
      className="inline-flex h-8 items-center gap-1 rounded-full border border-line-strong px-3 text-xs font-semibold text-ink-2 hover:border-brand-accent hover:text-white disabled:opacity-30">
      <Plus className="size-3.5" />Add
    </button>
  );
  const chevron = (id: string) => (
    <button onClick={() => setOpen(open === id ? null : id)} aria-label={open === id ? 'Hide chart' : 'Show chart'} className="text-ink-3 hover:text-white">
      {open === id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
    </button>
  );

  return (
    <section className="mt-4">
      <h2 className="text-xl font-semibold text-white">Make shorts</h2>
      <p className="mt-1 text-sm text-ink-3">Pick up to {MAX_PICKS} in total from either tab. Open a row to see the trade on its chart. Rendering takes a few minutes on GitHub; each short shows below when ready.</p>

      <div className="mt-4 rounded-2xl border border-line-strong bg-brand-card p-4">
        <div className="mb-4 inline-flex gap-1 rounded-full border border-line-strong p-1">
          {tab('mystery', 'Mystery chart')}{tab('vs', 'Me vs Algo')}
        </div>

        {kind === 'mystery' && (
          <>
            <p className="mb-2 text-xs text-ink-3">Trades from {cutoff ? dateFmt(cutoff) : '…'} or earlier: the ticker is revealed at the end, so only trades over 3 months old (SEBI).</p>
            {!trades ? <Loader2 className="size-5 animate-spin text-ink-3" /> : !trades.length ? <p className="text-sm text-ink-3">No trades that old yet.</p> : (
              <div className="max-h-[32rem] overflow-y-auto rounded-xl border border-line">
                {trades.map((t) => (
                  <div key={t.id} className="border-b border-line last:border-0">
                    <div className={`flex items-center gap-3 px-3 py-2 text-sm ${open === t.id ? 'bg-white/5' : ''}`}>
                      {chevron(t.id)}
                      <span className="w-24 text-ink-3">{dateFmt(t.date)}</span>
                      <span className="w-28 font-semibold text-white">{t.symbol}</span>
                      <span className={`w-14 text-xs font-bold ${t.dir === 'LONG' ? 'text-data-green' : 'text-data-red-text'}`}>{t.dir}</span>
                      <span className="hidden w-14 text-ink-3 sm:inline">{t.entryTime}</span>
                      <span className="hidden w-16 text-ink-3 sm:inline">{t.holdMin} min</span>
                      <span className={`ml-auto w-16 text-right font-semibold ${tone(t.result.value)}`}>{fmt(t.result)}</span>
                      {addBtn(() => addMystery(t))}
                    </div>
                    {open === t.id && <div className="bg-zinc-950/30 px-1 pb-3"><Chart c={t.chart} token={token} /></div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {kind === 'vs' && (
          !weeks ? <Loader2 className="size-5 animate-spin text-ink-3" /> : !weeks.length ? <p className="text-sm text-ink-3">No finished week since Algo Live started yet.</p> : (
            <>
            <p className="mb-2 text-xs text-ink-3">
              Season ledger: a week&apos;s result is frozen the first time a short uses it (with every earlier week), so the score in the videos never changes on its own.
              {' '}Season so far: <b className="text-white">Me {weeks.filter((w) => w.frozenAt && w.winner === 'me').length} – {weeks.filter((w) => w.frozenAt && w.winner === 'algo').length} Algo</b> (frozen weeks).
            </p>
            <div className="rounded-xl border border-line">
              {weeks.map((w) => (
                <div key={w.week} className="border-b border-line last:border-0">
                  <div className={`flex flex-wrap items-center gap-3 px-3 py-2 text-sm ${open === w.week ? 'bg-white/5' : ''}`}>
                    {chevron(w.week)}
                    <span className="w-36 font-semibold text-white">{w.label}</span>
                    <span>Me <b className={tone(w.me.r)}>{fmtR(w.me.r)}</b> <span className="text-ink-4">({w.me.n})</span></span>
                    <span>Algo <b className={tone(w.algo.r)}>{fmtR(w.algo.r)}</b> <span className="text-ink-4">({w.algo.n})</span></span>
                    <span className="ml-auto text-xs font-bold uppercase text-brand-accent">{w.winner === 'none' ? 'no trades' : w.winner === 'tie' ? 'tie' : `${w.winner} wins`}</span>
                    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase ${w.frozenAt ? 'border-brand-accent/50 text-brand-accent' : 'border-line-strong text-ink-4'}`}
                      title={w.frozenAt ? 'Locked: later shorts always show this result' : 'Freezes when its first short is made'}>
                      {w.frozenAt ? `${w.rescoredAt ? 'Re-scored' : 'Frozen'} ${new Date(w.rescoredAt ?? w.frozenAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}` : 'Not frozen'}
                    </span>
                    {addBtn(() => addWeek(w))}
                  </div>
                  {w.drift && w.now && (
                    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-data-caution">
                      <span>The journal changed since this week was frozen. Scored today: me {fmtR(w.now.me.r)} ({w.now.me.n}), algo {fmtR(w.now.algo.r)} ({w.now.algo.n}), {w.now.winner === 'none' ? 'no trades' : w.now.winner === 'tie' ? 'tie' : `${w.now.winner} wins`}.</span>
                      <button onClick={() => rescoreWeek(w)} className="rounded-full border border-data-caution/60 px-2.5 py-0.5 font-semibold hover:bg-white/5">Re-score week</button>
                    </div>
                  )}
                  {open === w.week && (
                    <div className="space-y-3 bg-zinc-950/30 px-1 pb-3">
                      {(['me', 'algo'] as const).map((side) => {
                        const t = side === 'me' ? w.meTrade : w.algoTrade;
                        return (
                          <div key={side}>
                            <p className="px-2 pt-2 text-xs text-ink-3">{side === 'me' ? 'Your' : 'Algo’s'} trade of the week: <b className="text-white">{t ? `${t.symbol} · ${dateFmt(t.date)} · ${fmtR(t.r)}` : 'none'}</b></p>
                            {t && <Chart c={t.chart} token={token} />}
                          </div>
                        );
                      })}
                      {(w.me.uncounted > 0 || w.algo.uncounted > 0) && <p className="px-2 text-xs text-ink-4">Trades without a logged stop aren&apos;t scored (me {w.me.uncounted}, algo {w.algo.uncounted}).</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            </>
          )
        )}

        {/* the tray: up to 3 picks, each with its own tell / notes */}
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-sm font-semibold text-white">Selected {picks.length} / {MAX_PICKS}</p>
          {!picks.length && <p className="mt-1 text-xs text-ink-4">Use Add on any row. The same trade or week can be added again.</p>}
          <div className="mt-2 space-y-3">
            {picks.map((p, i) => (
              <div key={p.key} className="rounded-xl border border-line p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="flex size-6 items-center justify-center rounded-full bg-brand-accent text-xs font-black text-brand-bg">{i + 1}</span>
                  <span className="font-semibold text-white">
                    {p.kind === 'mystery' ? `Mystery: ${p.trade.symbol} · ${dateFmt(p.trade.date)} · ${fmt(p.trade.result)}` : `Me vs Algo · ${p.week.label}`}
                  </span>
                  {p.kind === 'mystery' && (
                    <button onClick={() => setChartFor(chartFor === p.key ? null : p.key)} className="text-xs text-brand-accent hover:underline">{chartFor === p.key ? 'Hide chart' : 'Chart'}</button>
                  )}
                  <button onClick={() => removePick(p.key)} disabled={busy} aria-label="Remove" className="ml-auto text-ink-4 hover:text-data-red-text disabled:opacity-30"><X className="size-4" /></button>
                </div>
                {p.state && p.state !== 'sending' && p.state !== 'sent' && <p className="mt-1 text-xs text-data-red-text">{p.state}</p>}
                {p.kind === 'mystery' ? (
                  <>
                    {chartFor === p.key && <div className="mt-2"><Chart c={p.trade.chart} token={token} /></div>}
                    <label className="mt-2 block text-xs text-ink-3">
                      {p.trade.result.value < 0
                        ? 'What I missed: the warning sign on the 10-min chart, shown at the end'
                        : 'The tell: what gave the trade away on the 10-min chart, shown at the end'}{ai ? ' (leave empty and Claude writes it)' : ' (optional)'}
                      <input value={p.tell} disabled={busy} onChange={(e) => { const v = e.target.value.slice(0, 90); update(p.key, (x) => ({ ...x, tell: v } as Pick)); }}
                        placeholder={p.trade.result.value < 0 ? 'e.g. The 09:45 candle made a lower high' : 'e.g. The 09:45 pullback held above the 09:35 low'} className={input} />
                    </label>
                  </>
                ) : (
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    {(['me', 'algo'] as const).map((side) => {
                      const t = side === 'me' ? p.week.meTrade : p.week.algoTrade;
                      return (
                        <label key={side} className="block text-xs text-ink-3">
                          {side === 'me' ? 'Your' : 'Algo’s'} one-line reason{t ? (ai ? ' (empty: Claude writes it)' : ' (optional)') : ': no trade'}
                          <input value={p.notes[side]} disabled={busy || !t} placeholder={t ? `${t.symbol} ${fmtR(t.r)}` : ''}
                            onChange={(e) => { const v = e.target.value.slice(0, 40); update(p.key, (x) => (x.kind === 'vs' ? { ...x, notes: { ...x.notes, [side]: v } } : x)); }} className={input} />
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={ai} disabled={busy} onChange={(e) => setAi(e.target.checked)} className="accent-[var(--color-brand-accent)]" />
            Claude writes the tell, YouTube title, description, tags and Instagram caption (one call per short, about ₹1–2)
          </label>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={generate} disabled={!picks.length || busy}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-brand-accent px-5 text-sm font-semibold text-brand-bg hover:bg-brand-accent-hover disabled:opacity-40">
              {busy && <Loader2 className="size-4 animate-spin" />}Generate {picks.length || ''} {picks.length === 1 ? 'short' : 'shorts'}
            </button>
            {err && <span className="text-sm text-data-red-text">{err}</span>}
          </div>
        </div>
      </div>

      {shorts.length > 0 && (
        <div id="shorts-grid" className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {editingShort && (
            <ScheduleEditor key={editingShort.id} id={editingShort.id} label={editingShort.label} poster={editingShort.poster}
              text={editingShort.text && 'youtube' in editingShort.text ? editingShort.text : undefined}
              post={editingShort.post} defaultAt={defaultAt.get(editingShort.id)} now={now}
              onClose={() => setEditing(null)} onSaved={() => void loadShorts()} />
          )}
          {shorts.map((s) => (
            <div key={s.id} className="overflow-hidden rounded-2xl border border-line-strong bg-brand-card">
              <div className="flex aspect-[9/16] items-center justify-center bg-black">
                {s.status.state === 'done' && s.video
                  ? <video src={s.video} poster={s.poster} controls playsInline preload="none" className="size-full object-contain" />
                  : s.status.state === 'failed'
                    ? <p className="px-3 text-center text-xs text-data-red-text">{s.status.error ?? 'Render failed.'}</p>
                    : <span className="flex items-center gap-2 text-xs text-ink-3"><Loader2 className="size-4 animate-spin" />{s.status.state === 'queued' ? 'Waiting for GitHub' : 'Rendering'}</span>}
              </div>
              <div className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs leading-5 text-ink-2">{s.label}</p>
                  <button onClick={() => remove(s.id)} disabled={blocksDelete(s.post, now)} aria-label="Delete" title={blocksDelete(s.post, now) ? 'Unschedule it first' : 'Delete'}
                    className="text-ink-4 hover:text-data-red-text disabled:opacity-30"><Trash2 className="size-4" /></button>
                </div>
                {s.text && 'error' in s.text && <p className="mt-1 text-[11px] text-data-red-text">No text: {s.text.error}</p>}
                {s.text && 'youtube' in s.text && (
                  <>
                    <p className="mt-1 text-xs font-semibold text-white">{s.text.youtube.title}</p>
                    <button onClick={() => setTextOpen(textOpen === s.id ? null : s.id)} className="mt-1 text-[11px] text-brand-accent hover:underline">{textOpen === s.id ? 'Hide text' : 'Show text'}</button>
                    {textOpen === s.id && (
                      <div className="mt-2 space-y-2 text-[11px] leading-4 text-ink-2">
                        {s.text.tell && <p><b className="text-ink-3">Tell:</b> {s.text.tell}</p>}
                        {s.text.notes && (s.text.notes.me || s.text.notes.algo) && <p><b className="text-ink-3">Reasons:</b> me &ldquo;{s.text.notes.me}&rdquo; · algo &ldquo;{s.text.notes.algo}&rdquo;</p>}
                        <p className="whitespace-pre-line"><b className="text-ink-3">YouTube description:</b>{'\n'}{s.text.youtube.description}</p>
                        <p><b className="text-ink-3">Tags:</b> {s.text.youtube.tags.join(', ')}</p>
                        <p className="whitespace-pre-line"><b className="text-ink-3">Instagram caption:</b>{'\n'}{s.text.instagram.caption}</p>
                      </div>
                    )}
                  </>
                )}
                <PostStatus post={s.post} now={now} busy={posting === s.id} onPostNow={() => postNow(s.id)} />
                {s.status.state === 'done' && (
                  <button onClick={() => { setEditing(s.id); document.getElementById('shorts-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                    className="mt-2 inline-flex h-8 items-center rounded-full border border-brand-accent/70 px-3 text-xs font-semibold text-brand-accent hover:bg-brand-accent hover:text-brand-bg">
                    {s.post ? 'Edit schedule' : `Schedule${defaultAt.get(s.id) ? ` · ${istLabel(defaultAt.get(s.id)!)}` : ''}`}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
