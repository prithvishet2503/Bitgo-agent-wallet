import * as sendQueueService from '../services/sendQueueService.js';
import * as subWalletService from '../services/subWalletService.js';
import * as transactionService from '../services/transactionService.js';
import { chainExecutor } from '../services/chainExecutor.js';
import * as auditService from '../services/auditService.js';

/**
 * Polls the SendQueue and processes entries off the request path - mirrors
 * wallet-platform's `SendQueueKafkaWorker` consuming `SendQueue` events, with
 * one deliberate difference: wallet-platform's worker lives in a separate
 * service from the KMS-backed signer; here, this same backend process both
 * dequeues the entry AND calls straight into `chainExecutor` to sign and
 * broadcast it - no second service is involved. This is where "smart contract
 * interaction" actually happens in this prototype: sub-wallet deployment and
 * transaction broadcast are both resolved here, asynchronously, never inline
 * inside the API request that created the entry.
 */
export function startSendQueueWorker(intervalMs = 1500): NodeJS.Timeout {
  return setInterval(() => {
    for (const entry of sendQueueService.listQueued()) {
      sendQueueService.markProcessing(entry);
      void process(entry);
    }
  }, intervalMs);

  async function process(entry: ReturnType<typeof sendQueueService.listQueued>[number]): Promise<void> {
    try {
      if (entry.entryType === 'wallet_deployment') {
        await subWalletService.completeDeployment(entry.relatedId, chainExecutor);
      } else {
        await transactionService.completeBroadcast(entry.relatedId, chainExecutor);
      }
      sendQueueService.markCompleted(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendQueueService.markFailed(entry, message);
      auditService.record({
        enterpriseId: entry.enterpriseId,
        subWalletId: entry.subWalletId,
        eventType: 'SEND_QUEUE_ENTRY_FAILED',
        actorUserId: null,
        actorType: 'system',
        summary: `SendQueue entry ${entry.id} (${entry.entryType}) failed: ${message}`,
        metadata: { sendQueueEntryId: entry.id },
      });
    }
  }
}
