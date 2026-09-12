import { Router } from 'express';
import { ForbiddenError } from '@bitgo-agent-wallet/shared';
import { userDao } from '../dal/models/user.dao.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const authRouter = Router();

/**
 * Section 6.7 - `authenticate` is a required CLI/SDK operation. This mock issues no
 * new credential; it just validates a seed/signup token and echoes back the
 * resolved identity, standing in for BitGo's real institutional auth exchange.
 */
authRouter.post(
  '/authenticate',
  asyncHandler(async (req, res) => {
    const { apiToken } = req.body as { apiToken?: string };
    const user = apiToken ? userDao.getByToken(apiToken) : undefined;
    if (!user) throw new ForbiddenError('Invalid API token');
    res.json({
      userId: user.id,
      name: user.name,
      role: user.role,
      organizationId: user.organizationId,
      enterpriseId: user.enterpriseId,
      accessibleEnterpriseIds: user.accessibleEnterpriseIds,
      apiToken: user.apiToken,
    });
  }),
);
