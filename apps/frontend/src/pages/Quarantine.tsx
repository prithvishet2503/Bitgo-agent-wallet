import { useEffect, useState, type ReactElement } from 'react';
import type { AgentSubWallet, IncomingTransaction } from '@bitgo-agent-wallet/sdk';
import { client } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { useAuth } from '../context/AuthContext';

/** Section 6.9 - Incoming Transaction Screening: quarantine review queue. */
export function Quarantine(): ReactElement {
  const { identity } = useAuth();
  const canRelease = identity?.role === 'admin' || identity?.role === 'compliance';
  const [items, setItems] = useState<IncomingTransaction[]>([]);
  const [subWallets, setSubWallets] = useState<Record<string, AgentSubWallet>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  async function refresh(): Promise<void> {
    const [quarantined, wallets] = await Promise.all([client.listQuarantined(), client.listAgentSubWallets()]);
    setItems(quarantined);
    setSubWallets(Object.fromEntries(wallets.map((w) => [w.id, w])));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function release(id: string): Promise<void> {
    setBusyId(id);
    try {
      await client.releaseQuarantine({ incomingTransactionId: id, note: note || null });
      setNote('');
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Incoming Quarantine</h1>
          <p className="page-subtitle">
            Section 6.9 - flagged incoming funds are excluded from spendable balance until explicit compliance/admin
            release. An agent cannot self-authorize release regardless of autonomy mode.
          </p>
        </div>
      </div>

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Confirmed</th>
              <th>Agent sub-wallet</th>
              <th>From</th>
              <th>Value</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.confirmedAt).toLocaleString()}</td>
                <td>{subWallets[t.subWalletId]?.agentName ?? t.subWalletId}</td>
                <td className="mono">{t.fromAddress}</td>
                <td>${t.valueUsd.toLocaleString()}</td>
                <td>
                  <StatusBadge value={t.screeningReason} />
                </td>
                <td>
                  {canRelease && (
                    <button className="secondary-btn" disabled={busyId === t.id} onClick={() => release(t.id)} type="button">
                      Release
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-row">
                  Nothing quarantined.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {canRelease && items.length > 0 && (
          <div className="release-note-row">
            <label>
              Release note
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional compliance note" />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
