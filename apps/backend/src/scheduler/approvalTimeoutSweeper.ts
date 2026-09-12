import * as transactionService from '../services/transactionService.js';

/** Section 6.5 - enforces the configurable approval timeout / default action.
 * Polls rather than using per-request timers so the mechanism survives a process
 * restart cleanly (a real deployment would use a durable job scheduler instead). */
export function startApprovalTimeoutSweeper(intervalMs = 5000): NodeJS.Timeout {
  return setInterval(() => {
    try {
      transactionService.sweepExpiredApprovals();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[approvalTimeoutSweeper] failed to sweep expired approvals', err);
    }
  }, intervalMs);
}
