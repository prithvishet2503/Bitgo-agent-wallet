import { z } from 'zod';

/**
 * Scheduled / recurring transactions.
 *
 * Not an explicit PRD v1 section - a natural extension of Sections 6.3-6.5: a
 * schedule is just a template that calls the exact same
 * `transactionService.submitTransaction()` pipeline (simulate -> screen ->
 * risk-grade -> policy -> autonomy routing -> human approval if needed) on a
 * timer instead of on a synchronous API call. Every governance guarantee this
 * repo already makes - Pact caps, screening, risk-tier escalation, the kill
 * switch - applies identically to a scheduled send; a schedule firing cannot
 * do anything a manually-submitted transaction couldn't already do. See
 * `apps/backend/src/services/scheduledTransactionService.ts`.
 */
export const RecurrenceTypeSchema = z.enum(['once', 'daily', 'weekly', 'monthly']);
export type RecurrenceType = z.infer<typeof RecurrenceTypeSchema>;

export const ScheduleStatusSchema = z.enum(['active', 'paused', 'cancelled', 'completed']);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const TransactionScheduleSchema = z.object({
  id: z.string(),
  subWalletId: z.string(),
  enterpriseId: z.string(),

  // Same request shape the transaction pipeline already accepts - a
  // schedule is a saved template for it.
  to: z.string(),
  valueUsd: z.number().positive(),
  network: z.string(),
  contractAddress: z.string().nullable().default(null),
  protocol: z.string().nullable().default(null),
  functionDescription: z.string().default('transfer'),

  recurrence: RecurrenceTypeSchema,
  /** ISO timestamp - the single run time for `once`, ignored otherwise. */
  runAt: z.string().nullable(),
  /** 0 (Sunday) - 6 (Saturday) - required for `weekly`, ignored otherwise. */
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  /** 1-31 - required for `monthly`, ignored otherwise. Clamped to a short
   * month's last day (e.g. 31 in a 30-day or February) rather than skipping
   * that month - see `computeNextRunAt`. */
  dayOfMonth: z.number().int().min(1).max(31).nullable(),
  /** "HH:mm" in UTC - required for `daily`/`weekly`/`monthly`, ignored for `once`. */
  timeOfDayUtc: z.string().nullable(),

  status: ScheduleStatusSchema,
  /** Next time this schedule should fire; null once `cancelled`/`completed`. */
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunTransactionId: z.string().nullable(),
  runCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),

  createdByUserId: z.string(),
  createdAt: z.string(),
  cancelledAt: z.string().nullable(),
});
export type TransactionSchedule = z.infer<typeof TransactionScheduleSchema>;

export const CreateTransactionScheduleInputSchema = z
  .object({
    subWalletId: z.string(),
    to: z.string(),
    valueUsd: z.number().positive(),
    network: z.string(),
    contractAddress: z.string().nullable().default(null),
    protocol: z.string().nullable().default(null),
    functionDescription: z.string().default('transfer'),
    recurrence: RecurrenceTypeSchema,
    runAt: z.string().nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    timeOfDayUtc: z.string().nullable().optional(),
  })
  .refine((input) => input.recurrence !== 'once' || !!input.runAt, {
    message: '"once" schedules require runAt (an ISO timestamp in the future)',
    path: ['runAt'],
  })
  .refine((input) => input.recurrence !== 'weekly' || input.dayOfWeek !== null && input.dayOfWeek !== undefined, {
    message: '"weekly" schedules require dayOfWeek (0-6)',
    path: ['dayOfWeek'],
  })
  .refine((input) => input.recurrence !== 'monthly' || input.dayOfMonth !== null && input.dayOfMonth !== undefined, {
    message: '"monthly" schedules require dayOfMonth (1-31)',
    path: ['dayOfMonth'],
  })
  .refine((input) => input.recurrence === 'once' || !!input.timeOfDayUtc, {
    message: 'recurring schedules require timeOfDayUtc ("HH:mm", UTC)',
    path: ['timeOfDayUtc'],
  });
export type CreateTransactionScheduleInput = z.infer<typeof CreateTransactionScheduleInputSchema>;
