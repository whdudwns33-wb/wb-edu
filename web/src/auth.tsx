import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SessionUser } from '@wb/shared';
import { get, post } from './api.ts';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>({ user: null, loading: true, login: async () => {}, logout: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get<SessionUser | null>('/api/auth/me')
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const onUnauthorized = () => setUser(null);
    window.addEventListener('wb:unauthorized', onUnauthorized);
    return () => window.removeEventListener('wb:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const u = await post<SessionUser>('/api/auth/login', { username, password });
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await post('/api/auth/logout');
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
