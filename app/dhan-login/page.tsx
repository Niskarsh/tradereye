"use client";
import React, { useRef, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, LogOut, RefreshCcw } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

const left = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

/**
 * Dhan login: type the 6-digit TOTP, the server swaps it for a 24h access token (client id and MPIN stay in Vercel),
 * and the token is kept in this browser for every page of the app. Paste a token by hand only as a fallback.
 */
export default function DhanLogin() {
  const { token, setToken, clearToken, expiresAtMs, clientId, isLoading } = useAuth();
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState<'' | 'totp' | 'renew'>('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [paste, setPaste] = useState('');
  const sent = useRef('');

  const login = async (code: string) => {
    if (!/^\d{6}$/.test(code) || sent.current === code) return;
    sent.current = code;
    setBusy('totp'); setMsg(null);
    try {
      const res = await fetch('/api/auth/totp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ totp: code }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.accessToken) throw new Error(j.message || `HTTP ${res.status}`);
      setToken(j.accessToken);
      setOtp('');
      setMsg({ ok: true, text: 'Logged in. Every page of the app now uses this token.' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); sent.current = ''; }
    finally { setBusy(''); }
  };

  const renew = async () => {
    setBusy('renew'); setMsg(null);
    try {
      const res = await fetch('/api/live/renew', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dhan-token': token } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.accessToken) throw new Error(j.message || `HTTP ${res.status}`);
      setToken(j.accessToken);
      setMsg({ ok: true, text: 'Renewed for another 24h. The old token no longer works.' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(''); }
  };

  const ms = expiresAtMs ? expiresAtMs - Date.now() : undefined;
  return (
    <div className="min-h-screen bg-brand-bg text-zinc-100 font-sans pb-24">
      <div className="page-shell pt-6"><div className="max-w-xl space-y-6">
        <header className="border-b border-zinc-900 pb-4">
          <h1 className="text-2xl font-black tracking-tighter">Dhan login</h1>
          <p className="text-[9px] font-bold text-brand-text uppercase tracking-[0.2em]">One token for the whole app · kept in this browser</p>
        </header>

        {!isLoading && token && (
          <div className="rounded-2xl border border-data-green/40 bg-data-green/5 p-4 space-y-3">
            <p className="flex items-center gap-2 text-sm font-black text-data-green"><CheckCircle2 className="w-4 h-4" />Connected{clientId ? ` · ${clientId}` : ''}</p>
            {ms !== undefined && <p className="text-xs text-zinc-400">Expires in {left(ms)} ({new Date(expiresAtMs!).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST).</p>}
            <div className="flex gap-2">
              <button onClick={renew} disabled={busy !== ''} className="flex h-9 items-center gap-1.5 rounded-lg bg-zinc-100 px-3 text-[11px] font-black text-black disabled:opacity-40">
                {busy === 'renew' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}Renew 24h
              </button>
              <button onClick={() => { clearToken(); setMsg(null); }} className="flex h-9 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-[11px] font-black text-zinc-300">
                <LogOut className="w-3.5 h-3.5" />Log out
              </button>
            </div>
          </div>
        )}

        <div className="rounded-2xl bg-brand-card p-5 space-y-3">
          <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-zinc-500"><KeyRound className="w-3.5 h-3.5" />{token ? 'New token from TOTP' : 'Enter your Dhan TOTP'}</label>
          <input value={otp} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" autoFocus={!token}
            onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setOtp(v); if (v.length === 6) login(v); }}
            className="w-full rounded-xl border border-zinc-800 bg-black p-4 text-center font-mono text-2xl font-bold tracking-[0.5em] outline-none focus:border-brand-accent" />
          <p className="text-[11px] text-zinc-500">{busy === 'totp' ? 'Asking Dhan…' : 'It logs in as soon as the 6th digit is typed.'}</p>
        </div>

        {msg && <p className={`rounded-xl px-4 py-3 text-xs font-bold ${msg.ok ? 'bg-data-green/10 text-data-green' : 'bg-data-red/10 text-data-red'}`}>{msg.text}</p>}

        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">Paste a token instead</summary>
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (paste.trim()) { setToken(paste); setPaste(''); setMsg({ ok: true, text: 'Token saved for the whole app.' }); } }}>
            <input type="password" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Dhan access token"
              className="flex-1 rounded-lg border border-zinc-800 bg-brand-card px-3 py-2 font-mono text-xs text-zinc-200 outline-none" />
            <button type="submit" className="rounded-lg bg-zinc-100 px-3 text-[11px] font-black text-black">Save</button>
          </form>
        </details>
      </div></div>
    </div>
  );
}
