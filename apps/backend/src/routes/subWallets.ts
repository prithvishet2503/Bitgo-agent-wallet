import { Router } from 'express';
import { AutonomyModeSchema, CreateAgentSubWalletInputSchema } from '@bitgo-agent-wallet/shared';
import * as subWalletService from '../services/subWalletService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const subWalletsRouter = Router();

/** Section 6.1 - Agent Sub-Wallet Creation. */
subWalletsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = CreateAgentSubWalletInputSchema.parse({ ...req.body, masterAccountId: req.user!.masterAccountId });
    const subWallet = subWalletService.createSubWallet(input, req.user!);
    res.status(201).json(subWallet);
  }),
);

subWalletsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(subWalletService.listSubWallets(req.user!.masterAccountId));
  }),
);

subWalletsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(subWalletService.getSubWallet(req.params.id));
  }),
);

subWalletsRouter.get(
  '/:id/balance',
  asyncHandler(async (req, res) => {
    const subWallet = subWalletService.getSubWallet(req.params.id);
    res.json(subWalletService.getBalanceSummary(subWallet));
  }),
);

/** Section 6.6 - Emergency Stop (agent kill switch). */
subWalletsRouter.post(
  '/:id/suspend',
  asyncHandler(async (req, res) => {
    const { reason } = req.body as { reason?: string };
    const subWallet = subWalletService.suspendSubWallet(req.params.id, req.user!, reason ?? null);
    res.json(subWallet);
  }),
);

/** Section 6.4 - Autonomy Modes (change, admin/compliance only). */
subWalletsRouter.post(
  '/:id/autonomy-mode',
  asyncHandler(async (req, res) => {
    const mode = AutonomyModeSchema.parse((req.body as { mode?: unknown }).mode);
    const subWallet = subWalletService.setAutonomyMode(req.params.id, mode, req.user!);
    res.json(subWallet);
  }),
);

/** Section 6.10 - mocked EIP-7702 delegation handshake enabling gas sponsorship. */
subWalletsRouter.post(
  '/:id/delegate-eip7702',
  asyncHandler(async (req, res) => {
    const subWallet = subWalletService.delegateEip7702(req.params.id, req.user!);
    res.json(subWallet);
  }),
);
