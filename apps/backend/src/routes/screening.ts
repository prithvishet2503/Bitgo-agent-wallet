import { Router } from 'express';
import * as screeningService from '../services/screeningService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const screeningRouter = Router();

/** Transparency endpoint: OFAC feed health (how many addresses loaded, last
 * refresh, fallback state) and GoPlus Security health (last successful/failed
 * live lookup) - Section 6.3 / 6.9, screeningService.ts. */
screeningRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(screeningService.getScreeningStatus());
  }),
);
