"use client";
import React, { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Who is signed in with Google (only ever the owner; the server decides, this just shows it).
 * The session itself is an httpOnly cookie the page cannot read: this asks /api/auth/me.
 * The Dhan token (AuthContext) is separate and unchanged.
 */
export interface Owner { name?: string; email?: string; picture?: string }
interface SessionCtx {
  status: 'loading' | 'owner' | 'guest';
  owner?: Owner;
  signIn: (next?: string) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionCtx['status']>('loading');
  const [owner, setOwner] = useState<Owner | undefined>();
  useEffect(() => {
    let gone = false;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (gone) return; if (j?.owner) { setOwner({ name: j.name, email: j.email, picture: j.picture }); setStatus('owner'); } else setStatus('guest'); })
      .catch(() => { if (!gone) setStatus('guest'); });
    return () => { gone = true; };
  }, []);

  const signIn = useCallback((next?: string) => {
    const n = next ?? `${window.location.pathname}${window.location.search}`;
    window.location.href = `/api/auth/google/login?next=${encodeURIComponent(n.startsWith('/') ? n : '/')}`;
  }, []);
  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    // the Dhan token is dropped too, so a signed-out browser holds nothing that can trade or spend
    try { localStorage.removeItem('dhanToken'); } catch { /* private mode */ }
    window.location.href = '/';
  }, []);

  return <Ctx.Provider value={{ status, owner, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession must be used within a SessionProvider');
  return c;
}
