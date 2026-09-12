import { useState, type FormEvent, type ReactElement } from 'react';
import { useAuth } from '../context/AuthContext';

const DEMO_USERS = [
  { label: 'Ava Admin', token: 'demo-admin-token', role: 'admin' },
  { label: 'Cole Compliance', token: 'demo-compliance-token', role: 'compliance' },
  { label: 'Devon Developer', token: 'demo-dev-token', role: 'developer' },
  { label: 'Vera Viewer', token: 'demo-viewer-token', role: 'viewer' },
];

export function Login(): ReactElement {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>BitGo Agent Wallet</h1>
        <p className="subtitle">
          {mode === 'sign-in' ? 'Institutional console - Section 6.7 `authenticate`' : 'Create your Organization'}
        </p>
        <div className="login-tabs">
          <button type="button" className={mode === 'sign-in' ? 'active' : ''} onClick={() => setMode('sign-in')}>
            Sign in
          </button>
          <button type="button" className={mode === 'sign-up' ? 'active' : ''} onClick={() => setMode('sign-up')}>
            Create organization
          </button>
        </div>
        {mode === 'sign-in' ? <SignInForm /> : <SignUpForm />}
      </div>
    </div>
  );
}

function SignInForm(): ReactElement {
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
    <>
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
    </>
  );
}

function SignUpForm(): ReactElement {
  const { signUp, error } = useAuth();
  const [organizationName, setOrganizationName] = useState('');
  const [enterpriseName, setEnterpriseName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      await signUp({ organizationName, enterpriseName, adminName });
    } catch {
      // error surfaced via context
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="orgName">Organization name</label>
      <input id="orgName" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} required autoFocus />
      <label htmlFor="entName">First Enterprise name</label>
      <input id="entName" value={enterpriseName} onChange={(e) => setEnterpriseName(e.target.value)} required />
      <label htmlFor="adminName">Your name (admin)</label>
      <input id="adminName" value={adminName} onChange={(e) => setAdminName(e.target.value)} required />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={submitting || !organizationName || !enterpriseName || !adminName}>
        {submitting ? 'Creating...' : 'Create organization'}
      </button>
      <p className="hint">
        Creates an Organization, a first Enterprise, and an admin user with a fresh API token - one call, no separate
        signup step (Organization -&gt; Enterprise -&gt; Wallet hierarchy).
      </p>
    </form>
  );
}
