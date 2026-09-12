import { Router } from 'express';
import { ApprovalDecisionInputSchema } from '@bitgo-agent-wallet/shared';
import * as approvalService from '../services/approvalService.js';
import * as transactionService from '../services/transactionService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const approvalsRouter = Router();

/** Section 6.5 - Human Approval Flow (web console channel reads this list directly). */
approvalsRouter.get(
  '/pending',
  asyncHandler(async (req, res) => {
    res.json(approvalService.listPending(req.user!.masterAccountId));
  }),
);

approvalsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(approvalService.getApprovalRequest(req.params.id));
  }),
);

approvalsRouter.post(
  '/:id/decide',
  asyncHandler(async (req, res) => {
    // userId always comes from the authenticated session, never the request body.
    const input = ApprovalDecisionInputSchema.parse({
      ...req.body,
      approvalRequestId: req.params.id,
      userId: req.user!.id,
    });
    const result = transactionService.handleApprovalDecision(input, req.user!);
    res.json(result);
  }),
);
