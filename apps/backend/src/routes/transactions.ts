import { Router } from 'express';
import { TransactionRequestInputSchema } from '@bitgo-agent-wallet/shared';
import * as transactionService from '../services/transactionService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const transactionsRouter = Router();

/** Section 6.3-6.5 - submit an agent-initiated transaction; runs the full
 * simulate -> screen -> policy -> autonomy-mode pipeline inline in the request
 * (screening now includes a live GoPlus Security lookup, so this awaits a
 * real network call) and returns the resulting status - this is the CLI/SDK
 * `send` operation (Section 6.7). Only the actual chain broadcast is deferred
 * to the SendQueue. */
transactionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = TransactionRequestInputSchema.parse(req.body);
    const record = await transactionService.submitTransaction(input, req.user!);
    res.status(201).json(record);
  }),
);

/** CLI/SDK `get-status` (Section 6.7). */
transactionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(transactionService.getTransaction(req.params.id));
  }),
);

transactionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const subWalletId = typeof req.query.subWalletId === 'string' ? req.query.subWalletId : undefined;
    res.json(transactionService.listTransactions(req.enterpriseId!, subWalletId));
  }),
);
