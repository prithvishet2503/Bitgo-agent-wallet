import cors from 'cors';
import express, { type Express } from 'express';
import { authRouter } from './routes/auth.js';
import { organizationsRouter } from './routes/organizations.js';
import { enterprisesRouter } from './routes/enterprises.js';
import { subWalletsRouter } from './routes/subWallets.js';
import { pactsRouter } from './routes/pacts.js';
import { transactionsRouter } from './routes/transactions.js';
import { approvalsRouter } from './routes/approvals.js';
import { auditLogRouter } from './routes/auditLog.js';
import { incomingRouter } from './routes/incoming.js';
import { screeningRouter } from './routes/screening.js';
import { authMiddleware } from './middleware/auth.js';
import { resolveEnterprise } from './middleware/enterprise.js';
import { errorHandler } from './middleware/errorHandler.js';

/**
 * BitGo Agent Wallet API - a REST surface over the Section 6 functional
 * requirements. The SDK, CLI, and MCP server (Section 6.7) are all thin clients of
 * this same API, so there is exactly one implementation of the governance logic.
 */
export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'bitgo-agent-wallet-backend' }));

  // Public - no API token exists yet ("sign up my institution").
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/organizations', organizationsRouter);

  // Everything below requires authentication...
  app.use('/api/v1', authMiddleware);
  app.use('/api/v1/enterprises', enterprisesRouter);
  app.use('/api/v1/screening', screeningRouter);

  // ...and everything below also resolves which Enterprise the request acts on
  // (Section: Organization -> Enterprise hierarchy; X-Enterprise-Id header).
  app.use('/api/v1', resolveEnterprise);
  app.use('/api/v1/sub-wallets', subWalletsRouter);
  app.use('/api/v1/pacts', pactsRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/approvals', approvalsRouter);
  app.use('/api/v1/audit-log', auditLogRouter);
  app.use('/api/v1/incoming', incomingRouter);

  app.use(errorHandler);
  return app;
}
