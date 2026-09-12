import type { Pact } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const pactDao = new InMemoryDao<Pact>(db.pacts);
