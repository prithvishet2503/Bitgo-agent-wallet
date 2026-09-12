import { Router } from 'express';
import { CreateEnterpriseInputSchema } from '@bitgo-agent-wallet/shared';
import * as enterpriseService from '../services/enterpriseService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const enterprisesRouter = Router();

/** An Organization can have more than one Enterprise (Section: Organization ->
 * Enterprise hierarchy) - an org admin can create additional ones without
 * re-running the signup/bootstrap flow. Admin-only (PERMISSIONS.ENTERPRISE_CREATE). */
enterprisesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = CreateEnterpriseInputSchema.parse({ ...req.body, organizationId: req.user!.organizationId });
    const enterprise = enterpriseService.createEnterprise(input, req.user!);
    res.status(201).json(enterprise);
  }),
);

enterprisesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(enterpriseService.listAccessibleEnterprises(req.user!));
  }),
);

enterprisesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(enterpriseService.assertAccessible(req.params.id, req.user!));
  }),
);
