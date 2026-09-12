import type { SendQueueEntry } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const sendQueueDao = new InMemoryDao<SendQueueEntry>(db.sendQueue);
