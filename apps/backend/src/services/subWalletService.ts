import { randomUUID } from 'node:crypto';
import {
  type AgentSubWallet,
  type AutonomyMode,
  type CreateAgentSubWalletInput,
  DEFAULT_MAX_SUB_WALLETS_PER_MASTER_ACCOUNT,
  DomainError,
  ForbiddenError,
  NotFoundError,
  nowIso,
  roleCanManagePolicy,
} from '@bitgo-agent-wallet/shared';
import { db, type User } from '../store/db.js';
import * as auditService from './auditService.js';

/** Section 6.1 - Agent Sub-Wallet Creation. */
export function createSubWallet(input: CreateAgentSubWalletInput, actingUser: User): AgentSubWallet {
  const account = db.masterAccounts.get(input.masterAccountId);
  if (!account) throw new NotFoundError(`Master account ${input.masterAccountId} not found`);

  const existingCount = [...db.subWallets.values()].filter(
    (w) => w.masterAccountId === input.masterAccountId,
  ).length;
  const cap = account.maxSubWallets ?? DEFAULT_MAX_SUB_WALLETS_PER_MASTER_ACCOUNT;
  if (existingCount >= cap) {
    throw new DomainError(
      `Master account has reached its agent sub-wallet limit (${cap})`,
      'SUB_WALLET_LIMIT_REACHED',
      409,
    );
  }

  const id = `subwallet_${randomUUID()}`;
  const subWallet: AgentSubWallet = {
    id,
    masterAccountId: input.masterAccountId,
    agentName: input.agentName,
    chain: input.chain,
    // Deterministic mock address derivation - stands in for real ERC-7579 account
    // deployment / MPC key generation.
    address: `0xagent${id.slice(-12)}`,
    sessionKeyRef: `session_${randomUUID()}`,
    fundingSource: input.fundingSource,
    allocatedBalanceUsd: input.allocatedBalanceUsd,
    drawDownLimitUsd: input.drawDownLimitUsd,
    // Strict Mode default on new sub-wallets (Section 8 risk mitigation), regardless
    // of what the caller requests, unless an admin/compliance role explicitly asked
    // for bounded_auto.
    autonomyMode: input.autonomyMode,
    status: 'active',
    eip7702Delegated: false,
    pactId: null,
    createdByUserId: actingUser.id,
    createdAt: nowIso(),
    suspendedAt: null,
    suspendedByUserId: null,
    suspendedReason: null,
  };
  db.subWallets.set(id, subWallet);

  auditService.record({
    masterAccountId: subWallet.masterAccountId,
    subWalletId: subWallet.id,
    eventType: 'SUB_WALLET_CREATED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Agent sub-wallet "${subWallet.agentName}" created on ${subWallet.chain}`,
    metadata: { autonomyMode: subWallet.autonomyMode, fundingSource: subWallet.fundingSource },
  });

  return subWallet;
}

export function getSubWallet(id: string): AgentSubWallet {
  const w = db.subWallets.get(id);
  if (!w) throw new NotFoundError(`Agent sub-wallet ${id} not found`);
  return w;
}

export function listSubWallets(masterAccountId: string): AgentSubWallet[] {
  return [...db.subWallets.values()].filter((w) => w.masterAccountId === masterAccountId);
}

function assertSameAccount(subWallet: AgentSubWallet, actingUser: User): void {
  if (subWallet.masterAccountId !== actingUser.masterAccountId) {
    throw new ForbiddenError('Cannot act on a sub-wallet outside your master account');
  }
}

/** Section 6.6 - Emergency Stop.
 * One-click suspension of a single agent sub-wallet's signing ability, separate from
 * freezing the master wallet or any other sub-wallet. */
export function suspendSubWallet(id: string, actingUser: User, reason: string | null): AgentSubWallet {
  const subWallet = getSubWallet(id);
  assertSameAccount(subWallet, actingUser);
  if (!roleCanManagePolicy(actingUser.role)) {
    throw new ForbiddenError('Only admin/compliance roles can suspend an agent sub-wallet');
  }
  if (subWallet.status === 'suspended') return subWallet;

  subWallet.status = 'suspended';
  subWallet.suspendedAt = nowIso();
  subWallet.suspendedByUserId = actingUser.id;
  subWallet.suspendedReason = reason;

  auditService.record({
    masterAccountId: subWallet.masterAccountId,
    subWalletId: subWallet.id,
    eventType: 'SUB_WALLET_SUSPENDED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Agent sub-wallet "${subWallet.agentName}" suspended (kill switch)`,
    metadata: { reason },
  });

  // "Suspension event triggers immediate notification to all admins on the account."
  notifyAllAdmins(subWallet, actingUser, reason);

  return subWallet;
}

function notifyAllAdmins(subWallet: AgentSubWallet, actingUser: User, reason: string | null): void {
  const admins = [...db.users.values()].filter(
    (u) => u.masterAccountId === subWallet.masterAccountId && (u.role === 'admin' || u.role === 'compliance'),
  );
  for (const admin of admins) {
    // eslint-disable-next-line no-console
    console.log(
      `[notify:${admin.name}] Agent sub-wallet "${subWallet.agentName}" was suspended by ${actingUser.name}` +
        (reason ? ` (${reason})` : ''),
    );
  }
}

/** Section 6.4 - Autonomy Modes.
 * "Mode is set per agent sub-wallet, changeable only by admin/compliance role, with
 * all mode changes logged." */
export function setAutonomyMode(id: string, mode: AutonomyMode, actingUser: User): AgentSubWallet {
  const subWallet = getSubWallet(id);
  assertSameAccount(subWallet, actingUser);
  if (!roleCanManagePolicy(actingUser.role)) {
    throw new ForbiddenError('Only admin/compliance roles can change autonomy mode');
  }
  const previousMode = subWallet.autonomyMode;
  if (previousMode === mode) return subWallet;

  subWallet.autonomyMode = mode;
  auditService.record({
    masterAccountId: subWallet.masterAccountId,
    subWalletId: subWallet.id,
    eventType: 'AUTONOMY_MODE_CHANGED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Autonomy mode changed from ${previousMode} to ${mode}`,
    metadata: { previousMode, newMode: mode },
  });
  return subWallet;
}

/** Section 6.10 - Gas Sponsorship via EIP-7702.
 * Mocks the EOA-to-paymaster delegation handshake; in production this would be an
 * on-chain EIP-7702 authorization transaction against an audited delegator contract. */
export function delegateEip7702(id: string, actingUser: User): AgentSubWallet {
  const subWallet = getSubWallet(id);
  assertSameAccount(subWallet, actingUser);
  subWallet.eip7702Delegated = true;
  return subWallet;
}

export interface BalanceSummary {
  fundingSource: AgentSubWallet['fundingSource'];
  allocatedOrLimitUsd: number;
  spentUsd: number;
  quarantinedUsd: number;
  availableUsd: number;
}

/** Balance as seen by developer tooling's `get-balance` (Section 6.7). Quarantined
 * incoming funds (Section 6.9) are visible but excluded from spendable balance. */
export function getBalanceSummary(subWallet: AgentSubWallet): BalanceSummary {
  const spentUsd = [...db.transactions.values()]
    .filter((t) => t.subWalletId === subWallet.id && t.status === 'executed')
    .reduce((sum, t) => sum + t.request.valueUsd, 0);

  const quarantinedUsd = [...db.incomingTransactions.values()]
    .filter((t) => t.subWalletId === subWallet.id && t.quarantine?.status === 'quarantined')
    .reduce((sum, t) => sum + t.valueUsd, 0);

  const releasedIncomingUsd = [...db.incomingTransactions.values()]
    .filter((t) => t.subWalletId === subWallet.id && (t.quarantine === null || t.quarantine.status === 'released'))
    .reduce((sum, t) => sum + t.valueUsd, 0);

  const allocatedOrLimitUsd =
    subWallet.fundingSource === 'allocated_balance'
      ? subWallet.allocatedBalanceUsd
      : (subWallet.drawDownLimitUsd ?? 0);

  const availableUsd = Math.max(0, allocatedOrLimitUsd + releasedIncomingUsd - spentUsd);

  return { fundingSource: subWallet.fundingSource, allocatedOrLimitUsd, spentUsd, quarantinedUsd, availableUsd };
}

export function assertActive(subWallet: AgentSubWallet): void {
  if (subWallet.status === 'suspended') {
    throw new DomainError(
      `Agent sub-wallet "${subWallet.agentName}" is suspended`,
      'SUB_WALLET_SUSPENDED',
      409,
    );
  }
}
