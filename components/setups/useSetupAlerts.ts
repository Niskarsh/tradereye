"use client";
import { useEffect, useRef, useState } from 'react';
import type { LiveAlert } from '@/lib/setups/live';

/**
 * Setup alerts for the Order Book page: once a minute during the session (09:20-15:00 IST) the stocks on his list
 * are run through the backtested setups on the server. Only setups whose past numbers clear the alert bar are shown;
 * each stays (also across a refresh, for today) until he closes it. Plain code, no Claude.
 */

const KEY = 'tradereye-setup-alerts';
export type SetupAlert = LiveAlert & { opened?: boolean };
const today = () => new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
const istMin = () => { const d = new Date(Date.now() + 19800_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

export interface ScanInfo { at?: number; watching: number; runId?: string | null; error?: string; noResults?: boolean }

export function useSetupAlerts(opts: {
  token: string;
  list: { symbol: string; securityId: string }[];
  onNew?: (a: SetupAlert) => void;
  /** alerts switched off: keep scanning (and marking setups as seen) but show nothing, so switching on later
   *  only brings alerts from that point on, not the ones that fired while they were off */
  enabled?: boolean;
}) {
  const [alerts, setAlerts] = useState<SetupAlert[]>([]);
  const [info, setInfo] = useState<ScanInfo>({ watching: 0 });
  const seen = useRef(new Set<string>());
  const ref = useRef(opts); ref.current = opts;

  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      if (v.date === today()) { setAlerts(Array.isArray(v.alerts) ? v.alerts : []); for (const id of v.seen ?? []) seen.current.add(id); }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ date: today(), alerts, seen: [...seen.current] })); } catch { /* ignore */ }
  }, [alerts]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const { token, list } = ref.current;
      const m = istMin();
      // 09:20-15:05: the last-half-hour setups are decided at 15:00
      if (token && list.length && m >= 9 * 60 + 20 && m <= 15 * 60 + 5) {
        try {
          const r = await fetch('/api/setups/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dhan-token': token }, body: JSON.stringify({ symbols: list }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
          const fresh: SetupAlert[] = [];
          for (const a of (j.alerts ?? []) as LiveAlert[]) {
            if (!a.alert || seen.current.has(a.id)) continue;
            seen.current.add(a.id);
            fresh.push(a);
          }
          if (fresh.length && ref.current.enabled !== false) { setAlerts((all) => [...fresh, ...all].slice(0, 30)); for (const a of fresh) ref.current.onNew?.(a); }
          else if (fresh.length) {
            // nothing shown, but remember them as seen across a refresh too
            try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); localStorage.setItem(KEY, JSON.stringify({ date: today(), alerts: v.date === today() && Array.isArray(v.alerts) ? v.alerts : [], seen: [...seen.current] })); } catch { /* ignore */ }
          }
          setInfo({ at: Date.now(), watching: list.length, runId: j.runId, noResults: !j.runId, error: j.errors?.length ? `${j.errors.length} stock(s) could not be read: ${j.errors[0].symbol} (${j.errors[0].message})` : undefined });
        } catch (e) { setInfo((i) => ({ ...i, at: Date.now(), watching: list.length, error: (e as Error).message })); }
      } else setInfo((i) => ({ ...i, watching: list.length }));
      if (stop) return;
      // shortly after the next minute starts, so the minute that just ended is complete at Dhan
      const ms = 60_000 - (Date.now() % 60_000) + 4_000;
      timer = setTimeout(() => { void tick(); }, ms);
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, []);

  const dismiss = (id: string) => setAlerts((all) => all.filter((a) => a.id !== id));
  const markOpened = (id: string) => setAlerts((all) => all.map((a) => (a.id === id ? { ...a, opened: true } : a)));
  const clear = () => setAlerts([]);
  return { alerts, info, dismiss, markOpened, clear };
}
