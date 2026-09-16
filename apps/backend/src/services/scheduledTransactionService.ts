import { randomUUID } from 'node:crypto';
import {
  type CreateTransactionScheduleInput,
  type TransactionSchedule,
  DomainError,
  ForbiddenError,
  NotFoundError,
  nowIso,
} from '@bitgo-agent-wallet/shared';
import type { User } from '../store/db.js';
import { scheduleDao } from '../dal/models/schedule.dao.js';
import { userDao } from '../dal/models/user.dao.js';
import * as subWalletService from './subWalletService.js';
import * as transactionService from './transactionService.js';
import * as auditService from './auditService.js';

/**
 * Scheduled / recurring transactions - see packages/shared/src/types/schedule.ts
 * for why this is a thin template over the existing pipeline rather than a
 * separate governance path. Nothing here signs or broadcasts anything: a
 * schedule firing calls the exact same `transactionService.submitTransaction()`
 * every manual `send` goes through, so it can end up `executed`,
 * `pending_approval`, `policy_denied`, `screening_blocked`, etc. exactly like
 * any other transaction - see the resulting `TransactionRecord` (linked via
 * `lastRunTransactionId`) for what actually happened.
 *
 * The sweeper (`scheduler/scheduleSweeper.ts`) is the only caller of
 * `runDueSchedules`; no route calls it directly.
 */

function assertAccessible(enterpriseId: string, actingUser: User): void {
  if (!actingUser.accessibleEnterpriseIds.includes(enterpriseId)) {
    throw new ForbiddenError('Cannot act on a resource outside an enterprise you have access to');
  }
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function describeRecurrence(schedule: Pick<TransactionSchedule, 'recurrence' | 'runAt' | 'dayOfWeek' | 'dayOfMonth' | 'timeOfDayUtc'>): string {
  switch (schedule.recurrence) {
    case 'once':
      return `once at ${schedule.runAt}`;
    case 'daily':
      return `daily at ${schedule.timeOfDayUtc} UTC`;
    case 'weekly':
      return `weekly on ${WEEKDAY_NAMES[schedule.dayOfWeek ?? 0]} at ${schedule.timeOfDayUtc} UTC`;
    case 'monthly':
      return `monthly on day ${schedule.dayOfMonth} at ${schedule.timeOfDayUtc} UTC`;
  }
}

/**
 * Pure and independently testable: given a schedule's recurrence config and a
 * "now" timestamp, returns the next ISO run time (or null if there isn't one -
 * only possible for a malformed `once` schedule, which `createSchedule`
 * already rejects).
 *
 * `monthly` clamps `dayOfMonth` to the target month's actual last day (e.g.
 * day 31 in a 30-day month, or in February) rather than skipping that month
 * entirely or rolling into the next one - a documented, deliberate choice:
 * "every month on the 31st" still fires every month, just on the 28th/29th/30th
 * when the month is short.
 */
export function computeNextRunAt(
  schedule: Pick<TransactionSchedule, 'recurrence' | 'runAt' | 'dayOfWeek' | 'dayOfMonth' | 'timeOfDayUtc'>,
  fromMs: number,
): string | null {
  if (schedule.recurrence === 'once') {
    return schedule.runAt;
  }

  const [hh, mm] = (schedule.timeOfDayUtc ?? '00:00').split(':').map(Number);
  const from = new Date(fromMs);

  if (schedule.recurrence === 'daily') {
    const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hh, mm, 0, 0));
    if (next.getTime() <= fromMs) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }

  if (schedule.recurrence === 'weekly') {
    const targetDow = schedule.dayOfWeek ?? 0;
    const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hh, mm, 0, 0));
    const diff = (targetDow - next.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + diff);
    if (next.getTime() <= fromMs) next.setUTCDate(next.getUTCDate() + 7);
    return next.toISOString();
  }

  // monthly
  const targetDom = schedule.dayOfMonth ?? 1;
  const monthCandidate = (monthOffset: number): Date => {
    const year = from.getUTCFullYear();
    const month = from.getUTCMonth() + monthOffset;
    const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(targetDom, lastDayOfMonth);
    return new Date(Date.UTC(year, month, day, hh, mm, 0, 0));
  };
  let next = monthCandidate(0);
  if (next.getTime() <= fromMs) next = monthCandidate(1);
  return next.toISOString();
}

export function createSchedule(input: CreateTransactionScheduleInput, actingUser: User): TransactionSchedule {
  const subWallet = subWalletService.getSubWallet(input.subWalletId);
  assertAccessible(subWallet.enterpriseId, actingUser);

  if (input.recurrence === 'once') {
    const runAtMs = input.runAt ? Date.parse(input.runAt) : NaN;
    if (!Number.isFinite(runAtMs)) {
      throw new DomainError('runAt must be a valid ISO timestamp', 'INVALID_SCHEDULE', 400);
    }
    if (runAtMs <= Date.now()) {
      throw new DomainError('runAt must be in the future', 'INVALID_SCHEDULE', 400);
    }
  }

  const schedule: TransactionSchedule = {
    id: `sched_${randomUUID()}`,
    subWalletId: subWallet.id,
    enterpriseId: subWallet.enterpriseId,
    to: input.to,
    valueUsd: input.valueUsd,
    network: input.network,
    contractAddress: input.contractAddress ?? null,
    protocol: input.protocol ?? null,
    functionDescription: input.functionDescription ?? 'transfer',
    recurrence: input.recurrence,
    runAt: input.runAt ?? null,
    dayOfWeek: input.dayOfWeek ?? null,
    dayOfMonth: input.dayOfMonth ?? null,
    timeOfDayUtc: input.timeOfDayUtc ?? null,
    status: 'active',
    nextRunAt: null,
    lastRunAt: null,
    lastRunTransactionId: null,
    runCount: 0,
    failureCount: 0,
    lastError: null,
    createdByUserId: actingUser.id,
    createdAt: nowIso(),
    cancelledAt: null,
  };
  schedule.nextRunAt = computeNextRunAt(schedule, Date.now());
  scheduleDao.createOrUpdate(schedule);

  auditService.record({
    enterpriseId: subWallet.enterpriseId,
    subWalletId: subWallet.id,
    eventType: 'SCHEDULE_CREATED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Schedule created: $${input.valueUsd} to ${input.to} (${describeRecurrence(schedule)})`,
    metadata: { scheduleId: schedule.id, nextRunAt: schedule.nextRunAt },
  });

  return schedule;
}

export function getSchedule(id: string): TransactionSchedule {
  const schedule = scheduleDao.get(id);
  if (!schedule) throw new NotFoundError(`Schedule ${id} not found`);
  return schedule;
}

export function listSchedules(enterpriseId: string, subWalletId?: string): TransactionSchedule[] {
  return scheduleDao.list((s) => s.enterpriseId === enterpriseId && (!subWalletId || s.subWalletId === subWalletId));
}

export function cancelSchedule(id: string, actingUser: User): TransactionSchedule {
  const schedule = getSchedule(id);
  assertAccessible(schedule.enterpriseId, actingUser);
  if (schedule.status === 'cancelled' || schedule.status === 'completed') return schedule;

  const updated: TransactionSchedule = { ...schedule, status: 'cancelled', nextRunAt: null, cancelledAt: nowIso() };
  scheduleDao.createOrUpdate(updated);
  auditService.record({
    enterpriseId: schedule.enterpriseId,
    subWalletId: schedule.subWalletId,
    eventType: 'SCHEDULE_CANCELLED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Schedule ${schedule.id} cancelled by ${actingUser.name}`,
    metadata: { scheduleId: schedule.id },
  });
  return updated;
}

export function pauseSchedule(id: string, actingUser: User): TransactionSchedule {
  const schedule = getSchedule(id);
  assertAccessible(schedule.enterpriseId, actingUser);
  if (schedule.status !== 'active') {
    throw new DomainError(`Schedule ${id} is not active (status: ${schedule.status})`, 'SCHEDULE_NOT_ACTIVE', 409);
  }

  const updated: TransactionSchedule = { ...schedule, status: 'paused', nextRunAt: null };
  scheduleDao.createOrUpdate(updated);
  auditService.record({
    enterpriseId: schedule.enterpriseId,
    subWalletId: schedule.subWalletId,
    eventType: 'SCHEDULE_PAUSED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Schedule ${schedule.id} paused by ${actingUser.name}`,
    metadata: { scheduleId: schedule.id },
  });
  return updated;
}

export function resumeSchedule(id: string, actingUser: User): TransactionSchedule {
  const schedule = getSchedule(id);
  assertAccessible(schedule.enterpriseId, actingUser);
  if (schedule.status !== 'paused') {
    throw new DomainError(`Schedule ${id} is not paused (status: ${schedule.status})`, 'SCHEDULE_NOT_PAUSED', 409);
  }

  const updated: TransactionSchedule = { ...schedule, status: 'active' };
  // A 'once' schedule resumed after its original runAt has already passed
  // fires on the sweeper's very next tick, rather than being silently
  // skipped - resuming is an explicit human action, so "fire immediately" is
  // the more honest behavior than quietly dropping it.
  updated.nextRunAt = computeNextRunAt(updated, Date.now());
  scheduleDao.createOrUpdate(updated);
  auditService.record({
    enterpriseId: schedule.enterpriseId,
    subWalletId: schedule.subWalletId,
    eventType: 'SCHEDULE_RESUMED',
    actorUserId: actingUser.id,
    actorType: 'user',
    summary: `Schedule ${schedule.id} resumed by ${actingUser.name}`,
    metadata: { scheduleId: schedule.id, nextRunAt: updated.nextRunAt },
  });
  return updated;
}

/** Advances (or completes) a due schedule's own bookkeeping *before* handing
 * it to submitTransaction - so a slow governance pipeline (a real GoPlus
 * lookup, e.g.) spanning more than one sweeper tick can't cause the same
 * schedule to be picked up and run twice. Mirrors the paranoia
 * `chainExecutor.ts`'s `serialize()` applies to nonce races - same shape of
 * problem, same fix (claim state before doing the slow async work). */
function claimNextRun(schedule: TransactionSchedule): TransactionSchedule {
  const isOneShot = schedule.recurrence === 'once';
  const updated: TransactionSchedule = {
    ...schedule,
    status: isOneShot ? 'completed' : 'active',
    nextRunAt: isOneShot ? null : computeNextRunAt(schedule, Date.now()),
  };
  scheduleDao.createOrUpdate(updated);
  if (isOneShot) {
    auditService.record({
      enterpriseId: schedule.enterpriseId,
      subWalletId: schedule.subWalletId,
      eventType: 'SCHEDULE_COMPLETED',
      actorUserId: null,
      actorType: 'system',
      summary: `One-time schedule ${schedule.id} completed its only run`,
      metadata: { scheduleId: schedule.id },
    });
  }
  return updated;
}

function recordRunFailure(scheduleId: string, message: string): void {
  const current = scheduleDao.get(scheduleId);
  if (!current) return;
  scheduleDao.createOrUpdate({ ...current, failureCount: current.failureCount + 1, lastError: message, lastRunAt: nowIso() });
  auditService.record({
    enterpriseId: current.enterpriseId,
    subWalletId: current.subWalletId,
    eventType: 'SCHEDULE_RUN_FAILED',
    actorUserId: null,
    actorType: 'system',
    summary: `Schedule ${scheduleId} run failed: ${message}`,
    metadata: { scheduleId },
  });
}

async function runOne(schedule: TransactionSchedule): Promise<void> {
  claimNextRun(schedule);

  const actingUser = userDao.get(schedule.createdByUserId);
  if (!actingUser) {
    recordRunFailure(schedule.id, `Creating user ${schedule.createdByUserId} no longer exists`);
    return;
  }

  auditService.record({
    enterpriseId: schedule.enterpriseId,
    subWalletId: schedule.subWalletId,
    eventType: 'SCHEDULE_TRIGGERED',
    actorUserId: null,
    actorType: 'system',
    summary: `Schedule ${schedule.id} triggered: $${schedule.valueUsd} to ${schedule.to}`,
    metadata: { scheduleId: schedule.id },
  });

  try {
    // The exact same pipeline a manual `send` goes through - simulate,
    // screen, risk-grade, policy, autonomy routing, approval if needed. A
    // resulting status of policy_denied/screening_blocked/pending_approval is
    // a normal governance outcome, not a schedule failure - see the linked
    // TransactionRecord for what actually happened.
    const record = await transactionService.submitTransaction(
      {
        subWalletId: schedule.subWalletId,
        to: schedule.to,
        valueUsd: schedule.valueUsd,
        network: schedule.network,
        contractAddress: schedule.contractAddress,
        protocol: schedule.protocol,
        functionDescription: schedule.functionDescription,
      },
      actingUser,
    );
    const current = scheduleDao.get(schedule.id);
    if (current) {
      scheduleDao.createOrUpdate({
        ...current,
        lastRunAt: nowIso(),
        lastRunTransactionId: record.id,
        runCount: current.runCount + 1,
        lastError: null,
      });
    }
  } catch (err) {
    recordRunFailure(schedule.id, err instanceof Error ? err.message : String(err));
  }
}

/** Called by `scheduler/scheduleSweeper.ts` on a poll interval - never by a
 * route. Runs every currently-due active schedule sequentially (simplicity
 * over throughput; matches this prototype's other single-process sweepers). */
export async function runDueSchedules(): Promise<void> {
  const now = Date.now();
  const due = scheduleDao.list((s) => s.status === 'active' && s.nextRunAt !== null && Date.parse(s.nextRunAt) <= now);
  for (const schedule of due) {
    await runOne(schedule);
  }
}
