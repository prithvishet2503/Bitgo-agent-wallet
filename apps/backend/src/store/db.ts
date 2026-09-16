import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  TransactionSchedule,
} from '@bitgo-agent-wallet/shared';
import { SqliteBackedList, SqliteBackedMap, getSqliteConnection } from './sqliteMap.js';

/**
 * Storage engine standing in for BitGo's real persistence layer (Postgres for
 * user-management-service, MongoDB for wallet-platform). Nothing outside
 * `dal/models/*.dao.ts` should import this module directly - every service
 * depends only on a `dal/models/*.dao.ts` singleton (see dal/base.dao.ts).
 *
 * Backed by SQLite by default (`data/bitgo-agent-wallet.sqlite`, gitignored) -
 * data survives a backend restart, including which addresses it has already
 * deployed on-chain. Set PERSISTENCE_MODE=memory to fall back to pure
 * in-memory storage (wiped on restart) instead - useful for tests or a
 * throwaway demo. Either way, every `dal/models/*.dao.ts` file and every
 * service built on it is completely unaware of which one is active.
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

const PERSISTENCE_MODE = process.env.PERSISTENCE_MODE === 'memory' ? 'memory' : 'sqlite';
const SQLITE_PATH = process.env.SQLITE_PATH ?? new URL('../../data/bitgo-agent-wallet.sqlite', import.meta.url).pathname;

function makeMap<T extends { id: string }>(table: string): Map<string, T> | SqliteBackedMap<T> {
  if (PERSISTENCE_MODE === 'memory') return new Map<string, T>();
  mkdirSync(dirname(SQLITE_PATH), { recursive: true });
  return new SqliteBackedMap<T>(getSqliteConnection(SQLITE_PATH), table);
}

function makeList<T extends { id: string }>(table: string): { push(v: T): void; all(): T[]; clear(): void } {
  if (PERSISTENCE_MODE === 'memory') {
    const arr: T[] = [];
    return { push: (v) => arr.push(v), all: () => arr, clear: () => (arr.length = 0) };
  }
  mkdirSync(dirname(SQLITE_PATH), { recursive: true });
  return new SqliteBackedList<T>(getSqliteConnection(SQLITE_PATH), table);
}

class Db {
  organizations = makeMap<Organization>('organizations');
  enterprises = makeMap<Enterprise>('enterprises');
  users = makeMap<User>('users');
  /** Fast lookup index only - never persisted directly, rebuilt from `users`
   * at startup (see rebuildUsersByToken below) and kept in sync on every
   * write by userDao. */
  usersByToken = new Map<string, User>();
  subWallets = makeMap<AgentSubWallet>('sub_wallets');
  pacts = makeMap<Pact>('pacts');
  transactions = makeMap<TransactionRecord>('transactions');
  approvalRequests = makeMap<ApprovalRequest>('approval_requests');
  incomingTransactions = makeMap<IncomingTransaction>('incoming_transactions');
  sendQueue = makeMap<SendQueueEntry>('send_queue');
  schedules = makeMap<TransactionSchedule>('schedules');
  auditLog = makeList<AuditLogEntry>('audit_log');
  gasSponsorshipLedger = makeList<GasSponsorshipLedgerEntry>('gas_sponsorship_ledger');

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
    this.schedules.clear();
    this.auditLog.clear();
    this.gasSponsorshipLedger.clear();
  }
}

export const db = new Db();

function rebuildUsersByToken(): void {
  db.usersByToken.clear();
  for (const user of db.users.values()) {
    db.usersByToken.set(user.apiToken, user);
  }
}
rebuildUsersByToken();

export function seedDemoData(): void {
  // Idempotent: with SQLite persistence, seed data from a previous run is
  // already there on restart - don't create a duplicate demo org every time.
  if (db.organizations.get('org_demo')) {
    // eslint-disable-next-line no-console
    console.log(`[db] Loaded existing data from ${PERSISTENCE_MODE === 'sqlite' ? SQLITE_PATH : '(in-memory)'}`);
    return;
  }

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

  // eslint-disable-next-line no-console
  console.log(`[db] Seeded demo data (${PERSISTENCE_MODE} mode)`);
}
