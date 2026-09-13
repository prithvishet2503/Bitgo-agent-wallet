import { Router } from 'express';
import { chainExecutor } from '../services/chainExecutor.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const chainRouter = Router();

/** Transparency endpoint: chain-execution mode (mock/real), treasury balance,
 * custody scheme, and the live Chainlink ETH/USD price currently backing real
 * value transfers - fetched fresh on every call, not cached request state
 * (Section 6.10 / chainExecutor.ts / priceOracle.ts). */
chainRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ mode: chainExecutor.mode, ...(await chainExecutor.getStatus()) });
  }),
);
