import { createApp } from './app.js';
import { seedDemoData } from './store/db.js';
import { startApprovalTimeoutSweeper } from './scheduler/approvalTimeoutSweeper.js';

seedDemoData();

const app = createApp();
const port = Number(process.env.PORT ?? 4000);

startApprovalTimeoutSweeper();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`BitGo Agent Wallet backend listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log('Demo API tokens: demo-admin-token, demo-compliance-token, demo-dev-token, demo-viewer-token');
});
