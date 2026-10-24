"use client";
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, XCircle } from 'lucide-react';

/**
 * YouTube tab. For now: connect YouTube and Instagram once, and test that each pipe works.
 * Generating, previewing and scheduling shorts comes next on this same page.
 */

type Platform = 'youtube' | 'instagram';
interface ConnStatus { connected: boolean; account?: string; title?: string; connectedAt?: number; expiresAt?: number; problem?: string }
interface Status { youtube: ConnStatus; instagram: ConnStatus }
interface TestResult { ok: boolean; message: string; url?: string; pending?: boolean; id?: string }

const CHANNEL_URL = 'https://www.youtube.com/@CandlesBeforeCubicles';
const fmtDate = (ms?: number) => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

const ERRORS: Record<string, string> = {
  cancelled: 'Connecting was cancelled.',
  expired: 'That connect link expired or came from another browser. Try again.',
  'wrong-channel': 'That isn\'t the Candles Before Cubicles channel. Connect again and pick Candles Before Cubicles in Google\'s account picker.',
  'wrong-account': 'That isn\'t the candlesbeforecubicles Instagram account. Log in to that account and connect again.',
  'youtube-not-configured': 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing in Vercel.',
  'instagram-not-configured': 'IG_APP_ID / IG_APP_SECRET are missing in Vercel. Add them and redeploy.',
  failed: 'Connecting failed.',
};

export default function YouTubePage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<Platform | null>(null);
  const [tests, setTests] = useState<Partial<Record<Platform, TestResult>>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/social/status', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
      setStatus(j); setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);

  useEffect(() => {
    // result of a connect round-trip, then clean the address bar
    const q = new URLSearchParams(window.location.search);
    const connected = q.get('connected'), error = q.get('error');
    if (connected) setFlash({ ok: true, text: `${connected === 'youtube' ? 'YouTube' : 'Instagram'} connected.` });
    else if (error) {
      const extra = q.get('got') ? ` (got ${q.get('got')})` : q.get('why') ? ` ${q.get('why')}` : '';
      setFlash({ ok: false, text: `${ERRORS[error] ?? 'Something went wrong.'}${extra}` });
    }
    if (connected || error) window.history.replaceState(null, '', '/youtube');
    void load();
  }, [load]);

  const disconnect = async (p: Platform) => {
    if (!window.confirm(`Disconnect ${p === 'youtube' ? 'YouTube' : 'Instagram'}? Scheduled posts there will stop until you connect again.`)) return;
    setBusy(p);
    await fetch('/api/social/disconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: p }) }).catch(() => null);
    setTests((t) => ({ ...t, [p]: undefined }));
    setBusy(null); void load();
  };

  const test = async (p: Platform, checkId?: string) => {
    setBusy(p); setTests((t) => ({ ...t, [p]: undefined }));
    try {
      const payload = checkId ? { platform: 'instagram-status', id: checkId } : { platform: p };
      const r = await fetch('/api/social/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      setTests((t) => ({ ...t, [p]: { ok: r.ok && j.ok === true, pending: j.pending === true, message: j.message ?? `HTTP ${r.status}`, url: j.url, id: j.id } }));
    } catch (e) {
      setTests((t) => ({ ...t, [p]: { ok: false, message: (e as Error).message } }));
    } finally { setBusy(null); }
  };

  return (
    <main className="page-shell py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">YouTube</h1>
          <p className="mt-1 text-sm text-ink-3">Connect your channel and Instagram once. Shorts and Reels get scheduled from here.</p>
        </div>
        <a href={CHANNEL_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-brand-accent hover:underline">
          Open channel <ExternalLink className="size-3.5" />
        </a>
      </div>

      {flash && (
        <div className={`mb-4 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${flash.ok ? 'border-data-green/50 text-data-green' : 'border-data-red/50 text-data-red-text'}`}>
          {flash.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
          <span>{flash.text}</span>
        </div>
      )}
      {err && <p className="mb-4 text-sm text-data-red-text">{err}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <ConnCard platform="youtube" name="YouTube" s={status?.youtube} busy={busy === 'youtube'} result={tests.youtube}
          note="Pick Candles Before Cubicles in Google's account picker. Google shows an 'unverified app' warning once: choose Advanced, then Go to TraderEye."
          testLabel="Test upload (private)" onTest={() => test('youtube')} onDisconnect={() => disconnect('youtube')} />
        <ConnCard platform="instagram" name="Instagram" s={status?.instagram} busy={busy === 'instagram'} result={tests.instagram}
          note="Log in as candlesbeforecubicles. The test sends a video to Instagram without publishing it."
          testLabel="Test upload (not published)" onTest={() => test('instagram')} onCheck={(id) => test('instagram', id)} onDisconnect={() => disconnect('instagram')} />
      </div>
    </main>
  );
}

function ConnCard(p: {
  platform: Platform; name: string; s?: ConnStatus; busy: boolean; result?: TestResult; note: string; testLabel: string;
  onTest: () => void; onDisconnect: () => void; onCheck?: (id: string) => void;
}) {
  const s = p.s;
  const daysLeft = s?.expiresAt ? Math.max(0, Math.round((s.expiresAt - Date.now()) / 86400_000)) : undefined;
  return (
    <section className="rounded-2xl border border-line-strong bg-brand-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-white">{p.name}</h2>
        {!s ? <span className="text-xs text-ink-4">checking…</span>
          : s.connected && !s.problem ? <span className="rounded-md border border-data-green/60 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-data-green">Connected</span>
          : s.connected ? <span className="rounded-md border border-data-red/60 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-data-red-text">Needs attention</span>
          : <span className="rounded-md border border-line-strong px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-3">Not connected</span>}
      </div>

      {s?.connected && (
        <p className="mt-3 text-sm text-ink-2">
          <span className="font-semibold text-white">{s.account ?? s.title}</span>
          {s.connectedAt ? <span className="text-ink-3"> · since {fmtDate(s.connectedAt)}</span> : null}
          {daysLeft !== undefined ? <span className="text-ink-3"> · token renews itself ({daysLeft} days left)</span> : null}
        </p>
      )}
      {s?.problem && <p className="mt-2 text-sm text-data-red-text">{s.problem}</p>}
      {!s?.connected && <p className="mt-3 text-sm text-ink-3">{p.note}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <a href={`/api/${p.platform}/oauth/login`}
          className="inline-flex h-9 items-center rounded-full bg-brand-accent px-4 text-sm font-semibold text-brand-bg hover:bg-brand-accent-hover">
          {s?.connected ? 'Reconnect' : `Connect ${p.name}`}
        </a>
        {s?.connected && (
          <>
            <button onClick={p.onTest} disabled={p.busy}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-line-strong px-4 text-sm text-ink-2 hover:border-brand-accent hover:text-white disabled:opacity-50">
              {p.busy && <Loader2 className="size-4 animate-spin" />}{p.testLabel}
            </button>
            <button onClick={p.onDisconnect} disabled={p.busy}
              className="inline-flex h-9 items-center rounded-full px-3 text-sm text-ink-3 hover:text-data-red-text disabled:opacity-50">
              Disconnect
            </button>
          </>
        )}
      </div>

      {p.result && (
        <div className={`mt-4 rounded-xl border px-3 py-2 text-sm ${p.result.ok ? 'border-data-green/50 text-data-green' : p.result.pending ? 'border-brand-accent/50 text-brand-accent' : 'border-data-red/50 text-data-red-text'}`}>
          {p.result.message}
          {p.result.url && <> <a href={p.result.url} target="_blank" rel="noopener noreferrer" className="underline">Open it</a></>}
          {p.result.pending && p.result.id && p.onCheck && (
            <button onClick={() => p.onCheck!(p.result!.id!)} disabled={p.busy} className="ml-2 underline disabled:opacity-50">Check status</button>
          )}
        </div>
      )}
    </section>
  );
}
