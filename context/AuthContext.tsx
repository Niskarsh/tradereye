"use client";
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { getCookie, setCookie } from 'cookies-next';

interface AuthContextType {
  token: string;
  setToken: (token: string) => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Load token from cookie on mount
    const savedToken = getCookie('dhanTokenId');
    if (savedToken) {
      setTokenState(savedToken as string);
    }
    setIsLoading(false);
    document.documentElement.classList.add('dark');
  }, []);

  const setToken = (newToken: string) => {
    setTokenState(newToken);
    if (newToken) {
      setCookie('dhanTokenId', newToken);
    }
  };

  return (
    <AuthContext.Provider value={{ token, setToken, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
