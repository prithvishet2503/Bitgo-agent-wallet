import { createContext, useCallback, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { AuthenticatedIdentity, CreateOrganizationInput } from '@bitgo-agent-wallet/sdk';
import { client, clearSession, hasStoredApiToken, persistApiToken, persistEnterpriseId } from '../api/client';

interface AuthContextValue {
  identity: AuthenticatedIdentity | null;
  /** Which Enterprise the console is currently acting on - may differ from
   * `identity.enterpriseId` (the home enterprise) once the user switches. */
  currentEnterpriseId: string | null;
  loading: boolean;
  error: string | null;
  login: (apiToken: string) => Promise<void>;
  signUp: (input: CreateOrganizationInput) => Promise<void>;
  switchEnterprise: (enterpriseId: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** The console's session identity. Wraps `authenticate` (Section 6.7) and the
 * Organization bootstrap flow so every page can read the current user's role and
 * active Enterprise without re-fetching. */
export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [identity, setIdentity] = useState<AuthenticatedIdentity | null>(null);
  const [currentEnterpriseId, setCurrentEnterpriseId] = useState<string | null>(
    localStorage.getItem('bitgo-agent-wallet:enterpriseId'),
  );
  const [loading, setLoading] = useState(hasStoredApiToken());
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (apiToken: string) => {
    setLoading(true);
    setError(null);
    try {
      const id = await client.authenticate(apiToken);
      persistApiToken(id.apiToken);
      persistEnterpriseId(id.enterpriseId);
      setCurrentEnterpriseId(id.enterpriseId);
      setIdentity(id);
    } catch {
      setError('Invalid API token');
      throw new Error('Invalid API token');
    } finally {
      setLoading(false);
    }
  }, []);

  const signUp = useCallback(async (input: CreateOrganizationInput) => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.createOrganization(input);
      persistApiToken(result.apiToken);
      persistEnterpriseId(result.enterprise.id);
      setCurrentEnterpriseId(result.enterprise.id);
      const id = await client.authenticate(result.apiToken); // fetch the full identity shape
      setIdentity(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create organization');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const switchEnterprise = useCallback(
    (enterpriseId: string) => {
      if (!identity?.accessibleEnterpriseIds.includes(enterpriseId)) return;
      persistEnterpriseId(enterpriseId);
      setCurrentEnterpriseId(enterpriseId);
    },
    [identity],
  );

  const logout = useCallback(() => {
    clearSession();
    setIdentity(null);
    setCurrentEnterpriseId(null);
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
      .then((id) => {
        setIdentity(id);
        setCurrentEnterpriseId((prev) => prev ?? id.enterpriseId);
      })
      .catch(() => clearSession())
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ identity, currentEnterpriseId, loading, error, login, signUp, switchEnterprise, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
