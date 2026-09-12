import { randomUUID } from 'node:crypto';
import { type SendQueueEntry, nowIso } from '@bitgo-agent-wallet/shared';
import { sendQueueDao } from '../dal/models/sendQueue.dao.js';

/**
 * Mirrors wallet-platform's `SendQueue` collection + `SendQueueEventsManager`:
 * chain-touching work is enqueued here by a service (never done inline in an
 * HTTP request), and `scheduler/sendQueueWorker.ts` (standing in for
 * `SendQueueKafkaWorker`) dequeues and processes it asynchronously.
 */
export function enqueue(
  input: Pick<SendQueueEntry, 'enterpriseId' | 'subWalletId' | 'entryType' | 'relatedId'>,
): SendQueueEntry {
  const entry: SendQueueEntry = {
    id: `sq_${randomUUID()}`,
    ...input,
    status: 'queued',
    createdAt: nowIso(),
    processedAt: null,
    error: null,
  };
  return sendQueueDao.createOrUpdate(entry);
}

export function listQueued(): SendQueueEntry[] {
  return sendQueueDao.list((e) => e.status === 'queued');
}

export function markProcessing(entry: SendQueueEntry): void {
  entry.status = 'processing';
  sendQueueDao.createOrUpdate(entry);
}

export function markCompleted(entry: SendQueueEntry): void {
  entry.status = 'completed';
  entry.processedAt = nowIso();
  sendQueueDao.createOrUpdate(entry);
}

export function markFailed(entry: SendQueueEntry, error: string): void {
  entry.status = 'failed';
  entry.processedAt = nowIso();
  entry.error = error;
  sendQueueDao.createOrUpdate(entry);
}
