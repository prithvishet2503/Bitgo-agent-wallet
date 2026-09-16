import { Router } from 'express';
import { CreateTransactionScheduleInputSchema } from '@bitgo-agent-wallet/shared';
import * as scheduledTransactionService from '../services/scheduledTransactionService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const schedulesRouter = Router();

/** Scheduled / recurring transactions - a saved template for the exact same
 * pipeline `POST /transactions` runs, fired later by
 * `scheduler/scheduleSweeper.ts` instead of synchronously. */
schedulesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = CreateTransactionScheduleInputSchema.parse(req.body);
    const schedule = scheduledTransactionService.createSchedule(input, req.user!);
    res.status(201).json(schedule);
  }),
);

schedulesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const subWalletId = typeof req.query.subWalletId === 'string' ? req.query.subWalletId : undefined;
    res.json(scheduledTransactionService.listSchedules(req.enterpriseId!, subWalletId));
  }),
);

schedulesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(scheduledTransactionService.getSchedule(req.params.id));
  }),
);

schedulesRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(scheduledTransactionService.cancelSchedule(req.params.id, req.user!));
  }),
);

schedulesRouter.post(
  '/:id/pause',
  asyncHandler(async (req, res) => {
    res.json(scheduledTransactionService.pauseSchedule(req.params.id, req.user!));
  }),
);

schedulesRouter.post(
  '/:id/resume',
  asyncHandler(async (req, res) => {
    res.json(scheduledTransactionService.resumeSchedule(req.params.id, req.user!));
  }),
);
