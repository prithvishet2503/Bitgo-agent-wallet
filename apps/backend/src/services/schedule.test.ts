import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Static imports cannot work here: db.ts reads PERSISTENCE_MODE at module
// evaluation time, so the env assignment must execute before any project
// module loads (ESM static imports hoist above it). Deliberate module-loading
// boundary per the test-file exception (see pact.test.ts / transaction.test.ts).
process.env.PERSISTENCE_MODE = 'memory';
process.env.SCREENING_FAIL_MODE = 'open';
globalThis.fetch = (async () => {
  throw new Error('offline test environment');
}) as typeof fetch;

const { db, seedDemoData } = await import('../store/db.js');
const scheduledTransactionService = await import('./scheduledTransactionService.js');
const subWalletService = await import('./subWalletService.js');
const pactService = await import('./pactService.js');
const { userDao } = await import('../dal/models/user.dao.js');
const { scheduleDao } = await import('../dal/models/schedule.dao.js');
const { MockChainExecutor } = await import('./chainExecutor.js');

/** Forces a schedule to be immediately due without depending on real wall-clock
 * timing (matches this codebase's convention - see approval.test.ts's
 * `timeoutAt` backdating - of writing a past timestamp directly rather than
 * sleeping past it). */
function backdateToDue(scheduleId: string): void {
  const schedule = scheduledTransactionService.getSchedule(scheduleId);
  scheduleDao.createOrUpdate({ ...schedule, nextRunAt: new Date(Date.now() - 1000).toISOString() });
}

const { computeNextRunAt } = scheduledTransactionService;

const ENT = 'ent_demo';

function adminUser() {
  return userDao.getByToken('demo-admin-token')!;
}

async function freshSubWallet(name: string) {
  const sw = subWalletService.createSubWallet(
    {
      enterpriseId: ENT,
      agentName: name,
      chain: 'base',
      fundingSource: 'allocated_balance',
      allocatedBalanceUsd: 100000,
      drawDownLimitUsd: null,
      autonomyMode: 'bounded_auto',
    },
    adminUser(),
  );
  await subWalletService.completeDeployment(sw.id, new MockChainExecutor());
  return subWalletService.getSubWallet(sw.id);
}

function attachPact(subWalletId: string, caps: { max: number; daily: number; weekly: number }) {
  return pactService.createPact(
    {
      subWalletId,
      maxTransactionValueUsd: caps.max,
      dailySpendCapUsd: caps.daily,
      weeklySpendCapUsd: caps.weekly,
      contractAllowlist: [],
      protocolAllowlist: [],
      networkAllowlist: ['base'],
      destinationAllowlist: [],
      destinationDenylist: [],
      sessionExpiresAt: null,
      gasSponsorshipCapUsdPerTx: null,
      gasSponsorshipCapUsdPerDay: null,
      gasSponsorshipFallback: 'own_balance' as const,
    },
    adminUser(),
  );
}

function scheduleInput(subWalletId: string, overrides: Record<string, unknown> = {}) {
  return {
    subWalletId,
    to: '0x3333333333333333333333333333333333333333',
    valueUsd: 100,
    network: 'base',
    contractAddress: null,
    protocol: null,
    functionDescription: 'transfer',
    recurrence: 'once' as const,
    runAt: new Date(Date.now() + 60_000).toISOString(),
    dayOfWeek: null,
    dayOfMonth: null,
    timeOfDayUtc: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.reset();
  seedDemoData();
});

// --- computeNextRunAt: pure function, no DB/network involved ---

test('computeNextRunAt("once") returns runAt verbatim', () => {
  const runAt = '2030-01-01T00:00:00.000Z';
  assert.equal(computeNextRunAt({ recurrence: 'once', runAt, dayOfWeek: null, dayOfMonth: null, timeOfDayUtc: null }, Date.now()), runAt);
});

test('computeNextRunAt("daily") rolls to tomorrow once today\'s time has passed', () => {
  const from = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z
  const stillToday = computeNextRunAt({ recurrence: 'daily', runAt: null, dayOfWeek: null, dayOfMonth: null, timeOfDayUtc: '15:00' }, from);
  assert.equal(stillToday, '2026-01-15T15:00:00.000Z');

  const alreadyPassed = computeNextRunAt({ recurrence: 'daily', runAt: null, dayOfWeek: null, dayOfMonth: null, timeOfDayUtc: '09:00' }, from);
  assert.equal(alreadyPassed, '2026-01-16T09:00:00.000Z');
});

test('computeNextRunAt("weekly") finds the next occurrence of dayOfWeek, rolling a week if today\'s slot passed', () => {
  // 2026-01-15 is a Thursday (dayOfWeek 4).
  const thursdayNoon = Date.UTC(2026, 0, 15, 12, 0, 0);

  // Next Monday (1) after a Thursday.
  const nextMonday = computeNextRunAt({ recurrence: 'weekly', runAt: null, dayOfWeek: 1, dayOfMonth: null, timeOfDayUtc: '09:00' }, thursdayNoon);
  assert.equal(nextMonday, '2026-01-19T09:00:00.000Z');

  // Same day (Thursday), but the time slot already passed today -> next week.
  const laterThisWeek = computeNextRunAt({ recurrence: 'weekly', runAt: null, dayOfWeek: 4, dayOfMonth: null, timeOfDayUtc: '09:00' }, thursdayNoon);
  assert.equal(laterThisWeek, '2026-01-22T09:00:00.000Z');
});

test('computeNextRunAt("monthly") lands on the target day, and clamps for short months', () => {
  const from = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01
  const fifthOfMonth = computeNextRunAt({ recurrence: 'monthly', runAt: null, dayOfWeek: null, dayOfMonth: 5, timeOfDayUtc: '09:00' }, from);
  assert.equal(fifthOfMonth, '2026-01-05T09:00:00.000Z');

  // Requesting day 31 from a point already past January 31st should clamp to
  // February's actual last day (28 in 2026, not a leap year) rather than
  // skipping February entirely.
  const fromLateJan = Date.UTC(2026, 0, 31, 23, 0, 0);
  const clampedToFeb = computeNextRunAt({ recurrence: 'monthly', runAt: null, dayOfWeek: null, dayOfMonth: 31, timeOfDayUtc: '09:00' }, fromLateJan);
  assert.equal(clampedToFeb, '2026-02-28T09:00:00.000Z');
});

// --- createSchedule validation ---

test('createSchedule rejects a "once" runAt in the past', async () => {
  const sw = await freshSubWallet('Schedule Bot');
  assert.throws(
    () => scheduledTransactionService.createSchedule(scheduleInput(sw.id, { runAt: new Date(Date.now() - 1000).toISOString() }), adminUser()),
    (err: { code?: string }) => err.code === 'INVALID_SCHEDULE',
  );
});

// --- End-to-end: sweeper firing a due schedule through the real pipeline ---

test('a due "once" schedule fires through submitTransaction, then completes and never fires again', async () => {
  const sw = await freshSubWallet('Once Bot');
  attachPact(sw.id, { max: 500, daily: 2000, weekly: 5000 });

  const schedule = scheduledTransactionService.createSchedule(
    scheduleInput(sw.id, { runAt: new Date(Date.now() + 3600_000).toISOString() }),
    adminUser(),
  );
  backdateToDue(schedule.id);

  await scheduledTransactionService.runDueSchedules();

  const updated = scheduledTransactionService.getSchedule(schedule.id);
  assert.equal(updated.status, 'completed');
  assert.equal(updated.nextRunAt, null);
  assert.equal(updated.runCount, 1);
  assert.ok(updated.lastRunTransactionId);
  assert.ok(db.auditLog.all().some((e) => e.eventType === 'SCHEDULE_TRIGGERED' && e.metadata.scheduleId === schedule.id));
  assert.ok(db.auditLog.all().some((e) => e.eventType === 'SCHEDULE_COMPLETED' && e.metadata.scheduleId === schedule.id));

  // A second sweep must not fire it again.
  await scheduledTransactionService.runDueSchedules();
  assert.equal(scheduledTransactionService.getSchedule(schedule.id).runCount, 1);
});

test('a due recurring schedule fires and advances nextRunAt instead of completing', async () => {
  const sw = await freshSubWallet('Daily Bot');
  attachPact(sw.id, { max: 500, daily: 2000, weekly: 5000 });

  // timeOfDayUtc is set an hour into the future purely so createSchedule's
  // own computeNextRunAt call lands on a valid, real future timestamp;
  // backdateToDue then forces it due "now" without depending on wall-clock
  // timing precision.
  const anHourFromNow = new Date(Date.now() + 3600_000);
  const hh = String(anHourFromNow.getUTCHours()).padStart(2, '0');
  const mm = String(anHourFromNow.getUTCMinutes()).padStart(2, '0');

  const schedule = scheduledTransactionService.createSchedule(
    scheduleInput(sw.id, { recurrence: 'daily', runAt: null, timeOfDayUtc: `${hh}:${mm}` }),
    adminUser(),
  );
  backdateToDue(schedule.id);

  await scheduledTransactionService.runDueSchedules();

  const updated = scheduledTransactionService.getSchedule(schedule.id);
  assert.equal(updated.status, 'active');
  assert.equal(updated.runCount, 1);
  assert.ok(updated.nextRunAt, 'a daily schedule must have a next run time after firing');
  assert.ok(Date.parse(updated.nextRunAt!) > Date.now(), 'next run must be pushed into the future (tomorrow)');
});

test('pause stops a schedule from firing; resume makes it due again immediately', async () => {
  const sw = await freshSubWallet('Pausable Bot');
  attachPact(sw.id, { max: 500, daily: 2000, weekly: 5000 });

  const schedule = scheduledTransactionService.createSchedule(
    scheduleInput(sw.id, { runAt: new Date(Date.now() + 3600_000).toISOString() }),
    adminUser(),
  );
  const paused = scheduledTransactionService.pauseSchedule(schedule.id, adminUser());
  assert.equal(paused.status, 'paused');
  assert.equal(paused.nextRunAt, null);

  await scheduledTransactionService.runDueSchedules();
  assert.equal(scheduledTransactionService.getSchedule(schedule.id).runCount, 0, 'a paused schedule must not fire');

  // Backdate the underlying runAt itself (not just nextRunAt) to model "time
  // passed while this was paused" - resumeSchedule recomputes nextRunAt from
  // this for a 'once' schedule, so it should come back already due.
  scheduleDao.createOrUpdate({ ...scheduledTransactionService.getSchedule(schedule.id), runAt: new Date(Date.now() - 1000).toISOString() });

  const resumed = scheduledTransactionService.resumeSchedule(schedule.id, adminUser());
  assert.equal(resumed.status, 'active');
  assert.ok(Date.parse(resumed.nextRunAt!) <= Date.now());

  await scheduledTransactionService.runDueSchedules();
  assert.equal(scheduledTransactionService.getSchedule(schedule.id).runCount, 1, 'resuming a past-due "once" schedule fires it immediately');
});

test('cancel stops a schedule permanently', async () => {
  const sw = await freshSubWallet('Cancellable Bot');
  attachPact(sw.id, { max: 500, daily: 2000, weekly: 5000 });

  const schedule = scheduledTransactionService.createSchedule(
    scheduleInput(sw.id, { runAt: new Date(Date.now() + 3600_000).toISOString() }),
    adminUser(),
  );
  const cancelled = scheduledTransactionService.cancelSchedule(schedule.id, adminUser());
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.nextRunAt, null);

  backdateToDue(schedule.id); // no-op for a cancelled schedule (nextRunAt stays null), but proves the sweeper still skips it
  await scheduledTransactionService.runDueSchedules();
  assert.equal(scheduledTransactionService.getSchedule(schedule.id).runCount, 0);
});

test('a scheduled send goes through the exact same governance pipeline - over-cap escalates to approval, not a silent failure', async () => {
  const sw = await freshSubWallet('Escalating Schedule Bot');
  attachPact(sw.id, { max: 50, daily: 2000, weekly: 5000 });

  const schedule = scheduledTransactionService.createSchedule(
    scheduleInput(sw.id, { valueUsd: 500, runAt: new Date(Date.now() + 3600_000).toISOString() }),
    adminUser(),
  );
  backdateToDue(schedule.id);
  await scheduledTransactionService.runDueSchedules();

  const updated = scheduledTransactionService.getSchedule(schedule.id);
  assert.ok(updated.lastRunTransactionId);
  const record = db.transactions.get(updated.lastRunTransactionId!);
  assert.equal(record?.status, 'pending_approval');
  assert.equal(record?.policyViolations[0].code, 'MAX_TX_VALUE_EXCEEDED');
});
