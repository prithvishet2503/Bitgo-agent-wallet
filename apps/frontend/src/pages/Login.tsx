import { useState, type FormEvent, type ReactElement } from 'react';
import { useAuth } from '../context/AuthContext';

const DEMO_USERS = [
  { label: 'Ava Admin', token: 'demo-admin-token', role: 'admin' },
  { label: 'Cole Compliance', token: 'demo-compliance-token', role: 'compliance' },
  { label: 'Devon Developer', token: 'demo-dev-token', role: 'developer' },
  { label: 'Vera Viewer', token: 'demo-viewer-token', role: 'viewer' },
];

export function Login(): ReactElement {
  const { login, error } = useAuth();
  const [apiToken, setApiToken] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login(apiToken);
    } catch {
      // error surfaced via context
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>BitGo Agent Wallet</h1>
        <p className="subtitle">Institutional console - Section 6.7 `authenticate`</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="apiToken">API token</label>
          <input
            id="apiToken"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="demo-admin-token"
            autoFocus
          />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" disabled={submitting || !apiToken}>
            {submitting ? 'Authenticating...' : 'Authenticate'}
          </button>
        </form>
        <div className="demo-users">
          <p>Demo identities (Section 3 personas):</p>
          <div className="demo-user-grid">
            {DEMO_USERS.map((u) => (
              <button key={u.token} className="demo-user-btn" onClick={() => setApiToken(u.token)} type="button">
                <strong>{u.label}</strong>
                <span>{u.role}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
