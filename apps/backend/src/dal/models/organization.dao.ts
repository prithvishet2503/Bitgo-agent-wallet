import type { Organization } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const organizationDao = new InMemoryDao<Organization>(db.organizations);
