"use client";
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ExternalLink, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AccountPoint, Finding, Group, LastRun, Row } from '@/lib/socialAnalysis/analyze';
import type { SavedRead } from '@/lib/socialAnalysis/prompt';

/**
 * Socials -> Analysis. Top: the decision (what to change next, Claude, on demand). Then the formats side by side, then
 * every post. Everything shown comes from the saved daily numbers; Refresh pulls today's, and neither costs a Claude call.
 */

interface Data {
  now: number; updatedAt: number; lastRun?: LastRun; account: AccountPoint[]; rows: Row[]; groups: Group[]; findings: Finding[];
  mature: { youtube: number; instagram: number }; reads: SavedRead[]; youtubeNeedsReconnect: boolean;
}

const WANT_POSTS = 10;
const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const n = (x?: number) => (x === undefined ? '–' : nf.format(x));
const d1 = (x?: number, s = '') => (x === undefined ? '–' : `${Math.round(x * 10) / 10}${s}`);
const pc = (x?: number) => (x === undefined ? '–' : `${Math.round(x * 100)}%`);
const when = (ms?: number) => (ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
const day = (ms?: number) => (ms ? new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '');
const OUTCOME: Record<string, string> = { win: 'Win', loss: 'Loss', me: 'I won', algo: 'Bot won', tie: 'Tie', none: 'No trades' };
const card = 'rounded-2xl border border-line-strong bg-brand-card p-5';

export default function AnalysisBoard() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<'refresh' | 'read' | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/social/analysis', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setData(j); setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (kind: 'refresh' | 'read') => {
    setBusy(kind); setErr('');
    try {
      const r = await fetch(`/api/social/analysis/${kind}`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const m = data?.mature;
  const canRead = !!m && (m.youtube > 0 || m.instagram > 0);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Analysis</h1>
          <p className="mt-1 text-sm text-ink-3">{data?.updatedAt ? `Numbers from ${when(data.updatedAt)}. Pulled every morning at 7.` : 'How each Short and Reel did, and what to change next.'}</p>
        </div>
        <button onClick={() => act('refresh')} disabled={!!busy} className="inline-flex h-9 items-center gap-2 rounded-full border border-line-strong px-4 text-sm text-ink-2 hover:border-brand-accent hover:text-white disabled:opacity-50">
          {busy === 'refresh' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Refresh numbers
        </button>
      </div>

      {err && <p className="mt-4 text-sm text-data-red-text">{err}</p>}
      {data?.youtubeNeedsReconnect && (
        <div className="mt-4 rounded-xl border border-brand-accent/50 px-4 py-3 text-sm text-brand-accent">
          Views and likes are coming through. Watch time and retention need one more YouTube permission: <a href="/api/youtube/oauth/login" className="font-semibold underline">Reconnect YouTube</a>.
        </div>
      )}
      {!!data?.lastRun?.problems.length && (
        <div className="mt-4 rounded-xl border border-data-red/50 px-4 py-3 text-sm text-data-red-text">
          <p className="font-semibold">The last pull had problems</p>
          <ul className="mt-1 list-disc pl-5">{data.lastRun.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}

      {!data ? <p className="mt-8 text-sm text-ink-3">{err ? '' : 'Loading…'}</p> : !data.rows.length ? (
        <div className={`${card} mt-6`}>
          <p className="text-white">No numbers saved yet.</p>
          <p className="mt-1 text-sm text-ink-3">Press Refresh numbers to pull the first set. From then on it runs by itself every morning.</p>
        </div>
      ) : (
        <>
          <Followers account={data.account} now={data.now} />
          <NextMove reads={data.reads} busy={busy === 'read'} disabled={!!busy || !canRead} onRead={() => act('read')} mature={data.mature} />
          <Formats groups={data.groups} findings={data.findings} mature={data.mature} />
          <h2 className="mt-8 text-lg font-semibold text-white">Every post</h2>
          <div className="mt-3 grid gap-3">{data.rows.map((r) => <PostCard key={r.id} r={r} />)}</div>
        </>
      )}
    </>
  );
}

function Followers({ account, now }: { account: AccountPoint[]; now: number }) {
  const last = account.at(-1);
  if (!last) return null;
  const weekAgo = [...account].reverse().find((a) => now - a.at >= 6.5 * 86_400_000);
  const tile = (name: string, v?: number, old?: number) => (
    <div className={card}>
      <p className="text-xs uppercase tracking-wide text-ink-3">{name}</p>
      <p className="mt-1 text-2xl font-semibold text-white">{n(v)}</p>
      <p className="mt-0.5 text-xs text-ink-3">{v !== undefined && old !== undefined ? `${v - old >= 0 ? '+' : ''}${n(v - old)} in the last week` : 'Weekly change shows after 7 days of pulls'}</p>
    </div>
  );
  return <div className="mt-6 grid gap-3 sm:grid-cols-2">{tile('YouTube subscribers', last.youtubeSubs, weekAgo?.youtubeSubs)}{tile('Instagram followers', last.igFollowers, weekAgo?.igFollowers)}</div>;
}

function Lines({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div className="mt-3"><p className="text-xs uppercase tracking-wide text-ink-3">{title}</p><ul className="mt-1 space-y-1 text-sm text-ink-2">{items.map((x) => <li key={x}>{x}</li>)}</ul></div>;
}

function ReadView({ r }: { r: SavedRead }) {
  return (
    <div>
      <p className="text-lg font-semibold text-white">{r.call}</p>
      <p className="mt-1 text-xs text-ink-3">Confidence: {r.confidence} · {when(r.at)} · read {r.mature.youtube} YouTube and {r.mature.instagram} Instagram posts · ₹{r.costInr.toFixed(2)}</p>
      <div className="mt-4 rounded-xl border border-brand-accent/40 p-4">
        <p className="text-xs uppercase tracking-wide text-brand-accent">Next test: change one thing</p>
        <p className="mt-1 text-sm font-semibold text-white">{r.next_test.change}</p>
        <p className="mt-2 text-sm text-ink-2"><span className="text-ink-3">Keep the same: </span>{r.next_test.keep_same}</p>
        <p className="mt-1 text-sm text-ink-2"><span className="text-ink-3">Run it for: </span>{r.next_test.posts} posts</p>
        <p className="mt-1 text-sm text-ink-2"><span className="text-ink-3">Judge by: </span>{r.next_test.judge_by}</p>
      </div>
      <Lines title="Why" items={r.why} /><Lines title="Keep" items={r.keep} /><Lines title="Stop" items={r.stop} />
    </div>
  );
}

function NextMove({ reads, busy, disabled, onRead, mature }: { reads: SavedRead[]; busy: boolean; disabled: boolean; onRead: () => void; mature: Data['mature'] }) {
  const [latest, ...older] = reads;
  const none = !mature.youtube && !mature.instagram;
  return (
    <section className={`${card} mt-6`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-white">What to change next</h2>
        <button onClick={onRead} disabled={disabled} className="inline-flex h-9 items-center gap-2 rounded-full bg-brand-accent px-4 text-sm font-semibold text-brand-bg hover:bg-brand-accent-hover disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{latest ? 'Read again' : 'Read with Claude'}
        </button>
      </div>
      <div className="mt-4">
        {latest ? <ReadView r={latest} /> : <p className="text-sm text-ink-3">{none ? 'Waiting for a post to turn 7 days old. Younger ones have not finished being shown, so judging them now would mislead.' : 'One paid Claude call, only when you press it.'}</p>}
      </div>
      {!!older.length && (
        <details className="mt-5 border-t border-line-strong pt-3">
          <summary className="cursor-pointer text-sm text-ink-3 hover:text-white">Earlier reads ({older.length})</summary>
          <div className="mt-4 space-y-6">{older.map((r) => <ReadView key={r.at} r={r} />)}</div>
        </details>
      )}
    </section>
  );
}

function Compare({ name, heads, rows }: { name: string; heads: string[]; rows: { key: string; label: string; n: number; cells: string[] }[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-white">{name}</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[460px] text-sm">
          <thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 pr-3 font-normal"></th><th className="py-1.5 pr-3 text-right font-normal">Posts</th>{heads.map((h) => <th key={h} className="py-1.5 pl-3 text-right font-normal">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.key} className="border-t border-line-strong/60 text-ink-2">
              <td className="py-1.5 pr-3 text-white">{r.label}</td><td className="py-1.5 pr-3 text-right">{r.n}</td>
              {r.cells.map((c, i) => <td key={heads[i]} className="py-1.5 pl-3 text-right tabular-nums">{r.n ? c : '–'}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Formats({ groups, findings, mature }: { groups: Group[]; findings: Finding[]; mature: Data['mature'] }) {
  const have = Math.max(mature.youtube, mature.instagram);
  return (
    <section className={`${card} mt-6`}>
      <h2 className="text-lg font-semibold text-white">Format against format</h2>
      <p className="mt-1 text-sm text-ink-3">Typical post (median), counting only posts at least 7 days old. {have < WANT_POSTS ? `${have} of ${WANT_POSTS} posts so far: treat any gap as a hint, not an answer.` : ''}</p>
      {findings.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-data-green">{findings.map((f) => <li key={`${f.platform}${f.a}${f.metric}`}>{f.platform}: {f.better} ahead on {f.metric} by {f.gapPct}%</li>)}</ul>
      ) : <p className="mt-3 text-sm text-ink-2">No clear winner yet: that needs 5 posts on each side and a gap of 25% or more.</p>}
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <Compare name="YouTube" heads={['Views', 'Watched', 'At 3s', 'Subs / 1k']} rows={groups.map((g) => ({ key: g.key, label: g.label, n: g.youtube.n, cells: [n(g.youtube.views), d1(g.youtube.avgPct, '%'), pc(g.youtube.at3s), d1(g.youtube.subsPer1k)] }))} />
        <Compare name="Instagram" heads={['Views', 'Watch', 'Skip', 'Sh+Sv / 1k']} rows={groups.map((g) => ({ key: g.key, label: g.label, n: g.instagram.n, cells: [n(g.instagram.views), d1(g.instagram.avgWatchSec, 's'), d1(g.instagram.skipPct, '%'), d1(g.instagram.sharesSavesPer1k)] }))} />
      </div>
    </section>
  );
}

const Stat = ({ k, v }: { k: string; v: string }) => <div><p className="text-[11px] text-ink-3">{k}</p><p className="text-sm tabular-nums text-white">{v}</p></div>;

function PostCard({ r }: { r: Row }) {
  const [open, setOpen] = useState(false);
  const f = r.facts, y = r.youtube, g = r.instagram;
  return (
    <article className="rounded-2xl border border-line-strong bg-brand-card p-4">
      <div className="flex gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {r.poster ? <img src={r.poster} alt="" className="h-20 w-[45px] shrink-0 rounded-md object-cover" /> : <div className="h-20 w-[45px] shrink-0 rounded-md bg-brand-raised" />}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-white">{f.title || f.label}</p>
          <p className="mt-0.5 text-xs text-ink-3">{f.kind === 'mystery' ? 'Mystery chart' : 'Me vs Algo'} · {OUTCOME[f.outcome] ?? f.outcome}{f.resultR !== undefined ? ` ${f.resultR > 0 ? '+' : ''}${f.resultR}R` : ''}</p>
          {y && (
            <div className="mt-2 flex flex-wrap items-start gap-x-5 gap-y-1">
              <PlatformTag name="YouTube" at={y.at} url={y.url} mature={y.mature} />
              <Stat k="Views" v={n(y.views)} /><Stat k="Watched" v={d1(y.avgPct, '%')} /><Stat k="At 3s" v={pc(y.retention?.at3s)} /><Stat k="Net subs" v={n(y.subs)} />
            </div>
          )}
          {g && (
            <div className="mt-2 flex flex-wrap items-start gap-x-5 gap-y-1">
              <PlatformTag name="Instagram" at={g.at} url={g.url} mature={g.mature} />
              <Stat k="Views" v={n(g.views)} /><Stat k="Watch" v={d1(g.avgWatchSec, 's')} /><Stat k="Skip" v={d1(g.skipPct, '%')} /><Stat k="Shares" v={n(g.shares)} /><Stat k="Saves" v={n(g.saved)} />
            </div>
          )}
        </div>
      </div>
      {!!y?.curve?.length && (
        <>
          <button onClick={() => setOpen(!open)} className="mt-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-white">
            Where viewers leave <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && <Retention r={r} />}
        </>
      )}
    </article>
  );
}

function PlatformTag({ name, at, url, mature }: { name: string; at: number; url?: string; mature: boolean }) {
  return (
    <div className="w-24">
      {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-2 hover:text-white">{name}<ExternalLink className="size-3" /></a> : <p className="text-[11px] font-semibold text-ink-2">{name}</p>}
      <p className="text-[11px] text-ink-3">{day(at)}{mature ? '' : ' · too new'}</p>
    </div>
  );
}

function Retention({ r }: { r: Row }) {
  const y = r.youtube!, dur = y.durationSec ?? 0;
  const points = (y.curve ?? []).map(([x, w]) => ({ sec: Math.round(x * dur * 10) / 10, pct: Math.round(w * 1000) / 10 }));
  const read = y.retention;
  return (
    <div className="mt-3">
      <p className="text-sm text-ink-2">
        {read?.at3s !== undefined ? <><b className="text-white">{pc(read.at3s)}</b> still watching at 3 seconds. </> : null}
        {read?.steepestAtSec !== undefined ? <>Biggest drop starts at <b className="text-white">{read.steepestAtSec}s</b>. </> : null}
        {read?.atEnd !== undefined ? <><b className="text-white">{pc(read.atEnd)}</b> at the end.</> : null}
      </p>
      <div className="mt-2 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid vertical={false} stroke="var(--ink-4)" strokeOpacity={0.35} />
            <XAxis dataKey="sec" type="number" domain={[0, dur]} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--ink-4)' }} unit="s" />
            <YAxis domain={[0, 'auto']} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={false} unit="%" />
            <ReferenceLine y={100} stroke="var(--ink-3)" strokeDasharray="4 4" />
            <Tooltip formatter={(v) => [`${v}%`, 'Still watching']} labelFormatter={(l) => `${l}s into the video`} contentStyle={{ background: 'var(--gunmetal-slate)', border: '1px solid var(--ink-4)', borderRadius: 8, fontSize: 12 }} itemStyle={{ color: 'var(--cool-off-white)' }} labelStyle={{ color: 'var(--ink-3)' }} />
            <Line type="monotone" dataKey="pct" stroke="var(--candlelight-gold)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
