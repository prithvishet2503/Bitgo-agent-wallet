import { Router } from 'express';
import * as screeningService from '../services/screeningService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const screeningRouter = Router();

/** Transparency endpoint: how many real OFAC-sanctioned addresses are loaded,
 * when the feed was last refreshed, and whether screening has fallen back to
 * the built-in snapshot (Section 6.3 / 6.9 - screeningService.ts). */
screeningRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(screeningService.getSanctionsListStatus());
  }),
);
