import { Router } from 'express';
import { CreateOrganizationInputSchema } from '@bitgo-agent-wallet/shared';
import * as organizationService from '../services/organizationService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const organizationsRouter = Router();

/**
 * Public "sign up my institution" endpoint - deliberately mounted before the
 * auth middleware in app.ts, since there is no API token yet. This is the direct
 * answer to "can a user create a new account": yes, via this call, which creates
 * an Organization, a first Enterprise under it, and a first admin User in one
 * step and returns that user's API token.
 */
organizationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = CreateOrganizationInputSchema.parse(req.body);
    const result = organizationService.bootstrap(input);
    res.status(201).json(result);
  }),
);
