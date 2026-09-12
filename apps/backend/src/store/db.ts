import type {
  AgentSubWallet,
  ApprovalRequest,
  AuditLogEntry,
  Enterprise,
  GasSponsorshipLedgerEntry,
  IncomingTransaction,
  Organization,
  Pact,
  Role,
  SendQueueEntry,
  TransactionRecord,
} from '@bitgo-agent-wallet/shared';

/**
 * In-memory storage engine standing in for BitGo's real persistence layer
 * (Postgres for user-management-service, MongoDB for wallet-platform). Nothing
 * outside `dal/models/*.dao.ts` should import this module directly - every
 * service depends only on a `dal/models/*.dao.ts` singleton, so swapping this for
 * a real database means rewriting this file and the two-line `dal/models/*` files
 * that wrap it, and touching zero service logic.
 */

export interface User {
  id: string;
  organizationId: string;
  /** The user's home Enterprise - used when a request doesn't specify one via the
   * `X-Enterprise-Id` header. */
  enterpriseId: string;
  /** Every Enterprise this user may act on, within their Organization. Mirrors
   * (in simplified form) UMS's `UserOrganizationEntity` + per-enterprise role
   * scoping (`RoleEnterpriseEntity`) - this prototype keeps one role per user
   * rather than a role grant per enterprise. */
  accessibleEnterpriseIds: string[];
  name: string;
  role: Role;
  apiToken: string;
}

class InMemoryDb {
  organizations = new Map<string, Organization>();
  enterprises = new Map<string, Enterprise>();
  users = new Map<string, User>();
  usersByToken = new Map<string, User>();
  subWallets = new Map<string, AgentSubWallet>();
  pacts = new Map<string, Pact>();
  transactions = new Map<string, TransactionRecord>();
  approvalRequests = new Map<string, ApprovalRequest>();
  incomingTransactions = new Map<string, IncomingTransaction>();
  sendQueue = new Map<string, SendQueueEntry>();
  auditLog: AuditLogEntry[] = [];
  gasSponsorshipLedger: GasSponsorshipLedgerEntry[] = [];

  reset(): void {
    this.organizations.clear();
    this.enterprises.clear();
    this.users.clear();
    this.usersByToken.clear();
    this.subWallets.clear();
    this.pacts.clear();
    this.transactions.clear();
    this.approvalRequests.clear();
    this.incomingTransactions.clear();
    this.sendQueue.clear();
    this.auditLog = [];
    this.gasSponsorshipLedger = [];
  }
}

export const db = new InMemoryDb();

export function seedDemoData(): void {
  const organizationId = 'org_demo';
  db.organizations.set(organizationId, {
    id: organizationId,
    name: 'Acme Holdings',
    createdAt: new Date().toISOString(),
  });

  const enterpriseId = 'ent_demo';
  db.enterprises.set(enterpriseId, {
    id: enterpriseId,
    organizationId,
    name: 'Acme Institutional Treasury',
    status: 'active',
    maxSubWallets: 25,
    createdAt: new Date().toISOString(),
  });

  const seedUser = (id: string, name: string, role: Role, apiToken: string): void => {
    const user: User = { id, organizationId, enterpriseId, accessibleEnterpriseIds: [enterpriseId], name, role, apiToken };
    db.users.set(id, user);
    db.usersByToken.set(apiToken, user);
  };

  seedUser('user_admin', 'Ava Admin', 'admin', 'demo-admin-token');
  seedUser('user_compliance', 'Cole Compliance', 'compliance', 'demo-compliance-token');
  seedUser('user_dev', 'Devon Developer', 'developer', 'demo-dev-token');
  seedUser('user_viewer', 'Vera Viewer', 'viewer', 'demo-viewer-token');
}
