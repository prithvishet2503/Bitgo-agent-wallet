import type { ApprovalRequest } from '@bitgo-agent-wallet/shared';
import { db } from '../../store/db.js';
import { InMemoryDao } from '../base.dao.js';

export const approvalDao = new InMemoryDao<ApprovalRequest>(db.approvalRequests);
