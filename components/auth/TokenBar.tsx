"use client";
import React from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

const left = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

/** One line on every page that needs Dhan: logged in (and for how long) or a link to the Dhan login page. */
export function TokenBar({ children }: { children?: React.ReactNode }) {
  const { token, expiresAtMs, clientId, isLoading } = useAuth();
  if (isLoading) return null;
  if (!token) {
    return (
      <Link href="/dhan-login" className="flex items-center justify-between gap-3 rounded-2xl border border-brand-accent/40 bg-brand-accent/5 px-4 py-3 text-sm">
        <span className="flex items-center gap-2 font-bold text-brand-accent"><KeyRound className="w-4 h-4" />Not logged in to Dhan</span>
        <span className="text-[11px] font-black uppercase tracking-widest text-brand-accent">Log in →</span>
      </Link>
    );
  }
  const ms = expiresAtMs ? expiresAtMs - Date.now() : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-brand-card px-4 py-2.5 text-[11px] text-zinc-400">
      <span className="h-2 w-2 rounded-full bg-data-green" />
      <span>Dhan{clientId ? ` ${clientId}` : ''} connected{ms !== undefined ? ` · ${left(ms)} left` : ''}</span>
      <Link href="/dhan-login" className="text-zinc-500 underline decoration-dotted underline-offset-2">manage</Link>
      {children && <span className="ml-auto flex items-center gap-2">{children}</span>}
    </div>
  );
}
