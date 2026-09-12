import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import type {
  AgentSubWallet,
  AutonomyMode,
  IncomingTransaction,
  Pact,
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

  async function refreshAll(): Promise<void> {
    const [sw, bal, txs, inc] = await Promise.all([
      client.getAgentSubWallet(id),
      client.getBalance(id),
      client.listTransactions(id),
      client.listQuarantined().then((all) => all.filter((t) => t.subWalletId === id)),
    ]);
    setSubWallet(sw);
    setBalance(bal);
    setTransactions(txs);
    setIncoming(inc);
    setPact(await client.getPactForSubWallet(id));
  }

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 4000); // pick up async approval decisions/timeouts
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
                <td colSpan={5} className="empty-row">
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
  const [maxTx, setMaxTx] = useState(pact?.maxTransactionValueUsd ?? 1000);
  const [dailyCap, setDailyCap] = useState(pact?.dailySpendCapUsd ?? 5000);
  const [weeklyCap, setWeeklyCap] = useState(pact?.weeklySpendCapUsd ?? 20000);
  const [networkAllowlist, setNetworkAllowlist] = useState(pact?.networkAllowlist.join(',') ?? 'ethereum-mainnet');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (pact) {
      setMaxTx(pact.maxTransactionValueUsd);
      setDailyCap(pact.dailySpendCapUsd);
      setWeeklyCap(pact.weeklySpendCapUsd);
      setNetworkAllowlist(pact.networkAllowlist.join(','));
    }
  }, [pact]);

  async function handleSave(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    const networkAllowlistArr = networkAllowlist
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      if (pact) {
        await client.updatePact(pact.id, {
          maxTransactionValueUsd: maxTx,
          dailySpendCapUsd: dailyCap,
          weeklySpendCapUsd: weeklyCap,
          networkAllowlist: networkAllowlistArr,
        });
      } else {
        await client.createPact({
          subWalletId,
          maxTransactionValueUsd: maxTx,
          dailySpendCapUsd: dailyCap,
          weeklySpendCapUsd: weeklyCap,
          contractAllowlist: [],
          protocolAllowlist: [],
          networkAllowlist: networkAllowlistArr,
          destinationAllowlist: [],
          destinationDenylist: [],
          sessionExpiresAt: null,
          gasSponsorshipCapUsdPerTx: null,
          gasSponsorshipCapUsdPerDay: null,
          gasSponsorshipFallback: 'own_balance',
        });
      }
      await onChange();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h3>Pact (policy)</h3>
      <p className="hint">Section 6.2 - editable only by admin/compliance; agents cannot self-modify.</p>
      <form className="form-row" onSubmit={handleSave}>
        <label>
          Max tx value ($)
          <input type="number" value={maxTx} disabled={!canManage} onChange={(e) => setMaxTx(Number(e.target.value))} />
        </label>
        <label>
          Daily cap ($)
          <input type="number" value={dailyCap} disabled={!canManage} onChange={(e) => setDailyCap(Number(e.target.value))} />
        </label>
        <label>
          Weekly cap ($)
          <input type="number" value={weeklyCap} disabled={!canManage} onChange={(e) => setWeeklyCap(Number(e.target.value))} />
        </label>
        <label>
          Network allowlist
          <input value={networkAllowlist} disabled={!canManage} onChange={(e) => setNetworkAllowlist(e.target.value)} />
        </label>
        {canManage && (
          <button className="primary-btn" type="submit" disabled={saving}>
            {pact ? 'Update Pact' : 'Create Pact'}
          </button>
        )}
      </form>
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
  const [to, setTo] = useState('');
  const [valueUsd, setValueUsd] = useState(100);
  const [functionDescription, setFunctionDescription] = useState('transfer');
  const [result, setResult] = useState<TransactionRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSend(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const tx = await client.send({
        subWalletId,
        to,
        valueUsd,
        network: 'ethereum-mainnet',
        contractAddress: null,
        protocol: null,
        functionDescription,
      });
      setResult(tx);
      await onSubmitted();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Submit agent transaction</h3>
      <p className="hint">Section 6.3-6.5 pipeline: simulate -&gt; screen -&gt; policy -&gt; autonomy-mode routing.</p>
      <form className="form-row" onSubmit={handleSend}>
        <label>
          Destination
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x... (try 0xsanctioned0001)" required />
        </label>
        <label>
          Value (USD)
          <input type="number" value={valueUsd} onChange={(e) => setValueUsd(Number(e.target.value))} />
        </label>
        <label>
          Description
          <input value={functionDescription} onChange={(e) => setFunctionDescription(e.target.value)} />
        </label>
        <button className="primary-btn" type="submit" disabled={submitting || disabled}>
          {submitting ? 'Submitting...' : 'Send'}
        </button>
      </form>
      {result && (
        <div className="notice">
          Result: <StatusBadge value={result.status} />{' '}
          {result.status === 'pending_approval' && 'Sent to the Approvals queue.'}
        </div>
      )}
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
  const [fromAddress, setFromAddress] = useState('');
  const [valueUsd, setValueUsd] = useState(500);
  const [submitting, setSubmitting] = useState(false);

  async function handleSimulate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      await client.simulateIncoming({ subWalletId, fromAddress, valueUsd, network: 'ethereum-mainnet' });
      setFromAddress('');
      await onChange();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRelease(incomingTransactionId: string): Promise<void> {
    await client.releaseQuarantine({ incomingTransactionId, note: 'Released via console' });
    await onChange();
  }

  return (
    <div className="card">
      <h3>Incoming transactions</h3>
      <p className="hint">Section 6.9 - screened after confirmation; flagged funds are quarantined.</p>
      <form className="form-row" onSubmit={handleSimulate}>
        <label>
          From address
          <input
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="0x... (try 0xsanctioned0001)"
            required
          />
        </label>
        <label>
          Value (USD)
          <input type="number" value={valueUsd} onChange={(e) => setValueUsd(Number(e.target.value))} />
        </label>
        <button className="secondary-btn" type="submit" disabled={submitting}>
          Record incoming confirmation
        </button>
      </form>
      <table className="data-table">
        <thead>
          <tr>
            <th>Confirmed</th>
            <th>From</th>
            <th>Value</th>
            <th>Screening</th>
            <th>Quarantine</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {incoming.map((t) => (
            <tr key={t.id}>
              <td>{new Date(t.confirmedAt).toLocaleString()}</td>
              <td className="mono">{t.fromAddress}</td>
              <td>${t.valueUsd.toLocaleString()}</td>
              <td>
                <StatusBadge value={t.screeningVerdict} /> {t.screeningReason !== 'NONE' && `(${t.screeningReason})`}
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
          {incoming.length === 0 && (
            <tr>
              <td colSpan={6} className="empty-row">
                No incoming transactions recorded.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
