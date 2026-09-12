import { Router } from 'express';
import { ReleaseQuarantineInputSchema, SimulateIncomingTransactionInputSchema } from '@bitgo-agent-wallet/shared';
import * as incomingScreeningService from '../services/incomingScreeningService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const incomingRouter = Router();

/** Section 6.9 - Incoming Transaction Screening.
 * In production this fires from a chain-confirmation listener; here it's an
 * explicit endpoint so the flow can be demoed/tested without a real chain. */
incomingRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = SimulateIncomingTransactionInputSchema.parse(req.body);
    const incoming = incomingScreeningService.receive(input, req.user!);
    res.status(201).json(incoming);
  }),
);

incomingRouter.get(
  '/quarantined',
  asyncHandler(async (req, res) => {
    res.json(incomingScreeningService.listQuarantined(req.enterpriseId!));
  }),
);

incomingRouter.get(
  '/by-sub-wallet/:subWalletId',
  asyncHandler(async (req, res) => {
    res.json(incomingScreeningService.listForSubWallet(req.params.subWalletId));
  }),
);

incomingRouter.post(
  '/:id/release',
  asyncHandler(async (req, res) => {
    const input = ReleaseQuarantineInputSchema.parse({
      ...req.body,
      incomingTransactionId: req.params.id,
      releasedByUserId: req.user!.id,
    });
    res.json(incomingScreeningService.releaseQuarantine(input, req.user!));
  }),
);
