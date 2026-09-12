import type {
  AgentSubWallet,
  ApprovalRequest,
  AuditLogEntry,
  GasSponsorshipLedgerEntry,
  IncomingTransaction,
  Pact,
  Role,
  TransactionRecord,
} from '@bitgo-agent-wallet/shared';

/**
 * In-memory data store standing in for BitGo's real persistence layer.
 *
 * This prototype intentionally mocks everything outside the agent-wallet business
 * logic itself (MPC/HSM key material, chain RPC, screening vendor, push/Slack
 * delivery) so the code here can focus on the governance rules the PRD actually
 * specifies. Swapping this module for a real database does not require touching
 * any service logic - every service depends only on the methods below.
 */

export interface User {
  id: string;
  name: string;
  masterAccountId: string;
  role: Role;
  apiToken: string;
}

export interface MasterAccount {
  id: string;
  name: string;
  maxSubWallets: number;
}

class InMemoryDb {
  masterAccounts = new Map<string, MasterAccount>();
  users = new Map<string, User>();
  usersByToken = new Map<string, User>();
  subWallets = new Map<string, AgentSubWallet>();
  pacts = new Map<string, Pact>();
  transactions = new Map<string, TransactionRecord>();
  approvalRequests = new Map<string, ApprovalRequest>();
  auditLog: AuditLogEntry[] = [];
  incomingTransactions = new Map<string, IncomingTransaction>();
  gasSponsorshipLedger: GasSponsorshipLedgerEntry[] = [];

  reset(): void {
    this.masterAccounts.clear();
    this.users.clear();
    this.usersByToken.clear();
    this.subWallets.clear();
    this.pacts.clear();
    this.transactions.clear();
    this.approvalRequests.clear();
    this.auditLog = [];
    this.incomingTransactions.clear();
    this.gasSponsorshipLedger = [];
  }
}

export const db = new InMemoryDb();

export function seedDemoData(): void {
  const masterAccountId = 'macct_demo';
  db.masterAccounts.set(masterAccountId, {
    id: masterAccountId,
    name: 'Acme Institutional Treasury',
    maxSubWallets: 25,
  });

  const seedUser = (id: string, name: string, role: Role, apiToken: string): void => {
    const user: User = { id, name, masterAccountId, role, apiToken };
    db.users.set(id, user);
    db.usersByToken.set(apiToken, user);
  };

  seedUser('user_admin', 'Ava Admin', 'admin', 'demo-admin-token');
  seedUser('user_compliance', 'Cole Compliance', 'compliance', 'demo-compliance-token');
  seedUser('user_dev', 'Devon Developer', 'developer', 'demo-dev-token');
  seedUser('user_viewer', 'Vera Viewer', 'viewer', 'demo-viewer-token');
}
