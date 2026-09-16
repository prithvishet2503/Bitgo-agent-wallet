import type { TransactionSchedule } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const scheduleDao = new InMemoryDao<TransactionSchedule>(db.schedules);
