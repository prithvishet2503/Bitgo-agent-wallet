import { Router } from 'express';
import { CreatePactInputSchema, UpdatePactInputSchema } from '@bitgo-agent-wallet/shared';
import * as pactService from '../services/pactService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const pactsRouter = Router();

/** Section 6.2 - Policy / Pact Engine. Editable only by admin/compliance (enforced
 * in the service layer). */
pactsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = CreatePactInputSchema.parse(req.body);
    const pact = pactService.createPact(input, req.user!);
    res.status(201).json(pact);
  }),
);

pactsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(pactService.getPact(req.params.id));
  }),
);

pactsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const patch = UpdatePactInputSchema.partial().parse(req.body);
    res.json(pactService.updatePact(req.params.id, patch, req.user!));
  }),
);

pactsRouter.get(
  '/by-sub-wallet/:subWalletId',
  asyncHandler(async (req, res) => {
    const pact = pactService.getPactForSubWallet(req.params.subWalletId);
    if (!pact) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No Pact configured for this sub-wallet' } });
      return;
    }
    res.json(pact);
  }),
);
