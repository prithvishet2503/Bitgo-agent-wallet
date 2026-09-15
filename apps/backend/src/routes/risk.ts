import { Router } from 'express';
import * as riskService from '../services/riskService.js';
import * as subWalletService from '../services/subWalletService.js';
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

/**
 * Section 12.4 - Adaptive Autonomy: deterministic graduation checklist for a
 * Strict-Mode sub-wallet. Read-only - the mode change itself remains an
 * admin/compliance action (POST /sub-wallets/:id/autonomy-mode), which
 * snapshots this evaluation into its audit entry.
 */
riskRouter.get(
  '/:subWalletId/graduation-eligibility',
  asyncHandler(async (req, res) => {
    const subWallet = subWalletService.getSubWallet(req.params.subWalletId);
    res.json(riskService.evaluateGraduationEligibility(subWallet));
  }),
);
