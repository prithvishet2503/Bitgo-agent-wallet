import { Router } from 'express';
import * as riskService from '../services/riskService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const riskRouter = Router();

/**
 * Section 5.2 / 12.4 - Risk-Grading Engine: risk summary for a sub-wallet.
 * Returns the current trust score and the most recent risk assessments.
 */
riskRouter.get(
  '/:subWalletId/risk-summary',
  asyncHandler(async (req, res) => {
    const summary = riskService.getRiskSummary(req.params.subWalletId);
    res.json(summary);
  }),
);
