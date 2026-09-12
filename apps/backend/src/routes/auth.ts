import { Router } from 'express';
import { ForbiddenError } from '@bitgo-agent-wallet/shared';
import { db } from '../store/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const authRouter = Router();

/**
 * Section 6.7 - `authenticate` is a required CLI/SDK operation. This mock issues no
 * new credential; it just validates a seed demo token and echoes back the resolved
 * identity, standing in for BitGo's real institutional auth exchange.
 */
authRouter.post(
  '/authenticate',
  asyncHandler(async (req, res) => {
    const { apiToken } = req.body as { apiToken?: string };
    const user = apiToken ? db.usersByToken.get(apiToken) : undefined;
    if (!user) throw new ForbiddenError('Invalid API token');
    res.json({
      userId: user.id,
      name: user.name,
      role: user.role,
      masterAccountId: user.masterAccountId,
      apiToken: user.apiToken,
    });
  }),
);
