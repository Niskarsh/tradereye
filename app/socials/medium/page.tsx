"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Download, ExternalLink, Loader2, Sparkles, Trash2 } from 'lucide-react';
import Dictate from '@/components/medium/Dictate';
import { drawImage, fileName } from '@/components/medium/render';
import {
  ARTICLE_DISCLAIMER, checkDraft, FORMATS, OLD_PRICES_LINE, suggestPublications, toMediumHtml, toPlain, YOUR_WORDS_MIN,
  type Article, type ArticleHead, type Format, type ImageSpec, type Kit, type Patch, type Settings,
} from '@/lib/medium/article';

/**
 * Socials -> Medium. Medium's API is closed and no browser automation is used: tradereye prepares everything from his
 * real data and he pastes and publishes by hand (Medium's own "Schedule for later" for timing).
 * Flow: pick a format and period (loads the data, no Claude) -> Questions (1 Claude call) -> he answers, typing or
 * dictating -> Draft (1 Claude call) arranges HIS answers -> he edits -> images (drawn here, downloaded one by one) ->
 * publish kit with copy buttons -> he pastes the Medium link back.
 */

interface Periods { week: string; month: string; thisMonth: string; vsWeeks: string[]; liveFrom: string; iterations: number[] }

const btn = 'inline-flex h-9 items-center gap-1.5 rounded-full border border-brand-accent bg-brand-accent/15 px-4 text-sm font-semibold text-brand-accent transition-colors hover:bg-brand-accent/25 disabled:cursor-not-allowed disabled:opacity-40';
const btnMain = 'inline-flex h-10 items-center gap-2 rounded-full bg-brand-accent px-5 text-sm font-semibold text-brand-bg hover:bg-brand-accent-hover disabled:cursor-not-allowed disabled:opacity-40';
const ghost = 'inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-xs font-semibold text-ink-2 hover:border-brand-accent hover:text-brand-accent disabled:opacity-40';
const input = 'w-full rounded-lg border border-line-strong bg-brand-bg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-brand-accent focus:outline-none';
const card = 'rounded-2xl border border-line-strong bg-brand-card p-5';

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(url, { method: init?.method ?? 'GET', cache: 'no-store', headers: init?.body ? { 'content-type': 'application/json' } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
  return j as T;
}

function CopyButton({ text, html, label = 'Copy', disabled }: { text: string; html?: string; label?: string; disabled?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      if (html && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      } else await navigator.clipboard.writeText(text);
      setDone(true); setTimeout(() => setDone(false), 1500);
    } catch { window.alert('The browser refused the clipboard. Select the text and copy it by hand.'); }
  };
  return <button type="button" className={ghost} onClick={copy} disabled={disabled || !text}>{done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{done ? 'Copied' : label}</button>;
}

function ImageCard({ spec, title, kicker, bg, caption }: { spec: ImageSpec; title: string; kicker: string; bg?: ImageSpec; caption: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) drawImage(ref.current, spec, { title, kicker, bg }); }, [spec, title, kicker, bg]);
  const download = () => {
    ref.current?.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = fileName(title, spec.id); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  };
  return (
    <div className="rounded-xl border border-line bg-brand-bg p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{spec.data.kind === 'banner' ? 'Feature image (put it first in the story)' : `[IMAGE ${spec.id}] ${spec.title}`}</p>
          {caption && <p className="truncate text-xs text-ink-3">{caption}</p>}
        </div>
        <button type="button" className={ghost} onClick={download}><Download className="size-3.5" /> PNG</button>
      </div>
      <canvas ref={ref} className="h-auto w-full rounded-md" />
    </div>
  );
}

export default function MediumPage() {
  const [periods, setPeriods] = useState<Periods | null>(null);
  const [list, setList] = useState<ArticleHead[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [a, setA] = useState<Article | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  // new article
  const [format, setFormat] = useState<Format>('building');
  const [week, setWeek] = useState(''); const [month, setMonth] = useState('');
  const [fromIt, setFromIt] = useState(''); const [toIt, setToIt] = useState('');
  // local edits (saved on blur / Save)
  const [answers, setAnswers] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [kit, setKit] = useState<Kit>({ title: '', subtitle: '', tags: [], captions: {} });
  const [url, setUrl] = useState('');
  const [terms, setTerms] = useState('');

  const run = useCallback(async (what: string, f: () => Promise<void>) => {
    setBusy(what); setErr('');
    try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, []);

  const loadList = useCallback(() => api<{ articles: ArticleHead[] }>('/api/medium/articles').then((j) => setList(j.articles)), []);
  useEffect(() => {
    void run('load', async () => {
      const [p, s] = await Promise.all([api<Periods>('/api/medium/periods'), api<Settings>('/api/medium/settings'), loadList()]);
      setPeriods(p); setSettings(s); setTerms(s.secretTerms.join('\n'));
      setWeek(p.week); setMonth(p.month); setFromIt(String(p.iterations[0] ?? '')); setToIt(String(p.iterations[p.iterations.length - 1] ?? ''));
    });
  }, [run, loadList]);

  // Me vs Algo only offers finished season weeks; the weekly log takes any week
  useEffect(() => {
    if (!periods) return;
    if (format === 'vs-algo' && !periods.vsWeeks.includes(week)) setWeek(periods.vsWeeks[periods.vsWeeks.length - 1] ?? '');
    if (format === 'weekly' && !week) setWeek(periods.week);
  }, [format, periods, week]);

  const take = (x: Article) => {
    setA(x); setAnswers(x.questions.map((_, i) => x.answers[i] ?? '')); setDraft(x.draft);
    setKit(x.kit ?? { title: '', subtitle: '', tags: [], captions: {} }); setUrl(x.published?.url ?? '');
  };
  const open = (id: string) => run('open', async () => take((await api<{ article: Article }>(`/api/medium/article?id=${id}`)).article));
  // a save refreshes only what it saved: other unsaved edits on the page (draft text, kit fields) stay as typed
  const save = (patch: Patch) => run('save', async () => {
    const x = (await api<{ article: Article }>('/api/medium/article', { method: 'PUT', body: { id: a!.id, ...patch } })).article;
    setA(x);
    if (patch.draft !== undefined) setDraft(x.draft);
    if (patch.kit) setKit(x.kit ?? kit);
    if (patch.publishedUrl !== undefined) setUrl(x.published?.url ?? '');
    await loadList();
  });

  const create = () => run('create', async () => {
    const body = { format, week: format === 'weekly' || format === 'vs-algo' ? week : undefined, month: format === 'monthly' ? month : undefined, fromIteration: format === 'building' ? Number(fromIt) : undefined, toIteration: format === 'building' ? Number(toIt) : undefined };
    take((await api<{ article: Article }>('/api/medium/articles', { method: 'POST', body })).article);
    await loadList();
  });
  const ask = () => run('questions', async () => {
    if (a && answers.some((x, i) => x !== (a.answers[i] ?? ''))) await api('/api/medium/article', { method: 'PUT', body: { id: a.id, answers } });
    take((await api<{ article: Article }>('/api/medium/questions', { method: 'POST', body: { id: a!.id } })).article);
  });
  const write = () => run('draft', async () => {
    await api('/api/medium/article', { method: 'PUT', body: { id: a!.id, answers } });
    if (a?.draft && !window.confirm('Replace the current draft (and its title / tags) with a new one? Your edits to it will be lost.')) return;
    take((await api<{ article: Article }>('/api/medium/draft', { method: 'POST', body: { id: a!.id } })).article);
    await loadList();
  });
  const saveSettings = (next: Settings) => run('settings', async () => {
    const s = await api<Settings>('/api/medium/settings', { method: 'PUT', body: next });
    setSettings(s); setTerms(s.secretTerms.join('\n'));
  });

  const checks = useMemo(() => (a && draft ? checkDraft({ draft, answers, material: a.material, kit }, settings?.secretTerms ?? []) : null), [a, draft, answers, kit, settings]);
  const pubs = useMemo(() => (a && settings ? suggestPublications(a.format, settings.publications) : []), [a, settings]);
  const answered = answers.filter((x) => x.trim().split(/\s+/).filter(Boolean).length >= 15).length;
  const dirtyDraft = !!a && draft !== a.draft;
  const disclaimer = `${ARTICLE_DISCLAIMER}${a?.material.oldPrices ? ` ${OLD_PRICES_LINE}` : ''}`;
  const kicker = a ? FORMATS.find((f) => f.id === a.format)!.name : '';
  const bannerBg = a?.material.images.find((i) => i.data.kind !== 'banner');
  const changed = a?.material.changes ?? [];

  return (
    <div className="page-shell py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Medium</h1>
          <p className="mt-1 text-sm text-ink-3">Your real data, your words. Tradereye prepares; you paste into Medium and publish (or use Medium&apos;s &quot;Schedule for later&quot;).</p>
        </div>
        <button type="button" className={ghost} onClick={() => setShowSettings((x) => !x)}>Settings <ChevronDown className={`size-3.5 transition-transform ${showSettings ? 'rotate-180' : ''}`} /></button>
      </div>
      {err && <p className="mb-4 text-sm text-data-red-text">{err}</p>}

      {showSettings && settings && (
        <section className={`${card} mb-6`}>
          <h2 className="text-lg font-semibold text-white">Secret terms (your edge)</h2>
          <p className="mt-1 text-sm text-ink-3">One per line: feature names, thresholds, rule words. Any of these in a draft, title or caption blocks copying. Stored encrypted.</p>
          <textarea className={`${input} mt-3 h-32 font-mono`} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder={'e.g. a feature name\na threshold like 2.5 ATR'} />
          <div className="mt-3"><button type="button" className={btn} disabled={busy === 'settings'} onClick={() => saveSettings({ ...settings, secretTerms: terms.split('\n') })}>Save secret terms</button></div>
          <h2 className="mt-6 text-lg font-semibold text-white">Publications you write for</h2>
          <p className="mt-1 text-sm text-ink-3">Suggested per format, best fit first. Tick the formats each one fits.</p>
          <div className="mt-3 space-y-2">
            {settings.publications.map((p, i) => (
              <div key={p.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                <a href={p.url} target="_blank" rel="noreferrer" className={`min-w-48 font-semibold ${p.never ? 'text-data-red-text line-through' : 'text-ink'} hover:underline`}>{p.name}</a>
                {p.never ? <span className="text-xs text-data-red-text">never: {p.note}</span> : FORMATS.map((f) => (
                  <label key={f.id} className="inline-flex items-center gap-1 text-xs text-ink-3">
                    <input type="checkbox" checked={p.fits.includes(f.id)} onChange={(e) => {
                      const pubsNext = settings.publications.map((q, j) => (j !== i ? q : { ...q, fits: e.target.checked ? [...q.fits, f.id] : q.fits.filter((x) => x !== f.id) }));
                      void saveSettings({ ...settings, publications: pubsNext });
                    }} />{f.name}
                  </label>
                ))}
                {p.note && !p.never && <span className="text-xs text-ink-4">{p.note}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-6">
          <section className={card}>
            <h2 className="text-lg font-semibold text-white">New article</h2>
            <div className="mt-3 space-y-2">
              {FORMATS.map((f) => (
                <button key={f.id} type="button" onClick={() => setFormat(f.id)}
                  className={`block w-full rounded-lg border px-3 py-2 text-left ${format === f.id ? 'border-brand-accent bg-brand-accent/10' : 'border-line hover:border-line-strong'}`}>
                  <span className={`text-sm font-semibold ${format === f.id ? 'text-brand-accent' : 'text-ink'}`}>{f.name}</span>
                  <span className="block text-xs text-ink-3">{f.what}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 space-y-2 text-sm">
              {format === 'weekly' && <label className="block text-ink-3">Any day of the week<input type="date" className={`${input} mt-1`} value={week} onChange={(e) => setWeek(e.target.value)} /></label>}
              {format === 'monthly' && <label className="block text-ink-3">Month<input type="month" className={`${input} mt-1`} value={month} onChange={(e) => setMonth(e.target.value)} /></label>}
              {format === 'vs-algo' && (periods?.vsWeeks.length
                ? <label className="block text-ink-3">Week (finishing it freezes its score)<select className={`${input} mt-1`} value={week} onChange={(e) => setWeek(e.target.value)}>
                  <option value="">Pick a week</option>{periods.vsWeeks.map((w) => <option key={w} value={w}>Week of {w}</option>)}</select></label>
                : <p className="text-ink-3">No finished Me vs Algo week yet (Algo Live started {periods?.liveFrom}).</p>)}
              {format === 'building' && (periods?.iterations.length
                ? <div className="flex gap-2">
                  <label className="flex-1 text-ink-3">From<select className={`${input} mt-1`} value={fromIt} onChange={(e) => setFromIt(e.target.value)}>{periods.iterations.map((i) => <option key={i}>{i}</option>)}</select></label>
                  <label className="flex-1 text-ink-3">To<select className={`${input} mt-1`} value={toIt} onChange={(e) => setToIt(e.target.value)}>{periods.iterations.map((i) => <option key={i}>{i}</option>)}</select></label>
                </div>
                : <p className="text-ink-3">No kept Algo Lab iterations found.</p>)}
            </div>
            <button type="button" className={`${btnMain} mt-4 w-full justify-center`} disabled={!!busy || !periods} onClick={create}>
              {busy === 'create' && <Loader2 className="size-4 animate-spin" />} Load the data
            </button>
            <p className="mt-2 text-xs text-ink-4">No Claude call. Reads your journal / Algo Lab only.</p>
          </section>

          <section className={card}>
            <h2 className="text-lg font-semibold text-white">Articles</h2>
            {!list.length && <p className="mt-2 text-sm text-ink-3">{busy === 'load' ? 'Loading…' : 'None yet.'}</p>}
            <ul className="mt-2 space-y-1">
              {list.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => open(h.id)} className={`w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5 ${a?.id === h.id ? 'bg-white/5' : ''}`}>
                    <span className="block truncate font-semibold text-ink">{h.title}</span>
                    <span className="flex items-center gap-2 text-xs text-ink-3">{h.period}
                      {h.published ? <span className="rounded border border-data-green/60 px-1 text-[10px] font-bold uppercase text-data-green">Published</span> : <span className="rounded border border-line-strong px-1 text-[10px] font-bold uppercase text-ink-3">Draft</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="min-w-0 space-y-6">
          {!a && <section className={card}><p className="text-sm text-ink-3">Pick a format and period on the left, or open an article.</p></section>}
          {a && (<>
            <section className={card}>
              <p className="text-xs font-bold uppercase tracking-wide text-brand-accent">{kicker}</p>
              <h2 className="text-lg font-semibold text-white">{a.material.period.label}</h2>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-ink-3">The data Claude sees ({a.material.facts.length} lines{a.material.hiddenTickers.length ? `, ${a.material.hiddenTickers.length} recent tickers hidden as Stock A…` : ''})</summary>
                <ul className="mt-2 space-y-1 text-xs text-ink-2">{a.material.facts.map((f, i) => <li key={i}>• {f}</li>)}</ul>
              </details>
              {changed.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm font-semibold text-ink">What changed, iteration by iteration: tick only what is safe to share</p>
                  <p className="text-xs text-ink-3">Unticked lines never reach Claude or the article. Leave anything that describes inputs, thresholds or rules unticked.</p>
                  <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
                    {changed.map((c, i) => (
                      <label key={i} className="flex items-start gap-2 text-xs text-ink-2">
                        <input type="checkbox" className="mt-0.5" checked={a.shared.includes(i)} onChange={(e) => save({ shared: e.target.checked ? [...a.shared, i] : a.shared.filter((x) => x !== i) })} />
                        <span><b className="text-ink">#{c.iteration}</b> {c.text}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className={card}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-white">1. Questions</h2>
                <button type="button" className={btn} disabled={!!busy} onClick={ask}>{busy === 'questions' ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{a.questions.length ? 'New questions' : 'Ask me questions'}</button>
              </div>
              <p className="mt-1 text-xs text-ink-4">One Claude call. Answer in your own words, a few sentences each: the article is made of these.</p>
              <div className="mt-4 space-y-4">
                {a.questions.map((q, i) => (
                  <div key={i}>
                    <p className="text-sm font-semibold text-ink">{i + 1}. {q}</p>
                    <textarea className={`${input} mt-2 h-28`} value={answers[i] ?? ''} placeholder="Type or dictate…"
                      onChange={(e) => setAnswers((x) => x.map((v, j) => (j === i ? e.target.value : v)))}
                      onBlur={() => { if (answers[i] !== (a.answers[i] ?? '')) void save({ answers }); }} />
                    <div className="mt-1 flex items-center gap-2">
                      <Dictate onText={(t) => setAnswers((x) => x.map((v, j) => (j === i ? `${v}${v && !v.endsWith(' ') ? ' ' : ''}${t}` : v)))} />
                      <span className="text-xs text-ink-4">{(answers[i] ?? '').trim().split(/\s+/).filter(Boolean).length} words</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className={card}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-white">2. Draft</h2>
                <button type="button" className={btn} disabled={!!busy || answered < 3} onClick={write} title={answered < 3 ? 'Answer at least 3 questions (15+ words each) first' : ''}>
                  {busy === 'draft' ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{a.draft ? 'Redraft from my answers' : 'Draft from my answers'}
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-4">One Claude call: it only orders, trims and adds headings to your answers. Edit freely below; the disclaimer is re-added on every save. {answered}/3 answers ready.</p>
              {(a.draft || draft) && (<>
                <textarea className={`${input} mt-3 h-[28rem] font-mono text-[13px] leading-relaxed`} value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" className={btn} disabled={!dirtyDraft || !!busy} onClick={() => save({ draft })}>{busy === 'save' && <Loader2 className="size-4 animate-spin" />}Save draft</button>
                  {dirtyDraft && <span className="text-xs text-data-caution">Unsaved changes</span>}
                </div>
              </>)}
              {checks && (
                <div className="mt-4 space-y-1.5 rounded-xl border border-line bg-brand-bg p-3 text-sm">
                  <p className={checks.yourWords >= YOUR_WORDS_MIN ? 'text-data-green' : 'text-data-red-text'}>
                    <b>{Math.round(checks.yourWords * 100)}% your words</b>{checks.yourWords < YOUR_WORDS_MIN ? ` — under ${YOUR_WORDS_MIN * 100}%: put more of your own sentences back before publishing behind the paywall.` : ''}
                  </p>
                  {checks.secrets.length > 0 && <p className="text-data-red-text"><b>Blocked:</b> secret terms in the text: {checks.secrets.join(', ')}</p>}
                  {checks.tickers.length > 0 && <p className="text-data-red-text"><b>Blocked:</b> recent tickers (under 3 months, SEBI): {checks.tickers.join(', ')}. Use the Stock A… labels.</p>}
                  {checks.advice.map((x, i) => <p key={i} className="text-data-caution">Reads as advice ({x.why}): “{x.phrase}”</p>)}
                  {checks.unknownNumbers.length > 0 && <p className="text-data-caution">Numbers not in your data or answers (check them): {checks.unknownNumbers.join(', ')}</p>}
                  {checks.missingImages.length > 0 && <p className="text-ink-3">Not placed yet: {checks.missingImages.map((id) => `[IMAGE ${id}]`).join(', ')}</p>}
                  {!checks.blocked && !checks.advice.length && !checks.unknownNumbers.length && <p className="text-ink-3">No problems found.</p>}
                </div>
              )}
            </section>

            <section className={card}>
              <h2 className="text-lg font-semibold text-white">3. Images</h2>
              <p className="mt-1 text-xs text-ink-4">Drawn from your real data. Download each and upload it in Medium where its [IMAGE …] line is (the feature image goes first).</p>
              <div className="mt-3 grid gap-4 xl:grid-cols-2">
                {a.material.images.map((s) => <ImageCard key={s.id} spec={s} title={kit.title || a.material.period.label} kicker={kicker} bg={s.data.kind === 'banner' ? bannerBg : undefined} caption={kit.captions[s.id] ?? s.caption} />)}
              </div>
            </section>

            {a.kit && (
              <section className={card}>
                <h2 className="text-lg font-semibold text-white">4. Publish kit</h2>
                <div className="mt-3 space-y-3">
                  <Field label="Title" value={kit.title} max={100} onChange={(v) => setKit({ ...kit, title: v })} />
                  <Field label="Subtitle" value={kit.subtitle} max={160} onChange={(v) => setKit({ ...kit, subtitle: v })} />
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Tags (Medium allows 5)</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {[0, 1, 2, 3, 4].map((i) => (
                        <div key={i} className="flex items-center gap-1">
                          <input className={`${input} w-44`} value={kit.tags[i] ?? ''} onChange={(e) => { const t = [...kit.tags]; t[i] = e.target.value; setKit({ ...kit, tags: t }); }} />
                          <CopyButton text={kit.tags[i] ?? ''} label="" />
                        </div>
                      ))}
                    </div>
                  </div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-ink-3">Publication
                    <select className={`${input} mt-1 normal-case`} value={kit.publication ?? ''} onChange={(e) => setKit({ ...kit, publication: e.target.value || undefined })}>
                      <option value="">Your profile (no publication)</option>
                      {pubs.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                      {settings?.publications.filter((p) => !p.never && !pubs.includes(p)).map((p) => <option key={p.name} value={p.name}>{p.name} (not a usual fit)</option>)}
                    </select>
                  </label>
                  {a.material.images.filter((s) => s.data.kind !== 'banner').map((s) => (
                    <Field key={s.id} label={`Caption · ${s.id}`} value={kit.captions[s.id] ?? ''} max={160} onChange={(v) => setKit({ ...kit, captions: { ...kit.captions, [s.id]: v } })} />
                  ))}
                  <div>
                    <div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Disclaimer (already at the end of the article)</p><CopyButton text={disclaimer} /></div>
                    <p className="mt-1 text-xs text-ink-3">{disclaimer}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    <button type="button" className={btn} disabled={!!busy} onClick={() => save({ kit })}>Save kit</button>
                    <CopyButton label="Copy article (formatted)" text={toPlain(draft)} html={toMediumHtml(draft, a.material.images.map((s) => ({ ...s, caption: kit.captions[s.id] ?? s.caption })))} disabled={!draft || checks?.blocked || dirtyDraft} />
                    {checks?.blocked && <span className="text-xs text-data-red-text">Copy is blocked until the flagged text is removed.</span>}
                    {dirtyDraft && <span className="text-xs text-data-caution">Save the draft first.</span>}
                  </div>
                </div>
              </section>
            )}

            <section className={card}>
              <h2 className="text-lg font-semibold text-white">5. Published</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input className={`${input} max-w-xl flex-1`} value={url} placeholder="Paste the story's link after publishing" onChange={(e) => setUrl(e.target.value)} />
                <button type="button" className={btn} disabled={!!busy || url === (a.published?.url ?? '')} onClick={() => save({ publishedUrl: url })}>Save link</button>
                {a.published && <a className="inline-flex items-center gap-1 text-sm text-brand-accent hover:underline" href={a.published.url} target="_blank" rel="noreferrer">Open <ExternalLink className="size-3.5" /></a>}
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-ink-4">
                <span>Claude spent ₹{a.costInr.toFixed(2)} on this article.</span>
                <button type="button" className={ghost} onClick={() => { if (window.confirm('Remove this article from the list?')) void save({ deleted: true }).then(() => setA(null)); }}><Trash2 className="size-3.5" /> Remove</button>
              </div>
            </section>
          </>)}
        </main>
      </div>
    </div>
  );
}

function Field({ label, value, max, onChange }: { label: string; value: string; max: number; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">{label} <span className={`normal-case ${value.length > max ? 'text-data-red-text' : 'text-ink-4'}`}>{value.length}/{max}</span></p>
        <CopyButton text={value} />
      </div>
      <input className={`${input} mt-1`} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
