import { randomUUID } from 'node:crypto';
import {
  type AgentSubWallet,
  type AutonomyMode,
  type CreateAgentSubWalletInput,
  DomainError,
  ForbiddenError,
  NotFoundError,
  PERMISSIONS,
  hasPermission,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import type { User } from '../store/db.js';
import { subWalletDao } from '../dal/models/subWallet.dao.js';
import { transactionDao } from '../dal/models/transaction.dao.js';
import { incomingDao } from '../dal/models/incoming.dao.js';
import * as auditService from './auditService.js';
import * as enterpriseService from './enterpriseService.js';
import * as sendQueueService from './sendQueueService.js';
import type { ChainExecutor } from './chainExecutor.js';

/** Section 6.1 - Agent Sub-Wallet Creation.
 * Creating a sub-wallet does not deploy its on-chain smart account inline - it
 * writes the record with `pendingDeployment: true` and enqueues a SendQueue entry
 * (mirrors wallet-platform's `AbstractEthLikeWalletDeployer`, which writes a
 * pending-deployment wallet document before the deployment transaction lands on
 * chain). The SendQueue worker (`scheduler/sendQueueWorker.ts`) picks up the entry
 * and calls `completeDeployment` below.
 *
 * This means:
 * - `POST /sub-wallets` returns near-instantly with the sub-wallet in
 *   `pendingDeployment` state and `address: null`.
 * - The frontend shows "Pending" until the SendQueue worker resolves it.
 * - A transaction submitted during deployment is denied immediately
 *   (`SUB_WALLET_NOT_DEPLOYED`) rather than racing ahead of the deployment.
 *
 * `completeDeployment` below is what the SendQueue worker calls to resolve it. */
export function createSubWallet(input: CreateAgentSubWalletInput, actingUser: User): AgentSubWallet {
  const enterprise = enterpriseService.assertAccessible(input.enterpriseId, actingUser);
  if (!hasPermission(actingUser.role, PERMISSIONS.WALLET_CREATE)) {
    throw new ForbiddenError('Your role cannot create an agent sub-wallet');
  }

  const existingCount = subWalletDao.list((w) => w.enterpriseId === input.enterpriseId).length;
  if (existingCount >= enterprise.maxSubWallets) {
    throw new DomainError(
      `Enterprise has reached its agent sub-wallet limit (${enterprise.maxSubWallets})`,
      'SUB_WALLET_LIMIT_REACHED',
      409,
    );
  }

  const id = `subwallet_${randomUUID()}`;
  const subWallet: AgentSubWallet = {
    id,
    enterpriseId: input.enterpriseId,
    agentName: input.agentName,
    chain: input.chain,
    address: null, // resolved asynchronously by the SendQueue worker
    pendingDeployment: true,
    walletFullyCreated: false,
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
    // Section 12.4 - Initial trust score: perfect score for a new sub-wallet.
    trustScore: {
      score: 100,
      lastUpdated: nowIso(),
      totalTransactions: 0,
      cleanAutoExecutes: 0,
      policyViolations: 0,
      screeningFlags: 0,
      quarantineEvents: 0,
    },
    createdByUserId: actingUser.id,
    createdAt: nowIso(),
    suspendedAt: null,
    suspendedByUserId: null,
    suspendedReason: null,
  };
  subWalletDao.createOrUpdate(subWallet);

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'SUB_WALLET_CREATED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Agent sub-wallet "${subWallet.agentName}" created on ${subWallet.chain} (deployment pending)`,
    metadata: { autonomyMode: subWallet.autonomyMode, fundingSource: subWallet.fundingSource },
  });

  const queueEntry = sendQueueService.enqueue({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    entryType: 'wallet_deployment',
    relatedId: subWallet.id,
  });

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'SUB_WALLET_DEPLOYMENT_QUEUED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Sub-wallet "${subWallet.agentName}" deployment queued for on-chain deployment`,
    metadata: { sendQueueEntryId: queueEntry.id, subWalletId: subWallet.id },
  });

  return subWallet;
}

/** Called by the SendQueue worker (scheduler/sendQueueWorker.ts) once a
 * `wallet_deployment` entry is dequeued. Idempotent: a second call on an
 * already-deployed sub-wallet is a no-op so that the worker's at-least-once
 * processing is safe. In real chain mode this is a real on-chain deployment
 * via the AgentSubWalletFactory; in mock mode it synthesises an address and
 * tx hash. */
export async function completeDeployment(id: string, executor: ChainExecutor): Promise<void> {
  const subWallet = getSubWallet(id);
  if (subWallet.walletFullyCreated) return; // idempotent

  const deploymentResult = await executor.deploySubWallet({ subWalletId: id, agentName: subWallet.agentName });
  subWalletDao.createOrUpdate({
    ...subWallet,
    address: deploymentResult.address,
    pendingDeployment: false,
    walletFullyCreated: true,
  });

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'SUB_WALLET_DEPLOYED',
    actorUserId: null,
    actorType: 'system',
    summary: `Sub-wallet "${subWallet.agentName}" deployed on-chain at ${deploymentResult.address}`,
    metadata: { address: deploymentResult.address, txHash: deploymentResult.txHash },
  });
}

export function getSubWallet(id: string): AgentSubWallet {
  const w = subWalletDao.get(id);
  if (!w) throw new NotFoundError(`Agent sub-wallet ${id} not found`);
  return w;
}

export function listSubWallets(enterpriseId: string): AgentSubWallet[] {
  return subWalletDao.list((w) => w.enterpriseId === enterpriseId);
}

function assertSameEnterprise(subWallet: AgentSubWallet, actingUser: User): void {
  if (!actingUser.accessibleEnterpriseIds.includes(subWallet.enterpriseId)) {
    throw new ForbiddenError('Cannot act on a sub-wallet outside an enterprise you have access to');
  }
}

/** Section 6.6 - Emergency Stop.
 * One-click suspension of a single agent sub-wallet's signing ability, separate from
 * freezing the enterprise or any other sub-wallet. */
export function suspendSubWallet(id: string, actingUser: User, reason: string | null): AgentSubWallet {
  const subWallet = getSubWallet(id);
  assertSameEnterprise(subWallet, actingUser);
  if (!hasPermission(actingUser.role, PERMISSIONS.WALLET_SUSPEND)) {
    throw new ForbiddenError('Your role cannot suspend an agent sub-wallet');
  }
  if (subWallet.status === 'suspended') {
    throw new DomainError(`Sub-wallet ${subWallet.agentName} is already suspended`, 'ALREADY_SUSPENDED', 409);
  }

  const updated: AgentSubWallet = { ...subWallet, status: 'suspended', suspendedAt: nowIso(), suspendedByUserId: actingUser.id, suspendedReason: reason };
  subWalletDao.createOrUpdate(updated);
  notifyAllAdmins(updated, actingUser, reason);
  return updated;
}

function notifyAllAdmins(subWallet: AgentSubWallet, actingUser: User, reason: string | null): void {
  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'SUB_WALLET_SUSPENDED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Sub-wallet "${subWallet.agentName}" suspended by ${actingUser.name}${reason ? `: ${reason}` : ''}`,
    metadata: { suspendedBy: actingUser.id, reason },
  });
}

/** Section 6.4 - Autonomy Modes.
 * "Mode is set per agent sub-wallet, changeable only by admin/compliance role, with
 * all mode changes logged." */
export function setAutonomyMode(id: string, mode: AutonomyMode, actingUser: User): AgentSubWallet {
  const subWallet = getSubWallet(id);
  assertSameEnterprise(subWallet, actingUser);
  if (!hasPermission(actingUser.role, PERMISSIONS.AUTONOMY_MODE_CHANGE)) {
    throw new ForbiddenError('Your role cannot change autonomy mode');
  }
  const previous = subWallet.autonomyMode;
  const updated: AgentSubWallet = { ...subWallet, autonomyMode: mode };
  subWalletDao.createOrUpdate(updated);
  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'AUTONOMY_MODE_CHANGED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Autonomy mode changed from ${previous} to ${mode} by ${actingUser.name}`,
    metadata: { previousMode: previous, newMode: mode },
  });
  return updated;
}

/** Section 6.10 - Gas Sponsorship via EIP-7702.
 * Mocks the EOA-to-paymaster delegation handshake; in production this would be an
 * on-chain EIP-7702 authorization transaction against an audited delegator contract. */
export function delegateEip7702(id: string, actingUser: User): AgentSubWallet {
  const subWallet = getSubWallet(id);
  assertSameEnterprise(subWallet, actingUser);
  if (!hasPermission(actingUser.role, PERMISSIONS.AUTONOMY_MODE_CHANGE)) {
    throw new ForbiddenError('Your role cannot change gas sponsorship settings');
  }
  if (subWallet.eip7702Delegated) {
    throw new DomainError(`Sub-wallet ${subWallet.agentName} is already delegated`, 'ALREADY_DELEGATED', 409);
  }
  const updated: AgentSubWallet = { ...subWallet, eip7702Delegated: true };
  subWalletDao.createOrUpdate(updated);
  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'GAS_SPONSORSHIP_APPLIED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `EIP-7702 delegation enabled for sub-wallet "${subWallet.agentName}"`,
    metadata: {},
  });
  return updated;
}

export interface BalanceSummary {
  fundingSource: string;
  allocatedOrLimitUsd: number;
  spentUsd: number;
  quarantinedUsd: number;
  availableUsd: number;
}

/** Balance as seen by developer tooling's `get-balance` (Section 6.7). Quarantined
 * incoming funds (Section 6.9) are visible but excluded from spendable balance. */
export function getBalanceSummary(subWallet: AgentSubWallet): BalanceSummary {
  const spentUsd = transactionDao
    .list((t) => t.subWalletId === subWallet.id && t.status === 'executed')
    .reduce((sum, t) => sum + t.request.valueUsd, 0);

  const quarantinedUsd = incomingDao
    .list((t) => t.subWalletId === subWallet.id && t.quarantine?.status === 'quarantined')
    .reduce((sum, t) => sum + t.valueUsd, 0);

  const allocatedOrLimit = subWallet.fundingSource === 'allocated_balance'
    ? subWallet.allocatedBalanceUsd
    : subWallet.drawDownLimitUsd ?? 0;

  return {
    fundingSource: subWallet.fundingSource,
    allocatedOrLimitUsd: allocatedOrLimit,
    spentUsd,
    quarantinedUsd,
    availableUsd: Math.max(0, allocatedOrLimit - spentUsd - quarantinedUsd),
  };
}

export function assertActive(subWallet: AgentSubWallet): void {
  if (subWallet.status === 'suspended') {
    throw new DomainError(`Sub-wallet ${subWallet.agentName} is suspended`, 'SUB_WALLET_SUSPENDED', 403);
  }
}
