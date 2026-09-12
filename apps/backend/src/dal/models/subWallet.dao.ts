import type { AgentSubWallet } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const subWalletDao = new InMemoryDao<AgentSubWallet>(db.subWallets);
