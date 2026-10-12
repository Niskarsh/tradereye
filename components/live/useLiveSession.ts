"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { openOrderSocket, type SocketState } from '@/lib/live/orderSocket';
import type { SyncResult } from '@/lib/live/sync';

export type SessionState = 'off' | 'starting' | 'running' | 'ended';
export interface Profile { clientId: string; expiresAtMs: number | null; dataPlan: string | null; dataValidity: string | null }

const POLL_OPEN_MS = 5000;     // while you have an open position
const POLL_IDLE_MS = 15000;    // flat
const EXPIRY_GRACE_MS = 30_000;

async function call<T>(path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dhan-token': token },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json?.message ?? `HTTP ${res.status}`) as Error & { code?: string }; e.code = json?.error; throw e; }
  return json as T;
}
export { call as postWithToken };

/** Start/stop a live capture session. Ends itself when the token expires. */
export function useLiveSession(token: string) {
  const [state, setState] = useState<SessionState>('off');
  const [ws, setWs] = useState<SocketState>('idle');
  const [data, setData] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string>('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const tokenRef = useRef(token);
  tokenRef.current = token;
  const alive = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sock = useRef<{ close: () => void } | null>(null);
  const queue = useRef<unknown[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const again = useRef(false);

  const stop = useCallback((why?: string) => {
    alive.current = false;
    if (timer.current) clearTimeout(timer.current);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    sock.current?.close(); sock.current = null;
    queue.current = [];
    setWs('idle');
    setState((s) => (s === 'off' ? s : 'ended'));
    if (why) setError(why);
  }, []);

  const sync = useCallback(async (includeRecent = true) => {
    if (!alive.current) return;
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    try {
      const r = await call<SyncResult>('/api/live/sync', tokenRef.current, { includeRecent });
      if (!alive.current) return;
      setData(r); setLastOkAt(Date.now()); setError('');
      if (r.warnings.length) setError(r.warnings[0]);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => sync(), r.totals.openCount > 0 ? POLL_OPEN_MS : POLL_IDLE_MS);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'TOKEN_EXPIRED' || err.code === 'FORBIDDEN' || err.code === 'TOKEN_MISSING') { stop(err.message); return; }
      setError(err.message);
      if (alive.current) { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => sync(), POLL_IDLE_MS); }
    } finally {
      busy.current = false;
      if (again.current && alive.current) { again.current = false; sync(false); }
    }
  }, [stop]);

  const flush = useCallback(async () => {
    const batch = queue.current.splice(0, 50);
    if (!batch.length || !alive.current) return;
    try { await call('/api/live/event', tokenRef.current, { messages: batch }); } catch { /* the poll will catch up */ }
    sync(false);
  }, [sync]);

  const start = useCallback(async () => {
    if (!token) { setError('Paste your Dhan token first.'); return; }
    setState('starting'); setError('');
    try {
      const p = await call<Profile & { clientId: string }>('/api/live/profile', token);
      setProfile(p);
      alive.current = true;
      setState('running');
      sock.current = openOrderSocket({
        token, clientId: p.clientId,
        onState: (s, d) => { setWs(s); if (s === 'failed' && d) setError(d); },
        onMessage: (m) => {
          queue.current.push(m);
          if (!flushTimer.current) flushTimer.current = setTimeout(() => { flushTimer.current = null; flush(); }, 400);
        },
      });
      await sync(true);
    } catch (e) {
      alive.current = false; setState('off'); setError((e as Error).message);
    }
  }, [token, sync, flush]);

  // clock + auto-end shortly after the token expires
  useEffect(() => {
    if (state !== 'running') return;
    const t = setInterval(() => {
      const n = Date.now(); setNow(n);
      if (profile?.expiresAtMs && n > profile.expiresAtMs + EXPIRY_GRACE_MS) stop('Token expired, session ended. Paste a fresh token and press Start.');
    }, 1000);
    return () => clearInterval(t);
  }, [state, profile, stop]);

  useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current); sock.current?.close(); }, []);

  const adoptToken = useCallback(async (newToken: string) => {
    tokenRef.current = newToken;
    try { setProfile(await call<Profile & { clientId: string }>('/api/live/profile', newToken)); } catch { /* keep going with old info */ }
  }, []);

  return { state, ws, data, error, profile, lastOkAt, now, start, stop, syncNow: () => sync(true), adoptToken };
}
