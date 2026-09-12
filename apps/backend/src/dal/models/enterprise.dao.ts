import type { Enterprise } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const enterpriseDao = new InMemoryDao<Enterprise>(db.enterprises);
