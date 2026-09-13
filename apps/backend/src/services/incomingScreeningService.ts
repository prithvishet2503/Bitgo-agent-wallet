import { randomUUID } from 'node:crypto';
import {
  type IncomingTransaction,
  type ReleaseQuarantineInput,
  type SimulateIncomingTransactionInput,
  DomainError,
  ForbiddenError,
  NotFoundError,
  PERMISSIONS,
  hasPermission,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import type { User } from '../store/db.js';
import { incomingDao } from '../dal/models/incoming.dao.js';
import { userDao } from '../dal/models/user.dao.js';
import * as subWalletService from './subWalletService.js';
import * as screeningService from './screeningService.js';
import * as auditService from './auditService.js';

/**
 * Section 6.9 - Incoming Transaction Screening.
 * Incoming transfers cannot be pre-screened; screening happens immediately after
 * on-chain confirmation. In this prototype, `receive()` stands in for the
 * chain-confirmation webhook/listener that would trigger this in production - the
 * screening call itself still runs synchronously "within seconds of confirmation,
 * not batched" as the PRD requires.
 */
export async function receive(input: SimulateIncomingTransactionInput, actingUser: User): Promise<IncomingTransaction> {
  const subWallet = subWalletService.getSubWallet(input.subWalletId);
  if (!actingUser.accessibleEnterpriseIds.includes(subWallet.enterpriseId)) {
    throw new ForbiddenError('Cannot record an incoming transaction outside an enterprise you have access to');
  }

  const screening = await screeningService.screen({ address: input.fromAddress, network: input.network });
  const id = `incoming_${randomUUID()}`;
  const confirmedAt = nowIso();

  const incoming: IncomingTransaction = {
    id,
    subWalletId: subWallet.id,
    enterpriseId: subWallet.enterpriseId,
    fromAddress: input.fromAddress,
    valueUsd: input.valueUsd,
    network: input.network,
    confirmedAt,
    screeningVerdict: screening.verdict,
    screeningReason: screening.reason,
    quarantine:
      screening.verdict === 'flagged'
        ? { status: 'quarantined', quarantinedAt: confirmedAt, releasedAt: null, releasedByUserId: null, releaseNote: null }
        : null,
  };
  incomingDao.createOrUpdate(incoming);

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'INCOMING_TRANSACTION_RECEIVED',
    actorUserId: null,
    actorType: 'system',
    summary: `Incoming $${input.valueUsd} from ${input.fromAddress} confirmed on ${input.network}`,
    metadata: { incomingTransactionId: id, screening },
  });

  if (screening.verdict === 'flagged') {
    auditService.record({
      enterpriseId: subWallet.enterpriseId,
      subWalletId: subWallet.id,
      eventType: 'INCOMING_TRANSACTION_FLAGGED',
      actorUserId: null,
      actorType: 'system',
      summary: `Incoming funds quarantined: ${screening.reason}`,
      metadata: { incomingTransactionId: id, screening },
    });
    notifyCompliance(subWallet.enterpriseId, incoming);
  }

  return incoming;
}

function notifyCompliance(enterpriseId: string, incoming: IncomingTransaction): void {
  const complianceUsers = userDao.list(
    (u) => u.accessibleEnterpriseIds.includes(enterpriseId) && (u.role === 'compliance' || u.role === 'admin'),
  );
  for (const user of complianceUsers) {
    // eslint-disable-next-line no-console
    console.log(
      `[notify:${user.name}] Incoming $${incoming.valueUsd} to sub-wallet ${incoming.subWalletId} flagged ` +
        `(${incoming.screeningReason}) and quarantined - review required`,
    );
  }
}

export function getIncoming(id: string): IncomingTransaction {
  const t = incomingDao.get(id);
  if (!t) throw new NotFoundError(`Incoming transaction ${id} not found`);
  return t;
}

export function listQuarantined(enterpriseId: string): IncomingTransaction[] {
  return incomingDao.list((t) => t.enterpriseId === enterpriseId && t.quarantine?.status === 'quarantined');
}

export function listForSubWallet(subWalletId: string): IncomingTransaction[] {
  return incomingDao.list((t) => t.subWalletId === subWalletId);
}

/** "Quarantined funds require explicit compliance/admin release before becoming
 * spendable... an agent cannot self-authorize release of quarantined funds
 * regardless of autonomy mode." */
export function releaseQuarantine(input: ReleaseQuarantineInput, actingUser: User): IncomingTransaction {
  const incoming = getIncoming(input.incomingTransactionId);
  if (!actingUser.accessibleEnterpriseIds.includes(incoming.enterpriseId)) {
    throw new ForbiddenError('Cannot release quarantine outside an enterprise you have access to');
  }
  if (!hasPermission(actingUser.role, PERMISSIONS.QUARANTINE_RELEASE)) {
    throw new ForbiddenError('Only admin/compliance roles can release quarantined funds');
  }
  if (!incoming.quarantine || incoming.quarantine.status !== 'quarantined') {
    throw new DomainError('This incoming transaction is not currently quarantined', 'NOT_QUARANTINED', 409);
  }

  incoming.quarantine = {
    ...incoming.quarantine,
    status: 'released',
    releasedAt: nowIso(),
    releasedByUserId: actingUser.id,
    releaseNote: input.note,
  };
  incomingDao.createOrUpdate(incoming);

  auditService.record({
    enterpriseId: incoming.enterpriseId,
    subWalletId: incoming.subWalletId,
    eventType: 'QUARANTINE_RELEASED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Quarantined funds ($${incoming.valueUsd}) released by ${actingUser.name}`,
    metadata: { incomingTransactionId: incoming.id, note: input.note },
  });

  return incoming;
}
