import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import type {
  AgentSubWallet,
  AutonomyMode,
  IncomingTransaction,
  Pact,
  SubWalletRiskSummary,
  TransactionRecord,
} from '@bitgo-agent-wallet/sdk';
import { client } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { useAuth } from '../context/AuthContext';

type BalanceSummary = Awaited<ReturnType<typeof client.getBalance>>;

export function SubWalletDetail(): ReactElement {
  const { id = '' } = useParams();
  const { identity } = useAuth();
  const canManage = identity?.role === 'admin' || identity?.role === 'compliance';

  const [subWallet, setSubWallet] = useState<AgentSubWallet | null>(null);
  const [balance, setBalance] = useState<BalanceSummary | null>(null);
  const [pact, setPact] = useState<Pact | null>(null);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [incoming, setIncoming] = useState<IncomingTransaction[]>([]);
  const [riskSummary, setRiskSummary] = useState<SubWalletRiskSummary | null>(null);

  async function refreshAll(): Promise<void> {
    const [sw, bal, txs, inc, risk] = await Promise.all([
      client.getAgentSubWallet(id),
      client.getBalance(id),
      client.listTransactions(id),
      client.listQuarantined().then((all) => all.filter((t) => t.subWalletId === id)),
      client.getRiskSummary(id).catch(() => null),
    ]);
    setSubWallet(sw);
    setBalance(bal);
    setTransactions(txs);
    setIncoming(inc);
    setPact(await client.getPactForSubWallet(id));
    setRiskSummary(risk);
  }

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!subWallet) return <p>Loading...</p>;

  async function handleSuspend(): Promise<void> {
    await client.revoke(id, 'Suspended via console');
    await refreshAll();
  }

  async function handleAutonomyChange(mode: AutonomyMode): Promise<void> {
    await client.setAutonomyMode(id, mode);
    await refreshAll();
  }

  async function handleDelegate(): Promise<void> {
    await client.delegateEip7702(id);
    await refreshAll();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{subWallet.agentName}</h1>
          <p className="page-subtitle mono">
            {subWallet.pendingDeployment ? 'Deploying on-chain smart account...' : subWallet.address}
          </p>
        </div>
        <div className="header-actions">
          {subWallet.pendingDeployment && <StatusBadge value="pending" />}
          <StatusBadge value={subWallet.status} />
          <StatusBadge value={subWallet.autonomyMode} />
        </div>
      </div>

      <div className="grid-3">
        <div className="card">
          <h3>Balance</h3>
          {balance && (
            <ul className="kv-list">
              <li>
                <span>Available</span>
                <strong>${balance.availableUsd.toLocaleString()}</strong>
              </li>
              <li>
                <span>Spent</span>
                <span>${balance.spentUsd.toLocaleString()}</span>
              </li>
              <li>
                <span>Quarantined</span>
                <span>${balance.quarantinedUsd.toLocaleString()}</span>
              </li>
              <li>
                <span>Funding source</span>
                <span>{balance.fundingSource}</span>
              </li>
            </ul>
          )}
        </div>

        <div className="card">
          <h3>Governance controls</h3>
          <p className="hint">Section 6.4 / 6.6 - admin/compliance only</p>
          <label>
            Autonomy mode
            <select
              value={subWallet.autonomyMode}
              disabled={!canManage || subWallet.status === 'suspended'}
              onChange={(e) => handleAutonomyChange(e.target.value as AutonomyMode)}
            >
              <option value="strict">Strict</option>
              <option value="bounded_auto">Bounded Auto</option>
            </select>
          </label>
          <button
            className="danger-btn"
            disabled={!canManage || subWallet.status === 'suspended'}
            onClick={handleSuspend}
            type="button"
          >
            Emergency stop (kill switch)
          </button>
        </div>

        <div className="card">
          <h3>Risk score</h3>
          <p className="hint">Section 5.2 / 12.4 - risk-grading engine</p>
          {riskSummary ? (
            <ul className="kv-list">
              <li>
                <span>Trust score</span>
                <strong>
                  <span className={`risk-score-${riskSummary.trustScore.score >= 70 ? 'low' : riskSummary.trustScore.score >= 40 ? 'medium' : 'high'}`}>
                    {riskSummary.trustScore.score}/100
                  </span>
                </strong>
              </li>
              <li>
                <span>Transactions</span>
                <span>{riskSummary.trustScore.totalTransactions}</span>
              </li>
              <li>
                <span>Clean auto-executes</span>
                <span>{riskSummary.trustScore.cleanAutoExecutes}</span>
              </li>
              <li>
                <span>Policy violations</span>
                <span>{riskSummary.trustScore.policyViolations}</span>
              </li>
              <li>
                <span>Screening flags</span>
                <span>{riskSummary.trustScore.screeningFlags}</span>
              </li>
              <li>
                <span>Quarantine events</span>
                <span>{riskSummary.trustScore.quarantineEvents}</span>
              </li>
              {riskSummary.recentAssessments.length > 0 && (
                <li>
                  <span>Last risk tier</span>
                  <span>
                    <StatusBadge value={riskSummary.recentAssessments[0].tier} />
                    {' '}({riskSummary.recentAssessments[0].overallScore})
                  </span>
                </li>
              )}
            </ul>
          ) : (
            <p className="hint">No risk data yet</p>
          )}
        </div>

        <div className="card">
          <h3>Gas sponsorship (EIP-7702)</h3>
          <p className="hint">Section 6.10</p>
          {subWallet.eip7702Delegated ? (
            <StatusBadge value="active" />
          ) : (
            <button className="secondary-btn" onClick={handleDelegate} type="button">
              Delegate to paymaster
            </button>
          )}
        </div>
      </div>

      <PactPanel subWalletId={id} pact={pact} canManage={canManage} onChange={refreshAll} />

      <SendTransactionPanel subWalletId={id} onSubmitted={refreshAll} disabled={subWallet.status === 'suspended'} />

      <div className="card">
        <h3>Transactions</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>To</th>
              <th>Value</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Sponsored</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.createdAt).toLocaleString()}</td>
                <td className="mono">{t.request.to}</td>
                <td>${t.request.valueUsd.toLocaleString()}</td>
                <td>
                  {t.riskAssessment ? (
                    <span className={`risk-badge-${t.riskAssessment.tier}`}>
                      {t.riskAssessment.tier} ({t.riskAssessment.overallScore})
                    </span>
                  ) : (
                    <span className="hint">&mdash;</span>
                  )}
                </td>
                <td>
                  <StatusBadge value={t.status} />
                  {t.policyViolations.length > 0 && (
                    <div className="violation-list">
                      {t.policyViolations.map((v) => (
                        <div key={v.code} className="violation">
                          {v.message}
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>{t.gasSponsored ? 'Yes' : '-'}</td>
              </tr>
            ))}
            {transactions.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-row">
                  No transactions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <IncomingPanel subWalletId={id} incoming={incoming} canManage={canManage} onChange={refreshAll} />
    </div>
  );
}

function PactPanel({
  subWalletId,
  pact,
  canManage,
  onChange,
}: {
  subWalletId: string;
  pact: Pact | null;
  canManage: boolean;
  onChange: () => Promise<void>;
}): ReactElement {
  const [maxTxValue, setMaxTxValue] = useState(pact?.maxTransactionValueUsd ?? 5000);
  const [dailyCap, setDailyCap] = useState(pact?.dailySpendCapUsd ?? 20000);

  useEffect(() => {
    setMaxTxValue(pact?.maxTransactionValueUsd ?? 5000);
    setDailyCap(pact?.dailySpendCapUsd ?? 20000);
  }, [pact]);

  async function handleCreateOrUpdate(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (pact) {
      await client.updatePact(pact.id, { subWalletId, maxTransactionValueUsd: maxTxValue, dailySpendCapUsd: dailyCap });
    } else {
      await client.createPact({
        subWalletId,
        maxTransactionValueUsd: maxTxValue,
        dailySpendCapUsd: dailyCap,
        weeklySpendCapUsd: dailyCap * 7,
        contractAllowlist: [],
        protocolAllowlist: [],
        networkAllowlist: [],
        destinationAllowlist: [],
        destinationDenylist: [],
        sessionExpiresAt: null,
        gasSponsorshipCapUsdPerTx: null,
        gasSponsorshipCapUsdPerDay: null,
        gasSponsorshipFallback: 'own_balance',
      });
    }
    await onChange();
  }

  return (
    <div className="card">
      <h3>Pact (policy)</h3>
      <p className="hint">Section 6.2 - admin/compliance only</p>
      {canManage ? (
        <form onSubmit={handleCreateOrUpdate} className="inline-form">
          <label>
            Max TX value (USD)
            <input type="number" value={maxTxValue} onChange={(e) => setMaxTxValue(Number(e.target.value))} min={0} />
          </label>
          <label>
            Daily cap (USD)
            <input type="number" value={dailyCap} onChange={(e) => setDailyCap(Number(e.target.value))} min={0} />
          </label>
          <button className="primary-btn" type="submit">
            {pact ? 'Update pact' : 'Create pact'}
          </button>
        </form>
      ) : pact ? (
        <ul className="kv-list">
          <li>
            <span>Max TX value</span>
            <span>${pact.maxTransactionValueUsd.toLocaleString()}</span>
          </li>
          <li>
            <span>Daily cap</span>
            <span>${pact.dailySpendCapUsd.toLocaleString()}</span>
          </li>
          <li>
            <span>Weekly cap</span>
            <span>${pact.weeklySpendCapUsd.toLocaleString()}</span>
          </li>
        </ul>
      ) : (
        <p className="hint">No Pact configured. An admin/compliance user must create one before this wallet can transact.</p>
      )}
    </div>
  );
}

function SendTransactionPanel({
  subWalletId,
  onSubmitted,
  disabled,
}: {
  subWalletId: string;
  onSubmitted: () => Promise<void>;
  disabled: boolean;
}): ReactElement {
  const [to, setTo] = useState('0xdest1');
  const [valueUsd, setValueUsd] = useState(100);
  const [submitting, setSubmitting] = useState(false);

  async function handleSend(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      await client.send({ subWalletId, to, valueUsd, network: 'ethereum-mainnet', contractAddress: null, protocol: null, functionDescription: 'transfer' });
      await onSubmitted();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Send transaction (demo)</h3>
      <p className="hint">Submit an agent-initiated transaction through the full governance pipeline (Sections 6.3-6.5)</p>
      <form onSubmit={handleSend} className="inline-form">
        <label>
          To
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x... or 0xdest1 (demo)"
            disabled={disabled || submitting}
          />
        </label>
        <label>
          Value (USD)
          <input
            type="number"
            value={valueUsd}
            onChange={(e) => setValueUsd(Number(e.target.value))}
            min={0}
            disabled={disabled || submitting}
          />
        </label>
        <button className="primary-btn" type="submit" disabled={disabled || submitting}>
          {submitting ? 'Submitting...' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function IncomingPanel({
  subWalletId,
  incoming,
  canManage,
  onChange,
}: {
  subWalletId: string;
  incoming: IncomingTransaction[];
  canManage: boolean;
  onChange: () => Promise<void>;
}): ReactElement {
  const filtered = incoming.filter((t) => t.subWalletId === subWalletId);

  async function handleRelease(incomingTransactionId: string): Promise<void> {
    await client.releaseQuarantine({ incomingTransactionId, note: 'Released via console' });
    await onChange();
  }

  if (filtered.length === 0) return <></>;

  return (
    <div className="card">
      <h3>Incoming transactions</h3>
      <p className="hint">Section 6.9 - screening happens post-confirmation</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>From</th>
            <th>Value</th>
            <th>Verdict</th>
            <th>Quarantine</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((t) => (
            <tr key={t.id}>
              <td className="mono">{t.fromAddress}</td>
              <td>${t.valueUsd.toLocaleString()}</td>
              <td>
                <StatusBadge value={t.screeningVerdict} />
              </td>
              <td>{t.quarantine ? <StatusBadge value={t.quarantine.status} /> : '-'}</td>
              <td>
                {t.quarantine?.status === 'quarantined' && canManage && (
                  <button className="secondary-btn" onClick={() => handleRelease(t.id)} type="button">
                    Release
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
