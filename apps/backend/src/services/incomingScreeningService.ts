import { randomUUID } from 'node:crypto';
import {
  type IncomingTransaction,
  type ReleaseQuarantineInput,
  type SimulateIncomingTransactionInput,
  DomainError,
  ForbiddenError,
  NotFoundError,
  nowIso,
  roleCanReleaseQuarantine,
} from '@bitgo-agent-wallet/shared';
import { db, type User } from '../store/db.js';
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
export function receive(input: SimulateIncomingTransactionInput, actingUser: User): IncomingTransaction {
  const subWallet = subWalletService.getSubWallet(input.subWalletId);
  if (subWallet.masterAccountId !== actingUser.masterAccountId) {
    throw new ForbiddenError('Cannot record an incoming transaction outside your master account');
  }

  const screening = screeningService.screen({ address: input.fromAddress });
  const id = `incoming_${randomUUID()}`;
  const confirmedAt = nowIso();

  const incoming: IncomingTransaction = {
    id,
    subWalletId: subWallet.id,
    masterAccountId: subWallet.masterAccountId,
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
  db.incomingTransactions.set(id, incoming);

  auditService.record({
    masterAccountId: subWallet.masterAccountId,
    subWalletId: subWallet.id,
    eventType: 'INCOMING_TRANSACTION_RECEIVED',
    actorUserId: null,
    actorType: 'system',
    summary: `Incoming $${input.valueUsd} from ${input.fromAddress} confirmed on ${input.network}`,
    metadata: { incomingTransactionId: id, screening },
  });

  if (screening.verdict === 'flagged') {
    auditService.record({
      masterAccountId: subWallet.masterAccountId,
      subWalletId: subWallet.id,
      eventType: 'INCOMING_TRANSACTION_FLAGGED',
      actorUserId: null,
      actorType: 'system',
      summary: `Incoming funds quarantined: ${screening.reason}`,
      metadata: { incomingTransactionId: id, screening },
    });
    notifyCompliance(subWallet.masterAccountId, incoming);
  }

  return incoming;
}

function notifyCompliance(masterAccountId: string, incoming: IncomingTransaction): void {
  const complianceUsers = [...db.users.values()].filter(
    (u) => u.masterAccountId === masterAccountId && (u.role === 'compliance' || u.role === 'admin'),
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
  const t = db.incomingTransactions.get(id);
  if (!t) throw new NotFoundError(`Incoming transaction ${id} not found`);
  return t;
}

export function listQuarantined(masterAccountId: string): IncomingTransaction[] {
  return [...db.incomingTransactions.values()].filter(
    (t) => t.masterAccountId === masterAccountId && t.quarantine?.status === 'quarantined',
  );
}

export function listForSubWallet(subWalletId: string): IncomingTransaction[] {
  return [...db.incomingTransactions.values()].filter((t) => t.subWalletId === subWalletId);
}

/** "Quarantined funds require explicit compliance/admin release before becoming
 * spendable... an agent cannot self-authorize release of quarantined funds
 * regardless of autonomy mode." */
export function releaseQuarantine(input: ReleaseQuarantineInput, actingUser: User): IncomingTransaction {
  const incoming = getIncoming(input.incomingTransactionId);
  if (incoming.masterAccountId !== actingUser.masterAccountId) {
    throw new ForbiddenError('Cannot release quarantine outside your master account');
  }
  if (!roleCanReleaseQuarantine(actingUser.role)) {
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

  auditService.record({
    masterAccountId: incoming.masterAccountId,
    subWalletId: incoming.subWalletId,
    eventType: 'QUARANTINE_RELEASED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Quarantined funds ($${incoming.valueUsd}) released by ${actingUser.name}`,
    metadata: { incomingTransactionId: incoming.id, note: input.note },
  });

  return incoming;
}
