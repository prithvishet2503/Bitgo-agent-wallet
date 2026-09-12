import type { TransactionRecord } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const transactionDao = new InMemoryDao<TransactionRecord>(db.transactions);
