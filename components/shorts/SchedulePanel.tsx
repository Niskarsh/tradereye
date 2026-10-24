"use client";
import React, { useEffect, useState, type ReactNode } from 'react';
import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { fromIstInput, istLabel, toIstInput } from '@/lib/shorts/slots';
import ThumbPicker from '@/components/shorts/ThumbPicker';
import { fitTags, TAG_BUDGET, tagChars } from '@/lib/social/youtube';
import { hashtagCount, IG_MAX_HASHTAGS, type PlatformPost, type PostPlan } from '@/lib/shorts/posts';

/**
 * Scheduling one finished short: edit the words Claude wrote, pick the YouTube time, and either reuse it for Instagram
 * ("Same time on Instagram") or give Instagram its own. YouTube is uploaded at once as private with that publish time;
 * Instagram is published by tradereye itself at its time (an EventBridge Scheduler wake-up).
 */

export interface ShortText { youtube: { title: string; description: string; tags: string[] }; instagram: { caption: string } }

const input = 'mt-1 w-full rounded-lg border border-line-strong bg-brand-bg px-3 py-2 text-sm text-white placeholder:text-ink-4 disabled:opacity-40';

/** YouTube flips the video public by itself: past its time a scheduled video is live. */
const ytState = (p: PlatformPost | undefined, now: number) => (p && p.state === 'scheduled' && p.at <= now ? 'live' : p?.state);
const igPending = (p?: PlatformPost) => p?.state === 'scheduled' || p?.state === 'processing';
const pendingState = (s?: string) => s === 'scheduled' || s === 'processing';

export interface VideoCheck { privacy: string; upload: string; problem?: string }

/** "in 2 d 4 h" / "in 35 min" / "12 min ago" */
export function countdown(at: number, now: number): string {
  const m = Math.round((at - now) / 60_000), a = Math.abs(m);
  const t = a < 60 ? `${a} min` : a < 1440 ? `${Math.floor(a / 60)} h ${a % 60} min` : `${Math.floor(a / 1440)} d ${Math.floor((a % 1440) / 60)} h`;
  return m >= 0 ? `in ${t}` : `${t} ago`;
}

/** The one-line status per platform (on a short's card and in the Posting view). */
export function PostStatus({ post, now, onPostNow, busy, youtubeCheck, bare }: { post?: PostPlan; now: number; onPostNow: () => void; busy: boolean; youtubeCheck?: VideoCheck; bare?: boolean }) {
  if (!post?.youtube && !post?.instagram) return null;
  const line = (name: string, p: PlatformPost | undefined, state: string | undefined, extra?: ReactNode) => p && (
    <p className="text-[11px] leading-4">
      <b className="text-ink-3">{name}:</b>{' '}
      {state === 'live'
        ? <span className="text-data-green">Live{p.url && <> · <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">open<ExternalLink className="size-3" /></a></>}</span>
        : state === 'failed'
          ? <span className="text-data-red-text">Failed: {p.error ?? 'unknown error'}</span>
          : <span className="text-white">{istLabel(p.at)} ({countdown(p.at, now)}) · {state === 'processing' ? 'ready at Meta, waiting for its time' : 'scheduled'}{p.error && <span className="text-data-caution"> (retrying: {p.error})</span>}</span>}
      {/* YouTube already has the (private) video: links to it, so each upload can be matched (only he can open them) */}
      {p.videoId && state !== 'live' && (
        <span className="block">
          <a href={p.url ?? `https://youtube.com/shorts/${p.videoId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand-accent underline">private video<ExternalLink className="size-3" /></a>
          {' · '}
          <a href={`https://studio.youtube.com/video/${p.videoId}/edit`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand-accent underline">Studio<ExternalLink className="size-3" /></a>
        </span>
      )}
      {p.wakeError && pendingState(state) && <span className="block text-data-red-text">Timer not set: {p.wakeError}</span>}
      {extra}
    </p>
  );
  const ig = post.instagram;
  // YouTube's own word wins over the clock: public = live, a problem = failed, past its time but still private = late
  const yc = youtubeCheck;
  const ytShown = !post.youtube ? undefined : yc?.problem ? 'failed' : yc?.privacy === 'public' ? 'live' : ytState(post.youtube, now);
  const ytPost = post.youtube && yc?.problem ? { ...post.youtube, error: yc.problem } : post.youtube;
  const ytLate = yc && yc.privacy === 'private' && post.youtube && post.youtube.at < now - 10 * 60_000 && !yc.problem;
  return (
    <div className={bare ? 'space-y-1' : 'mt-2 space-y-1 rounded-lg border border-line p-2'}>
      {line('YouTube', ytPost, ytLate ? 'scheduled' : ytShown, <>
        {ytLate && <span className="block text-data-caution">Past its time but YouTube still has it private. Check YouTube Studio.</span>}
        {post.youtube?.thumbError && <span className="block text-data-caution">Custom thumbnail not set: {post.youtube.thumbError}</span>}
      </>)}
      {line('Instagram', ig, ig?.state, ig?.state === 'failed' && (
        <button onClick={onPostNow} disabled={busy} className="ml-1 font-semibold text-brand-accent hover:underline disabled:opacity-40">{busy ? 'Posting…' : 'Post now'}</button>
      ))}
    </div>
  );
}

interface Playlist { id: string; title: string; privacy: string; count: number }
let playlistCache: Playlist[] | null = null;  // one fetch per page load

/** The playlist a new short goes into by default: by its template's name ("Mystery…", "…Algo…"). */
export function defaultPlaylists(kind: string | undefined, lists: Playlist[]): string[] {
  const pat = kind === 'mystery' ? /myster/i : kind === 'vs' ? /algo/i : null;
  return pat ? lists.filter((p) => pat.test(p.title)).slice(0, 1).map((p) => p.id) : [];
}

export function ScheduleEditor({ id, kind, label, poster, text, post, defaultAt, defaultIgAt, now, onClose, onSaved }: {
  id: string; kind?: string; label: string; poster?: string; text?: ShortText; post?: PostPlan; defaultAt?: number; defaultIgAt?: number; now: number;
  onClose: () => void; onSaved: () => void;
}) {
  const yt = post?.youtube, ig = post?.instagram;
  const ytLive = ytState(yt, now) === 'live', igLive = ig?.state === 'live';
  const start = yt?.at ?? ig?.at ?? defaultAt ?? now + 3_600_000;
  const [ytOn, setYtOn] = useState(ytLive || !post || !!yt);
  const [igOn, setIgOn] = useState(igLive || !post || !!ig);
  // defaults: YouTube 15:30, Instagram 11:00 the same day, so not "same time" unless he sets it
  const [same, setSame] = useState(post ? (!ig || !yt || ig.at === yt.at) : false);
  const [ytAt, setYtAt] = useState(toIstInput(yt?.at ?? start));
  const [igAt, setIgAt] = useState(toIstInput(ig?.at ?? (post ? start : defaultIgAt ?? start)));
  const [lists, setLists] = useState<Playlist[] | null>(playlistCache);
  const [listErr, setListErr] = useState('');
  const [chosen, setChosen] = useState<string[] | null>(yt?.playlists ? yt.playlists.map((x) => x.id) : null);
  const loadLists = async (fresh = false) => {
    if (playlistCache && !fresh) return;
    setListErr('');
    try {
      const r = await fetch('/api/social/playlists', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      playlistCache = j.playlists; setLists(j.playlists);
    } catch (e) { setListErr((e as Error).message); }
  };
  useEffect(() => { void loadLists(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // until he touches them, the playlists follow the template's default
  const picked = chosen ?? defaultPlaylists(kind, lists ?? []);
  const toggleList = (pid: string) => setChosen(picked.includes(pid) ? picked.filter((x) => x !== pid) : [...picked, pid]);
  const [title, setTitle] = useState(text?.youtube.title ?? '');
  const [description, setDescription] = useState(text?.youtube.description ?? '');
  const [tags, setTags] = useState((text?.youtube.tags ?? []).join(', '));
  const [caption, setCaption] = useState(text?.instagram.caption ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const send = async (body: object) => {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/shorts/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.message ?? `HTTP ${r.status}`);
      else if (j.errors?.length) { setErr(j.errors.join(' ')); onSaved(); }
      else { onSaved(); onClose(); }
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const words = { title, description, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), caption };
  const save = () => {
    const y = fromIstInput(ytAt), i = same && ytOn ? y : fromIstInput(igAt);
    if (ytOn && !ytLive && Number.isNaN(y)) return setErr('Pick the YouTube date and time.');
    if (igOn && !igLive && Number.isNaN(i)) return setErr('Pick the Instagram date and time.');
    const dropping = [!ytOn && yt && !ytLive && 'YouTube', !igOn && igPending(ig) && 'Instagram'].filter(Boolean);
    if (dropping.length && !window.confirm(`Unschedule it from ${dropping.join(' and ')}?`)) return;
    void send({ id, text: words, youtube: ytOn ? { at: ytLive ? yt!.at : y, playlists: picked } : null, instagram: igOn ? { at: igLive ? ig!.at : i } : null });
  };
  const unscheduleAll = () => {
    if (!window.confirm('Unschedule this short? The private YouTube upload is removed; nothing already public is touched.')) return;
    void send({ id, text: words, youtube: ytLive ? { at: yt!.at } : null, instagram: igLive ? { at: ig!.at } : null });
  };

  const when = (v: string, set: (s: string) => void, disabled: boolean) => (
    <input type="datetime-local" value={v} disabled={disabled || busy} onChange={(e) => set(e.target.value)}
      className="rounded-lg border border-line-strong bg-brand-bg px-2 py-1.5 text-sm text-white [color-scheme:dark] disabled:opacity-40" />
  );
  const check = (on: boolean, set: (b: boolean) => void, labelText: string, disabled = false) => (
    <label className="flex items-center gap-2 text-sm text-ink-2">
      <input type="checkbox" checked={on} disabled={disabled || busy} onChange={(e) => set(e.target.checked)} className="accent-[var(--color-brand-accent)]" />{labelText}
    </label>
  );
  const scheduledAny = !!(yt && !ytLive) || igPending(ig);

  return (
    <div className="col-span-full rounded-2xl border border-brand-accent/60 bg-brand-card p-4">
      <div className="flex items-start gap-3">
        {poster && <img src={poster} alt="" className="hidden h-40 rounded-lg sm:block" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-white">Schedule · {label}</p>
            <button onClick={onClose} aria-label="Close" className="ml-auto text-ink-4 hover:text-white"><X className="size-4" /></button>
          </div>
          <p className="mt-0.5 text-xs text-ink-3">Times are IST. YouTube gets the video now (private) and makes it public at its time. Instagram is posted by tradereye at its time (within a minute or two).</p>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-line p-3">
              {check(ytOn, setYtOn, 'YouTube Short', ytLive)}
              {ytLive ? <p className="mt-2 text-xs text-data-green">Live. Edit it in YouTube Studio.</p> : (
                <>
                  <div className="mt-2 flex flex-wrap items-center gap-2">{when(ytAt, setYtAt, !ytOn)}</div>
                  <div className="mt-3">
                    <div className="flex items-center gap-2 text-xs text-ink-3">
                      Playlists
                      <button onClick={() => void loadLists(true)} disabled={busy} className="text-brand-accent hover:underline">refresh</button>
                    </div>
                    {listErr ? <p className="mt-1 text-xs text-data-red-text">{listErr}</p>
                      : !lists ? <Loader2 className="mt-1 size-4 animate-spin text-ink-3" />
                      : !lists.length ? <p className="mt-1 text-xs text-ink-4">No playlists yet. Create them in YouTube Studio, then refresh.</p>
                      : (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {lists.map((pl) => (
                            <button key={pl.id} onClick={() => toggleList(pl.id)} disabled={busy || !ytOn}
                              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${picked.includes(pl.id) ? 'border-brand-accent bg-brand-accent/15 text-brand-accent' : 'border-line-strong text-ink-3 hover:text-white'}`}>
                              {picked.includes(pl.id) && <Check className="size-3" />}{pl.title}
                            </button>
                          ))}
                        </div>
                      )}
                  </div>
                  <p className="mt-3 text-[11px] leading-4 text-ink-4">Set on every upload: not made for kids · no altered or synthetic (AI) content · no paid promotion · category People &amp; Blogs · English (US). A SEBI risk disclaimer is added to the description and caption if missing.</p>
                </>
              )}
            </div>
            <div className="rounded-xl border border-line p-3">
              {check(igOn, setIgOn, 'Instagram Reel', igLive)}
              {igLive ? <p className="mt-2 text-xs text-data-green">Live on Instagram.</p> : (
                <div className="mt-2 space-y-2">
                  {ytOn && !ytLive && check(same, setSame, 'Same time as YouTube', !igOn)}
                  {(!same || !ytOn || ytLive) && <div>{when(igAt, setIgAt, !igOn)}</div>}
                </div>
              )}
            </div>
          </div>

          <div className="mt-3"><ThumbPicker id={id} disabled={busy || (ytLive && igLive)} /></div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-xs text-ink-3">YouTube title <span className={title.length > 55 ? 'text-data-caution' : 'text-ink-4'}>({title.length}/100{title.length > 55 ? ': phones show about 50' : ''})</span>
                <input value={title} maxLength={100} disabled={busy || ytLive} onChange={(e) => setTitle(e.target.value)} className={input} />
              </label>
              <label className="block text-xs text-ink-3">YouTube description <span className="text-ink-4">({description.length}/4500; the first ~100 show under the video)</span>
                <textarea value={description} rows={6} disabled={busy || ytLive} onChange={(e) => setDescription(e.target.value)} className={input} />
              </label>
              <label className="block text-xs text-ink-3">Tags (comma separated) <span className="text-ink-4">· {tagChars(fitTags(tags.split(',').map((t) => t.trim()).filter(Boolean)))}/{TAG_BUDGET} characters with the channel name added; extras are dropped</span>
                <input value={tags} disabled={busy || ytLive} onChange={(e) => setTags(e.target.value)} className={input} />
              </label>
            </div>
            <label className="block text-xs text-ink-3">Instagram caption <span className="text-ink-4">({caption.length}/2200)</span>
              <span className={hashtagCount(caption) > IG_MAX_HASHTAGS ? 'text-data-red-text' : 'text-ink-4'}> · {hashtagCount(caption)}/{IG_MAX_HASHTAGS} hashtags{hashtagCount(caption) > IG_MAX_HASHTAGS ? ' (extra ones are dropped)' : ''}</span>
              <textarea value={caption} rows={12} maxLength={2200} disabled={busy || igLive} onChange={(e) => setCaption(e.target.value)} className={input} />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button onClick={save} disabled={busy || (!ytOn && !igOn && !scheduledAny) || (ytOn && !ytLive && !lists && !listErr)}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-brand-accent px-5 text-sm font-semibold text-brand-bg hover:bg-brand-accent-hover disabled:opacity-40">
              {busy && <Loader2 className="size-4 animate-spin" />}{scheduledAny ? 'Save changes' : 'Schedule'}
            </button>
            {scheduledAny && <button onClick={unscheduleAll} disabled={busy} className="text-sm font-semibold text-data-red-text hover:underline disabled:opacity-40">Unschedule</button>}
            {busy && ytOn && !yt && <span className="text-xs text-ink-3">Uploading to YouTube…</span>}
            {err && <span className="text-sm text-data-red-text">{err}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
