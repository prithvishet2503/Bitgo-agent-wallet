import * as sendQueueService from '../services/sendQueueService.js';
import * as subWalletService from '../services/subWalletService.js';
import * as transactionService from '../services/transactionService.js';
import { signer } from '../services/signer.js';
import * as auditService from '../services/auditService.js';

/**
 * Polls the SendQueue and processes entries off the request path - mirrors
 * wallet-platform's `SendQueueKafkaWorker` consuming `SendQueue` events. This is
 * where "smart contract interaction" actually happens in this prototype: sub-wallet
 * deployment and transaction broadcast are both resolved here, asynchronously,
 * never inline inside the API request that created the entry.
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
        await subWalletService.completeDeployment(entry.relatedId, signer);
      } else {
        await transactionService.completeBroadcast(entry.relatedId, signer);
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
