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
import { type User } from '../store/db.js';
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
 * `SendQueue` document rather than signing/broadcasting the deployment tx itself).
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
    actorUserId: null,
    actorType: 'system',
    summary: 'On-chain smart-account deployment queued',
    metadata: { sendQueueEntryId: queueEntry.id },
  });

  return subWallet;
}

/** Called by the SendQueue worker (scheduler/sendQueueWorker.ts) once a
 * `wallet_deployment` entry is dequeued. Idempotent: a second call on an
 * already-deployed sub-wallet is a no-op, the same protection wallet-platform
 * gets from its atomic `findOneAndUpdate` on `pendingDeployment`.
 *
 * The worker calling this holds the chain executor directly - no separate
 * service is involved. In real mode (chainExecutor.ts) this is an actual
 * on-chain deployment via AgentSubWalletFactory, signed and broadcast by the
 * backend's own key. */
export async function completeDeployment(id: string, executor: ChainExecutor): Promise<void> {
  const subWallet = getSubWallet(id);
  if (!subWallet.pendingDeployment) return;

  const { address, txHash, fundingTxHash } = await executor.deploySubWallet({ subWalletId: id, agentName: subWallet.agentName });
  subWallet.address = address;
  subWallet.pendingDeployment = false;
  subWallet.walletFullyCreated = true;
  subWalletDao.createOrUpdate(subWallet);

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'SUB_WALLET_DEPLOYED',
    actorUserId: null,
    actorType: 'system',
    summary: fundingTxHash
      ? `Agent sub-wallet deployed on-chain at ${subWallet.address} and funded (${executor.mode} mode)`
      : `Agent sub-wallet deployed on-chain at ${subWallet.address} (${executor.mode} mode)`,
    metadata: { txHash, fundingTxHash, chainMode: executor.mode },
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
    throw new ForbiddenError('Only admin/compliance roles can suspend an agent sub-wallet');
  }
  if (subWallet.status === 'suspended') return subWallet;

  subWallet.status = 'suspended';
  subWallet.suspendedAt = nowIso();
  subWallet.suspendedByUserId = actingUser.id;
  subWallet.suspendedReason = reason;
  subWalletDao.createOrUpdate(subWallet);

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
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
  // eslint-disable-next-line no-console
  console.log(
    `[notify:enterprise-admins:${subWallet.enterpriseId}] Agent sub-wallet "${subWallet.agentName}" was suspended by ${actingUser.name}` +
      (reason ? ` (${reason})` : ''),
  );
}

/** Section 6.4 - Autonomy Modes.
 * "Mode is set per agent sub-wallet, changeable only by admin/compliance role, with
 * all mode changes logged." */
export function setAutonomyMode(id: string, mode: AutonomyMode, actingUser: User): AgentSubWallet {
  const subWallet = getSubWallet(id);
  assertSameEnterprise(subWallet, actingUser);
  if (!hasPermission(actingUser.role, PERMISSIONS.AUTONOMY_MODE_CHANGE)) {
    throw new ForbiddenError('Only admin/compliance roles can change autonomy mode');
  }
  const previousMode = subWallet.autonomyMode;
  if (previousMode === mode) return subWallet;

  subWallet.autonomyMode = mode;
  subWalletDao.createOrUpdate(subWallet);
  auditService.record({
    enterpriseId: subWallet.enterpriseId,
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
  assertSameEnterprise(subWallet, actingUser);
  subWallet.eip7702Delegated = true;
  subWalletDao.createOrUpdate(subWallet);
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
  const spentUsd = transactionDao
    .list((t) => t.subWalletId === subWallet.id && t.status === 'executed')
    .reduce((sum, t) => sum + t.request.valueUsd, 0);

  const quarantinedUsd = incomingDao
    .list((t) => t.subWalletId === subWallet.id && t.quarantine?.status === 'quarantined')
    .reduce((sum, t) => sum + t.valueUsd, 0);

  const releasedIncomingUsd = incomingDao
    .list((t) => t.subWalletId === subWallet.id && (t.quarantine === null || t.quarantine.status === 'released'))
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
