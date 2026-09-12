import { randomUUID } from 'node:crypto';
import {
  type AgentSubWallet,
  type CreatePactInput,
  type Pact,
  type PolicyEvaluation,
  type TransactionRequestInput,
  ForbiddenError,
  NotFoundError,
  nowIso,
  roleCanManagePolicy,
} from '@bitgo-agent-wallet/shared';
import { db, type User } from '../store/db.js';
import * as auditService from './auditService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Section 6.2 - Policy / Pact Engine.
 * "Policies must be editable only by users with admin/compliance role; agents cannot
 * self-modify policy." */
export function createPact(input: CreatePactInput, actingUser: User): Pact {
  if (!roleCanManagePolicy(actingUser.role)) {
    throw new ForbiddenError('Only admin/compliance roles can create a Pact');
  }
  const id = `pact_${randomUUID()}`;
  const pact: Pact = {
    ...input,
    id,
    createdByUserId: actingUser.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    updatedByUserId: actingUser.id,
  };
  db.pacts.set(id, pact);

  const subWallet = db.subWallets.get(input.subWalletId);
  if (subWallet) subWallet.pactId = id;

  auditService.record({
    masterAccountId: subWallet?.masterAccountId ?? 'unknown',
    subWalletId: input.subWalletId,
    eventType: 'PACT_CREATED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Pact created for sub-wallet ${input.subWalletId}`,
    metadata: { pactId: id },
  });

  return pact;
}

export function updatePact(pactId: string, patch: Partial<CreatePactInput>, actingUser: User): Pact {
  const pact = db.pacts.get(pactId);
  if (!pact) throw new NotFoundError(`Pact ${pactId} not found`);
  if (!roleCanManagePolicy(actingUser.role)) {
    throw new ForbiddenError('Only admin/compliance roles can update a Pact');
  }
  Object.assign(pact, patch, { updatedAt: nowIso(), updatedByUserId: actingUser.id });

  auditService.record({
    masterAccountId: actingUser.masterAccountId,
    subWalletId: pact.subWalletId,
    eventType: 'PACT_UPDATED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Pact ${pactId} updated`,
    metadata: { patch },
  });

  return pact;
}

export function getPact(pactId: string): Pact {
  const pact = db.pacts.get(pactId);
  if (!pact) throw new NotFoundError(`Pact ${pactId} not found`);
  return pact;
}

export function getPactForSubWallet(subWalletId: string): Pact | null {
  return [...db.pacts.values()].find((p) => p.subWalletId === subWalletId) ?? null;
}

function committedSpendSince(subWalletId: string, sinceMs: number): number {
  return [...db.transactions.values()]
    .filter((t) => t.subWalletId === subWalletId)
    .filter((t) => t.status === 'approved' || t.status === 'executed')
    .filter((t) => Date.parse(t.createdAt) >= sinceMs)
    .reduce((sum, t) => sum + t.request.valueUsd, 0);
}

/** Evaluates a transaction request against a sub-wallet's Pact. Returns every
 * violation found (not just the first) so the structured denial reason returned to
 * the agent is complete enough to retry within scope in one round trip
 * (Section 6.2 - "matching Cobo's retry-feedback pattern"). */
export function evaluate(
  subWallet: AgentSubWallet,
  pact: Pact,
  request: TransactionRequestInput,
): PolicyEvaluation {
  const violations: PolicyEvaluation['violations'] = [];
  const now = Date.now();

  if (pact.sessionExpiresAt && Date.parse(pact.sessionExpiresAt) < now) {
    violations.push({ code: 'SESSION_EXPIRED', message: `Pact session expired at ${pact.sessionExpiresAt}` });
  }

  if (request.valueUsd > pact.maxTransactionValueUsd) {
    violations.push({
      code: 'MAX_TX_VALUE_EXCEEDED',
      message: `Transaction value $${request.valueUsd} exceeds max per-transaction cap $${pact.maxTransactionValueUsd}`,
    });
  }

  const dailySpend = committedSpendSince(subWallet.id, now - DAY_MS);
  if (dailySpend + request.valueUsd > pact.dailySpendCapUsd) {
    violations.push({
      code: 'DAILY_CAP_EXCEEDED',
      message: `Daily spend cap $${pact.dailySpendCapUsd} would be exceeded ($${dailySpend} already committed today)`,
    });
  }

  const weeklySpend = committedSpendSince(subWallet.id, now - WEEK_MS);
  if (weeklySpend + request.valueUsd > pact.weeklySpendCapUsd) {
    violations.push({
      code: 'WEEKLY_CAP_EXCEEDED',
      message: `Weekly spend cap $${pact.weeklySpendCapUsd} would be exceeded ($${weeklySpend} already committed this week)`,
    });
  }

  if (pact.contractAllowlist.length > 0 && request.contractAddress) {
    if (!pact.contractAllowlist.includes(request.contractAddress)) {
      violations.push({
        code: 'CONTRACT_NOT_ALLOWLISTED',
        message: `Contract ${request.contractAddress} is not on the allowlist`,
      });
    }
  }

  if (pact.protocolAllowlist.length > 0 && request.protocol) {
    if (!pact.protocolAllowlist.includes(request.protocol)) {
      violations.push({
        code: 'PROTOCOL_NOT_ALLOWLISTED',
        message: `Protocol ${request.protocol} is not on the allowlist`,
      });
    }
  }

  if (pact.networkAllowlist.length > 0 && !pact.networkAllowlist.includes(request.network)) {
    violations.push({
      code: 'NETWORK_NOT_ALLOWLISTED',
      message: `Network ${request.network} is not on the allowlist`,
    });
  }

  if (pact.destinationDenylist.includes(request.to)) {
    violations.push({ code: 'DESTINATION_DENYLISTED', message: `Destination ${request.to} is denylisted` });
  }

  if (pact.destinationAllowlist.length > 0 && !pact.destinationAllowlist.includes(request.to)) {
    violations.push({
      code: 'DESTINATION_NOT_ALLOWLISTED',
      message: `Destination ${request.to} is not on the allowlist`,
    });
  }

  return { compliant: violations.length === 0, violations };
}
