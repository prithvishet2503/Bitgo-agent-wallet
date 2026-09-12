import { useEffect, useState, type ReactElement } from 'react';
import type { ApprovalRequest } from '@bitgo-agent-wallet/sdk';
import { client } from '../api/client';
import { useAuth } from '../context/AuthContext';

/** Section 6.5 - Human Approval Flow (web console channel). */
export function Approvals(): ReactElement {
  const { identity } = useAuth();
  const canDecide = identity?.role === 'admin' || identity?.role === 'compliance';
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setApprovals(await client.listPendingApprovals());
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, []);

  async function decide(id: string, decision: 'approve' | 'deny'): Promise<void> {
    setBusyId(id);
    try {
      await client.decideApproval(id, decision);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Pending Approvals</h1>
          <p className="page-subtitle">
            Section 6.5 - typed, human-readable payload (EIP-712 style); deny-on-timeout after 15 minutes.
          </p>
        </div>
      </div>

      {approvals.length === 0 && <div className="card empty-row">Nothing awaiting approval.</div>}

      {approvals.map((a) => (
        <div className="card approval-card" key={a.id}>
          <div className="approval-header">
            <div>
              <strong>{a.typedPayload.message.agentName}</strong> wants to{' '}
              <em>{a.typedPayload.message.functionDescription}</em>
            </div>
            <span className="hint">expires {new Date(a.timeoutAt).toLocaleTimeString()}</span>
          </div>
          <ul className="kv-list">
            <li>
              <span>To</span>
              <span className="mono">{a.typedPayload.message.to}</span>
            </li>
            <li>
              <span>Value</span>
              <strong>${a.typedPayload.message.valueUsd.toLocaleString()}</strong>
            </li>
            <li>
              <span>Network</span>
              <span>{a.typedPayload.message.network}</span>
            </li>
            <li>
              <span>Est. fee</span>
              <span>${a.typedPayload.message.estimatedFeeUsd}</span>
            </li>
            <li>
              <span>Approvals</span>
              <span>
                {a.approvals.length} / {a.requiredApprovals} required
              </span>
            </li>
          </ul>
          {canDecide && (
            <div className="approval-actions">
              <button className="primary-btn" disabled={busyId === a.id} onClick={() => decide(a.id, 'approve')} type="button">
                Approve
              </button>
              <button className="danger-btn" disabled={busyId === a.id} onClick={() => decide(a.id, 'deny')} type="button">
                Deny
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
