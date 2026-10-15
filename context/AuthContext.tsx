"use client";
import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { deleteCookie, getCookie } from 'cookies-next';
import { decodeJwt } from '@/lib/live/time';

/**
 * The Dhan access token, one place for the whole app. It is created on the Dhan login page (TOTP) and kept in this
 * browser's localStorage; every page reads it from here and sends it to the server in a header. An expired token is
 * dropped automatically.
 */
interface AuthContextType {
  token: string;
  setToken: (token: string) => void;
  clearToken: () => void;
  isLoading: boolean;
  /** when Dhan says the token expires (ms), and whose it is (read from the token, not verified) */
  expiresAtMs?: number;
  clientId?: string;
}

const KEY = 'dhanToken';
const LEGACY_COOKIE = 'dhanTokenId';
const AuthContext = createContext<AuthContextType | undefined>(undefined);

const read = (): string => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
const write = (t: string) => { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* private mode */ } };
const expired = (t: string) => { const exp = decodeJwt(t)?.expMs; return !!exp && exp <= Date.now(); };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let t = read();
    // one-time move from the old cookie
    const legacy = getCookie(LEGACY_COOKIE);
    if (!t && typeof legacy === 'string' && legacy) { t = legacy; write(t); }
    if (legacy) deleteCookie(LEGACY_COOKIE);
    if (t && expired(t)) { write(''); t = ''; }
    setTokenState(t);
    setIsLoading(false);
    document.documentElement.classList.add('dark');
    // other tabs logging in / out
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setTokenState(e.newValue ?? ''); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // drop the token the moment it expires
  useEffect(() => {
    const exp = token ? decodeJwt(token)?.expMs : undefined;
    if (!exp) return;
    const ms = exp - Date.now();
    if (ms <= 0) { write(''); setTokenState(''); return; }
    const id = setTimeout(() => { write(''); setTokenState(''); }, Math.min(ms, 2_147_000_000));
    return () => clearTimeout(id);
  }, [token]);

  const setToken = useCallback((t: string) => { const v = t.trim(); write(v); setTokenState(v); }, []);
  const clearToken = useCallback(() => { write(''); setTokenState(''); }, []);
  const info = token ? decodeJwt(token) : null;

  return (
    <AuthContext.Provider value={{ token, setToken, clearToken, isLoading, expiresAtMs: info?.expMs, clientId: info?.dhanClientId }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
