"use client";
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { PostStatus, ScheduleEditor, type ShortText, type VideoCheck } from '@/components/shorts/SchedulePanel';
import type { PlatformPost, PostPlan } from '@/lib/shorts/posts';

/**
 * The Posting view on the Socials page: what is still to go live (soonest first), what needs attention, and what went
 * live in the last 7 days. YouTube is checked with YouTube itself; Instagram from tradereye's own record.
 */

interface Row { id: string; label: string; poster?: string; post: PostPlan; text?: (ShortText & { model?: string }) | { error: string }; youtubeCheck?: VideoCheck }

const pend = (p?: PlatformPost, now = Date.now(), yt = false) => !!p && (yt ? p.state === 'scheduled' && p.at > now : p.state === 'scheduled' || p.state === 'processing');

function group(r: Row, now: number): 'attention' | 'upcoming' | 'published' {
  const { youtube: yt, instagram: ig } = r.post;
  if (yt?.state === 'failed' || ig?.state === 'failed' || r.youtubeCheck?.problem || (pend(ig, now) && ig?.wakeError)) return 'attention';
  if (pend(yt, now, true) || pend(ig, now)) return 'upcoming';
  return 'published';
}
const nextAt = (r: Row, now: number) => Math.min(...[r.post.youtube, r.post.instagram].filter((p) => p && p.at > now - 3_600_000).map((p) => p!.at), Infinity);
const lastAt = (r: Row) => Math.max(...[r.post.youtube?.at ?? 0, r.post.instagram?.at ?? 0]);

export default function PostingBoard({ onCounts, active }: { onCounts?: (n: { upcoming: number; attention: number }) => void; active?: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState('');
  const [checkError, setCheckError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [posting, setPosting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/shorts/posts', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setRows(j.rows); setNow(j.now); setCheckError(j.checkError ?? ''); setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (active) void load(); }, [active, load]);  // fresh whenever the view is opened

  const groups = { attention: [] as Row[], upcoming: [] as Row[], published: [] as Row[] };
  for (const r of rows ?? []) groups[group(r, now)].push(r);
  groups.upcoming.sort((a, b) => nextAt(a, now) - nextAt(b, now));
  groups.published.sort((a, b) => lastAt(b) - lastAt(a));
  useEffect(() => { onCounts?.({ upcoming: groups.upcoming.length, attention: groups.attention.length }); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const postNow = async (id: string) => {
    if (!window.confirm('Publish this Reel on Instagram now?')) return;
    setPosting(id);
    const r = await fetch('/api/shorts/post-now', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => null);
    const j = await r?.json().catch(() => ({}));
    if (!r?.ok) setErr(j?.message ?? 'Could not post it.');
    setPosting(null); void load();
  };

  const section = (title: string, list: Row[], empty: string, tone = 'text-white') => (
    <div className="mt-5">
      <p className={`text-sm font-semibold ${tone}`}>{title} <span className="text-ink-4">({list.length})</span></p>
      {!list.length ? <p className="mt-1 text-xs text-ink-4">{empty}</p> : (
        <div className="mt-2 space-y-2">
          {list.map((r) => (
            <React.Fragment key={r.id}>
              <div className="flex gap-3 rounded-xl border border-line p-3">
                {r.poster && <img src={r.poster} alt="" className="h-24 w-[54px] shrink-0 rounded-md object-cover" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-white">{r.label}</p>
                    {r.text && 'youtube' in r.text && <p className="truncate text-xs text-ink-3">“{r.text.youtube.title}”</p>}
                    <button onClick={() => setEditing(editing === r.id ? null : r.id)} className="ml-auto text-xs font-semibold text-brand-accent hover:underline">{editing === r.id ? 'Close' : 'Edit'}</button>
                  </div>
                  <div className="mt-1"><PostStatus bare post={r.post} now={now} busy={posting === r.id} onPostNow={() => postNow(r.id)} youtubeCheck={r.youtubeCheck} /></div>
                </div>
              </div>
              {editing === r.id && (
                <ScheduleEditor id={r.id} label={r.label} poster={r.poster} now={now} post={r.post}
                  text={r.text && 'youtube' in r.text ? r.text : undefined} onClose={() => setEditing(null)} onSaved={() => void load()} />
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className="mt-4 rounded-2xl border border-line-strong bg-brand-card p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold text-white">Posting</h2>
        <button onClick={() => void load()} aria-label="Refresh" className="ml-auto text-ink-3 hover:text-white"><RefreshCw className="size-4" /></button>
      </div>
      <p className="mt-1 text-xs text-ink-3">Times are IST. YouTube makes its videos public itself; Instagram Reels are posted by tradereye at their time. Published posts stay here for 7 days.</p>
      {err && <p className="mt-2 text-sm text-data-red-text">{err}</p>}
      {checkError && <p className="mt-2 text-xs text-data-caution">Could not ask YouTube for the latest status ({checkError}); YouTube rows show the planned state.</p>}
      {!rows ? <Loader2 className="mt-4 size-5 animate-spin text-ink-3" /> : (
        <>
          {groups.attention.length > 0 && section('Needs attention', groups.attention, '', 'text-data-red-text')}
          {section('Upcoming', groups.upcoming, 'Nothing scheduled. Schedule finished shorts under Make shorts.')}
          {section('Published, last 7 days', groups.published, 'Nothing published in the last 7 days.')}
        </>
      )}
    </section>
  );
}
