import { createContext, useCallback, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { AuthenticatedIdentity } from '@bitgo-agent-wallet/sdk';
import { client, clearApiToken, hasStoredApiToken, persistApiToken } from '../api/client';

interface AuthContextValue {
  identity: AuthenticatedIdentity | null;
  loading: boolean;
  error: string | null;
  login: (apiToken: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** The console's session identity. Wraps `authenticate` (Section 6.7) so every
 * page can read the current user's role without re-fetching. */
export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [identity, setIdentity] = useState<AuthenticatedIdentity | null>(null);
  const [loading, setLoading] = useState(hasStoredApiToken());
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (apiToken: string) => {
    setLoading(true);
    setError(null);
    try {
      const id = await client.authenticate(apiToken);
      persistApiToken(id.apiToken);
      setIdentity(id);
    } catch {
      setError('Invalid API token');
      throw new Error('Invalid API token');
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearApiToken();
    setIdentity(null);
  }, []);

  useEffect(() => {
    if (!hasStoredApiToken()) {
      setLoading(false);
      return;
    }
    // Re-resolve identity from the persisted token on page refresh.
    const token = localStorage.getItem('bitgo-agent-wallet:apiToken');
    if (!token) {
      setLoading(false);
      return;
    }
    client
      .authenticate(token)
      .then((id) => setIdentity(id))
      .catch(() => clearApiToken())
      .finally(() => setLoading(false));
  }, []);

  return <AuthContext.Provider value={{ identity, loading, error, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
