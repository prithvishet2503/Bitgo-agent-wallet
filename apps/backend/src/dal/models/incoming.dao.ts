import type { IncomingTransaction } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const incomingDao = new InMemoryDao<IncomingTransaction>(db.incomingTransactions);
