import { createApp } from './app.js';
import { seedDemoData } from './store/db.js';
import { startApprovalTimeoutSweeper } from './scheduler/approvalTimeoutSweeper.js';
import { startSendQueueWorker } from './scheduler/sendQueueWorker.js';

seedDemoData();

const app = createApp();
const port = Number(process.env.PORT ?? 4000);

startApprovalTimeoutSweeper();
startSendQueueWorker();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`BitGo Agent Wallet backend listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log('Demo API tokens: demo-admin-token, demo-compliance-token, demo-dev-token, demo-viewer-token');
  // eslint-disable-next-line no-console
  console.log('POST /api/v1/organizations to sign up a new Organization + Enterprise + admin user');
});
