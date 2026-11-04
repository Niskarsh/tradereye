"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Copy, Download, ExternalLink, Loader2, RefreshCcw, Sparkles } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { TradeCharts } from '@/components/journal/TradeCharts';
import { ModePills, useDayCurve } from '@/components/journal/PnlCurve';
import { positionCards, finalOf } from '@/lib/pnlCurve/card';
import { positionsFromRows, type CurveMode, type JournalRow } from '@/lib/pnlCurve/curve';
import { hhmm, inr } from '@/lib/pnlCurve/draw';
import { CHART_CSS_H, CHART_CSS_W, STORY_H, cardSlide, chartSlide, curveSlide, niceDate, storyFrame, toJpeg } from '@/lib/pnlCurve/slides';
import type { PostsState } from '@/lib/posts/publish';

/**
 * Socials -> Posts: today's P&L post, today only. Everything is drawn from real data: slide 1 the curve, slide 2 the
 * positions, then one journal 10-minute chart per stock. Instagram goes out from here; YouTube's API cannot create
 * channel posts, so that side hands over the images and the text.
 */

const IST = 19800_000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const CHANNEL_POSTS = 'https://www.youtube.com/@CandlesBeforeCubicles/posts';
const MAX_CHARTS = 8; // Instagram allows 10 images in a post

interface Slide { name: string; label: string; canvas: HTMLCanvasElement; url: string }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default function PostsTab() {
  const { token } = useAuth();
  const today = useMemo(() => new Date(Date.now() + IST).toISOString().slice(0, 10), []);
  const [rows, setRows] = useState<JournalRow[] | null>(null);
  const [rowsErr, setRowsErr] = useState('');
  const [mode, setMode] = useState<CurveMode>('net');
  const [charts, setCharts] = useState<Record<string, HTMLCanvasElement | { error: string }>>({});
  const [caption, setCaption] = useState('');
  const [ytText, setYtText] = useState('');
  const [edited, setEdited] = useState(false);
  const [writing, setWriting] = useState(false);
  const [stories, setStories] = useState<Record<string, boolean>>({ curve: true });
  const [state, setState] = useState<PostsState>({ stories: [] });
  const [sending, setSending] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadRows = useCallback(async () => {
    setRowsErr('');
    const sheet = `${MONTHS[Number(today.slice(5, 7)) - 1]}-${today.slice(0, 4)}`;
    try {
      const r = await fetch(`/api/analytics?start=${sheet}&end=${sheet}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setRows(((j.data?.[sheet] ?? []) as JournalRow[]).filter((x) => x.date === today));
    } catch (e) { setRows([]); setRowsErr((e as Error).message); }
  }, [today]);
  useEffect(() => {
    void loadRows();
    fetch('/api/posts/publish', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) setState(j); }).catch(() => {});
  }, [loadRows]);

  const rowsKey = JSON.stringify(rows ?? []);
  const { positions: journal, undrawable } = useMemo(() => positionsFromRows(today, JSON.parse(rowsKey)), [today, rowsKey]);
  const { answer, err, code, busy, reload } = useDayCurve(today, journal, token, rows !== null);
  const curve = answer?.curve;
  const positions = useMemo(() => (answer?.positions ?? []).slice(0, MAX_CHARTS), [answer]);
  const cards = useMemo(() => (curve && answer ? positionCards(today, answer.positions, curve) : []), [curve, answer, today]);
  const chartsReady = positions.every((p) => charts[p.symbol]);

  const slides: Slide[] = useMemo(() => {
    if (!curve || typeof document === 'undefined') return [];
    const make = (name: string, label: string, canvas: HTMLCanvasElement): Slide => ({ name, label, canvas, url: toJpeg(canvas) });
    const out = [make('curve', 'P&L curve', curveSlide(curve, mode)), make('positions', 'Positions', cardSlide(cards, curve, mode))];
    for (const c of cards.slice(0, MAX_CHARTS)) {
      const chart = charts[c.symbol];
      if (chart instanceof HTMLCanvasElement) out.push(make(`chart-${slug(c.symbol)}`, `${c.symbol} chart`, chartSlide(chart, c, today, mode)));
    }
    return out;
  }, [curve, cards, charts, mode, today]);

  // a plain first draft, so nothing needs Claude; replaced by Claude's only when the button is pressed
  const draft = useMemo(() => {
    if (!curve) return '';
    const end = finalOf(curve, mode);
    const lines = cards.map((c) => `${c.symbol} ${c.direction.toLowerCase()} ${c.qty}: ${inr(mode === 'net' ? c.net : c.gross)}`);
    return [`${niceDate(today)}: ${inr(end)} ${mode === 'net' ? 'after charges' : 'before charges'}.`, '', ...lines, '', 'Every day logged, green or red.'].join('\n');
  }, [curve, cards, mode, today]);
  useEffect(() => { if (!edited) { setCaption(draft); setYtText(draft); } }, [draft, edited]);

  const facts = () => curve && {
    date: today, basis: mode, resultInr: Math.round(finalOf(curve, mode)), grossInr: Math.round(finalOf(curve, 'gross')), netInr: Math.round(finalOf(curve, 'net')), chargesInr: Math.round(curve.charges),
    positions: cards.map((c) => ({ symbol: c.symbol, side: c.direction, qty: c.qty, stillOpen: c.openQty, avgBuy: c.avgBuy, avgSell: c.avgSell, netInr: Math.round(c.net), grossInr: Math.round(c.gross), orders: c.orders.map((o) => `${hhmm(o.t)} ${o.side} ${o.qty} @ ${o.price}`), slippage: c.slippage })),
    peakInr: Math.round(Math.max(...curve.overall[mode])), lowestInr: Math.round(Math.min(...curve.overall[mode])),
    comments: [...new Set((rows ?? []).map((r) => String((r as { Comment?: string }).Comment ?? '').trim()).filter(Boolean))],
  };

  const write = async () => {
    setWriting(true); setMsg(null);
    try {
      const r = await fetch('/api/posts/caption', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ facts: facts() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setCaption(j.instagram); setYtText(j.youtube); setEdited(true);
      setMsg({ ok: true, text: `Written by Claude (about ₹${Number(j.costInr ?? 0).toFixed(2)}). Edit anything before posting.` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setWriting(false); }
  };

  const upload = async (name: string, url: string) => {
    const r = await fetch('/api/posts/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: today, name, image: url }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
  };
  const publish = async (body: Record<string, unknown>) => {
    const r = await fetch('/api/posts/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: today, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
    setState(j as PostsState);
  };

  const sendPost = async () => {
    if (state.post && !window.confirm('Today\'s post is already on Instagram. Post it again?')) return;
    setSending('post'); setMsg(null);
    try {
      for (const s of slides) await upload(s.name, s.url);
      await publish({ kind: 'post', slides: slides.map((s) => s.name), caption, again: !!state.post });
      setMsg({ ok: true, text: 'Posted on Instagram.' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setSending(''); }
  };
  const sendStories = async () => {
    const chosen = slides.filter((s) => stories[s.name]);
    if (!chosen.length) { setMsg({ ok: false, text: 'Tick at least one image for the Story.' }); return; }
    const names = chosen.map((s) => `story-${s.name}`);
    const repeat = names.some((n) => state.stories.some((x) => x.slides[0] === n));
    if (repeat && !window.confirm('Some of these Stories are already up today. Post them again?')) return;
    setSending('story'); setMsg(null);
    try {
      for (const s of chosen) {
        const frame = s.name === 'curve' && curve ? curveSlide(curve, mode, STORY_H) : storyFrame(s.canvas);
        await upload(`story-${s.name}`, toJpeg(frame));
        await publish({ kind: 'story', slide: `story-${s.name}`, again: repeat });
      }
      setMsg({ ok: true, text: chosen.length > 1 ? `${chosen.length} Stories posted.` : 'Story posted.' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setSending(''); }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(ytText);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  const refresh = () => { setEdited(false); setCharts({}); void loadRows(); void reload(); };

  const btn = 'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50';
  const primary = `${btn} bg-brand-accent text-brand-bg`;
  const quiet = `${btn} border border-line-strong text-ink-3 hover:text-white`;
  const area = 'w-full rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-sm text-zinc-200 outline-none focus:border-brand-accent/60';

  if (rows === null || (busy && !curve)) return <p className="mt-6 flex items-center gap-2 text-sm text-ink-3"><Loader2 className="size-4 animate-spin" />Reading today&apos;s trades…</p>;
  if (!curve) {
    return (
      <div className="mt-6 space-y-3 rounded-2xl border border-zinc-800 p-6 text-sm text-ink-3">
        <h2 className="text-lg font-semibold text-white">Today · {niceDate(today)}</h2>
        {rowsErr && <p className="text-data-red-text">{rowsErr}</p>}
        {undrawable.length > 0 && <p>These fills have no usable times: {undrawable.join(', ')}.</p>}
        {code === 'NO_TRADES' ? <p>No trades today, so there is nothing to post.{!token && <> A position still running needs a <a href="/dhan-login" className="font-bold text-brand-accent underline">Dhan login</a> to show up here.</>}</p>
          : code === 'NEEDS_DHAN' ? <p>{err} <a href="/dhan-login" className="font-bold text-brand-accent underline">Dhan login</a></p>
          : err && <p className="text-data-red-text">{err}</p>}
        <button onClick={refresh} className={quiet}><RefreshCcw className="size-4" />Refresh</button>
      </div>
    );
  }

  const open = curve.positions.some((p) => p.openQty !== 0);
  const failed = positions.filter((p) => { const c = charts[p.symbol]; return c && !(c instanceof HTMLCanvasElement); });
  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-white">Today · {niceDate(today)}</h2>
        <ModePills mode={mode} onChange={setMode} />
        <button onClick={refresh} className={`${quiet} ml-auto`}><RefreshCcw className="size-4" />Refresh</button>
      </div>
      {open && <p className="rounded-xl border border-data-caution/50 px-4 py-3 text-sm text-data-caution">A position is still open, so these numbers are as of {hhmm(curve.times[curve.times.length - 1])} and will change.</p>}
      {failed.map((p) => <p key={p.symbol} className="text-sm text-data-red-text">{p.symbol} chart left out: {(charts[p.symbol] as { error: string }).error}</p>)}

      {/* the journal's own chart, drawn off screen at a fixed size and copied into the post */}
      <div aria-hidden className="pointer-events-none fixed top-0" style={{ left: -10000 }}>
        {positions.map((p) => (
          <TradeCharts key={p.symbol} eager symbol={p.symbol} date={today} direction={p.direction ?? ''} token={token} securityId={p.securityId}
            initialStop={p.initialStop ? String(p.initialStop) : undefined} stopDist={p.stopDist ? String(p.stopDist) : undefined} lastStop={p.lastStop ? String(p.lastStop) : undefined} target={p.target ? String(p.target) : undefined}
            fills={p.fills.map((f) => ({ time: new Date(f.t + IST).toISOString().slice(11, 19), side: f.side, qty: f.qty, price: f.price }))}
            image={{
              width: CHART_CSS_W, height: CHART_CSS_H, pixelRatio: 2,
              onDrawn: (c) => {
                const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
                copy.getContext('2d')?.drawImage(c, 0, 0);
                setCharts((x) => ({ ...x, [p.symbol]: copy }));
              },
              onError: (message) => setCharts((x) => ({ ...x, [p.symbol]: { error: message } })),
            }} />
        ))}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {slides.map((s) => (
          <figure key={s.name} className="w-56 shrink-0 space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.url} alt={s.label} className="w-full rounded-xl border border-zinc-800" />
            <figcaption className="flex items-center justify-between gap-2 text-xs text-ink-3">
              <span className="truncate">{s.label}</span>
              <a href={s.url} download={`${today}-${s.name}.jpg`} aria-label={`Download ${s.label}`} className="hover:text-white"><Download className="size-4" /></a>
            </figcaption>
            <label className="flex items-center gap-1.5 text-xs text-ink-3">
              <input type="checkbox" checked={!!stories[s.name]} onChange={(e) => setStories((x) => ({ ...x, [s.name]: e.target.checked }))} />Story
            </label>
          </figure>
        ))}
        {!chartsReady && <div className="flex w-56 shrink-0 items-center justify-center gap-2 text-xs text-ink-3"><Loader2 className="size-4 animate-spin" />Drawing charts…</div>}
      </div>

      <button onClick={write} disabled={writing} className={quiet}>
        {writing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}Write with Claude
      </button>
      {msg && <p className={`text-sm ${msg.ok ? 'text-data-green' : 'text-data-red-text'}`}>{msg.text}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-3 rounded-2xl border border-zinc-800 p-4">
          <h3 className="font-semibold text-white">Instagram</h3>
          <textarea rows={10} value={caption} onChange={(e) => { setCaption(e.target.value); setEdited(true); }} className={area} aria-label="Instagram caption" />
          <p className="text-xs text-ink-3">The risk disclaimer is added when it posts, and extra hashtags over 5 are dropped.</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={sendPost} disabled={!!sending || !chartsReady} className={primary}>{sending === 'post' && <Loader2 className="size-4 animate-spin" />}{state.post ? 'Post again' : `Post ${slides.length} images`}</button>
            <button onClick={sendStories} disabled={!!sending || !chartsReady} className={quiet}>{sending === 'story' && <Loader2 className="size-4 animate-spin" />}Post Story</button>
          </div>
          {state.post && <p className="flex items-center gap-1.5 text-xs text-data-green"><CheckCircle2 className="size-3.5" />Posted at {hhmm(state.post.at)}{state.post.url && <a href={state.post.url} target="_blank" rel="noopener noreferrer" className="underline">View</a>}</p>}
          {state.stories.length > 0 && <p className="flex items-center gap-1.5 text-xs text-data-green"><CheckCircle2 className="size-3.5" />{state.stories.length} Stor{state.stories.length > 1 ? 'ies' : 'y'} today, last at {hhmm(state.stories[state.stories.length - 1].at)}</p>}
        </section>
        <section className="space-y-3 rounded-2xl border border-zinc-800 p-4">
          <h3 className="font-semibold text-white">YouTube</h3>
          <textarea rows={10} value={ytText} onChange={(e) => { setYtText(e.target.value); setEdited(true); }} className={area} aria-label="YouTube post text" />
          <p className="text-xs text-ink-3">YouTube has no API for channel posts: download the images above, copy this, and paste them into a new post.</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={copy} className={quiet}><Copy className="size-4" />{copied ? 'Copied' : 'Copy text'}</button>
            <a href={CHANNEL_POSTS} target="_blank" rel="noopener noreferrer" className={quiet}><ExternalLink className="size-4" />Open channel posts</a>
          </div>
        </section>
      </div>
    </div>
  );
}
