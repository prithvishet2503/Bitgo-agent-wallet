import './env.js'; // must be first - loads .env before chainExecutor.ts reads process.env
import { createApp } from './app.js';
import { seedDemoData } from './store/db.js';
import { startApprovalTimeoutSweeper } from './scheduler/approvalTimeoutSweeper.js';
import { startSendQueueWorker } from './scheduler/sendQueueWorker.js';
import { startScheduleSweeper } from './scheduler/scheduleSweeper.js';
import { createX402Middleware } from './services/x402Service.js';

// Catch async errors that would otherwise crash the process without a trace.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

seedDemoData();

const x402Middleware = await createX402Middleware();
const app = createApp(x402Middleware);
const port = Number(process.env.PORT ?? 4000);

startApprovalTimeoutSweeper();
startSendQueueWorker();
startScheduleSweeper();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`BitGo Agent Wallet backend listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log('Demo API tokens: demo-admin-token, demo-compliance-token, demo-dev-token, demo-viewer-token');
  // eslint-disable-next-line no-console
  console.log('POST /api/v1/organizations to sign up a new Organization + Enterprise + admin user');
});
