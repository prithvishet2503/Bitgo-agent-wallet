import * as scheduledTransactionService from '../services/scheduledTransactionService.js';

/** Polls for due scheduled/recurring transactions and fires them through the
 * normal submitTransaction pipeline - mirrors approvalTimeoutSweeper.ts's
 * poll-rather-than-per-item-timer approach so it survives a process restart
 * cleanly (a missed tick just means the next one finds the same schedule
 * still due). Default interval is coarser than the SendQueue worker's -
 * schedules are minute/day/week/month-grained, not sub-second. */
export function startScheduleSweeper(intervalMs = 30000): NodeJS.Timeout {
  return setInterval(() => {
    void scheduledTransactionService.runDueSchedules().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[scheduleSweeper] failed to run due schedules', err);
    });
  }, intervalMs);
}
