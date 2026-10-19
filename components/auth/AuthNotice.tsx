"use client";
import React, { useEffect, useState } from 'react';
import { useSession } from '@/context/SessionContext';
import { GoogleSignInButton } from '@/components/Header';

/** The result of a sign-in attempt (or "that page needs you signed in"), shown under the header. */
const TEXT: Record<string, string> = {
  denied: 'This app is private. That Google account is not allowed in.',
  failed: 'Sign-in did not complete. Please try again.',
  expired: 'The sign-in took too long or was started in another browser. Please try again.',
  cancelled: 'Sign-in cancelled.',
  'not-configured': 'Google sign-in is not set up yet: add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET and OWNER_EMAIL in Vercel, then redeploy.',
};

export function AuthNotice() {
  const { status, signIn } = useSession();
  const [q, setQ] = useState<{ auth?: string; gid?: string; login?: boolean; next?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('auth') || p.get('login')) setQ({ auth: p.get('auth') ?? undefined, gid: p.get('gid') ?? undefined, login: p.get('login') === '1', next: p.get('next') ?? undefined });
  }, []);
  const close = () => {
    setQ(null);
    const u = new URL(window.location.href);
    ['auth', 'gid', 'login', 'next'].forEach((k) => u.searchParams.delete(k));
    window.history.replaceState(null, '', u.pathname + u.search);
  };
  if (!q) return null;
  if (q.login && status === 'owner') return null;

  const box = 'page-shell mt-4';
  const card = 'flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm';
  const x = <button onClick={close} aria-label="Dismiss" className="ml-auto text-gray-500 hover:text-white">✕</button>;

  if (q.auth === 'welcome') {
    return (
      <div className={box}>
        <div className={`${card} border-brand-accent/50 bg-brand-accent/5 text-gray-200`}>
          <span>You&apos;re signed in. One last lock: add <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-brand-accent">OWNER_GOOGLE_ID</code> = <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono">{q.gid}</code> in Vercel and redeploy, so only this exact Google account is accepted.</span>
          <button onClick={() => { void navigator.clipboard?.writeText(q.gid ?? ''); setCopied(true); }} className="rounded-full border border-brand-accent/60 px-3 py-1 text-xs font-bold text-brand-accent">{copied ? 'Copied' : 'Copy id'}</button>
          {x}
        </div>
      </div>
    );
  }
  if (q.login) {
    return (
      <div className={box}>
        <div className={`${card} border-line-strong bg-brand-card/60 text-gray-300`}>
          <span>That page is private. Sign in to open it.</span>
          <GoogleSignInButton onClick={() => signIn(q.next && q.next.startsWith('/') ? q.next : '/')} />
          {x}
        </div>
      </div>
    );
  }
  const text = q.auth ? TEXT[q.auth] : undefined;
  if (!text) return null;
  return (
    <div className={box}>
      <div className={`${card} ${q.auth === 'denied' ? 'border-data-red/60 bg-data-red/10 text-data-red-text' : 'border-line-strong bg-brand-card/60 text-gray-300'}`}>
        <span>{text}</span>
        {x}
      </div>
    </div>
  );
}
