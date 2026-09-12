import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { AgentSubWallet, AutonomyMode, SupportedChain } from '@bitgo-agent-wallet/sdk';
import { client } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { useAuth } from '../context/AuthContext';

/** Section 6.1 - Agent Sub-Wallet Creation. */
export function SubWallets(): ReactElement {
  const { identity } = useAuth();
  const [subWallets, setSubWallets] = useState<AgentSubWallet[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agentName, setAgentName] = useState('');
  const [chain, setChain] = useState<SupportedChain>('ethereum-mainnet');
  const [allocatedBalanceUsd, setAllocatedBalanceUsd] = useState(10000);
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>('strict');
  const [submitting, setSubmitting] = useState(false);

  async function refresh(): Promise<void> {
    setSubWallets(await client.listAgentSubWallets());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await client.createAgentSubWallet({
        agentName,
        chain,
        fundingSource: 'allocated_balance',
        allocatedBalanceUsd,
        drawDownLimitUsd: null,
        autonomyMode,
      });
      setAgentName('');
      setShowCreate(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent sub-wallet');
    } finally {
      setSubmitting(false);
    }
  }

  const canCreate = identity?.role === 'admin' || identity?.role === 'compliance' || identity?.role === 'developer';

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Agent Sub-Wallets</h1>
          <p className="page-subtitle">Section 6.1 - a distinct wallet scoped to a single agent identity.</p>
        </div>
        {canCreate && (
          <button className="primary-btn" onClick={() => setShowCreate((v) => !v)} type="button">
            {showCreate ? 'Cancel' : '+ New agent sub-wallet'}
          </button>
        )}
      </div>

      {showCreate && (
        <form className="card form-card" onSubmit={handleCreate}>
          <div className="form-row">
            <label>
              Agent name
              <input value={agentName} onChange={(e) => setAgentName(e.target.value)} required />
            </label>
            <label>
              Chain
              <select value={chain} onChange={(e) => setChain(e.target.value as SupportedChain)}>
                <option value="ethereum-mainnet">Ethereum mainnet</option>
                <option value="base">Base</option>
                <option value="optimism">Optimism</option>
                <option value="arbitrum">Arbitrum</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Allocated balance (USD)
              <input
                type="number"
                min={0}
                value={allocatedBalanceUsd}
                onChange={(e) => setAllocatedBalanceUsd(Number(e.target.value))}
              />
            </label>
            <label>
              Autonomy mode
              <select value={autonomyMode} onChange={(e) => setAutonomyMode(e.target.value as AutonomyMode)}>
                <option value="strict">Strict (every tx requires approval)</option>
                <option value="bounded_auto">Bounded Auto (auto-execute within policy)</option>
              </select>
            </label>
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="primary-btn" type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create agent sub-wallet'}
          </button>
        </form>
      )}

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Chain</th>
              <th>Autonomy</th>
              <th>Status</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {subWallets?.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link to={`/sub-wallets/${w.id}`}>{w.agentName}</Link>
                </td>
                <td>{w.chain}</td>
                <td>
                  <StatusBadge value={w.autonomyMode} />
                </td>
                <td>
                  <StatusBadge value={w.status} />
                </td>
                <td className="mono">{w.address}</td>
              </tr>
            ))}
            {subWallets?.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-row">
                  No agent sub-wallets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
