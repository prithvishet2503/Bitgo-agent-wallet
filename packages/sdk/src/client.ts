import type {
  AgentSubWallet,
  ApprovalRequest,
  AuditLogEntry,
  AuditLogQuery,
  AutonomyMode,
  CreateAgentSubWalletInput,
  CreateEnterpriseRequestInput,
  CreateOrganizationInput,
  CreatePactInput,
  Enterprise,
  IncomingTransaction,
  Organization,
  Pact,
  ReleaseQuarantineInput,
  SimulateIncomingTransactionInput,
  TransactionRecord,
  TransactionRequestInput,
} from '@bitgo-agent-wallet/shared';

export interface BitGoAgentWalletClientOptions {
  baseUrl?: string;
  apiToken?: string;
  enterpriseId?: string;
  fetchImpl?: typeof fetch;
}

export interface AuthenticatedIdentity {
  userId: string;
  name: string;
  role: string;
  organizationId: string;
  /** Home enterprise, used when no `X-Enterprise-Id` header is set. */
  enterpriseId: string;
  /** Every Enterprise this identity may act on (see setEnterpriseId). */
  accessibleEnterpriseIds: string[];
  apiToken: string;
}

export interface BootstrapOrganizationResult {
  organization: Organization;
  enterprise: Enterprise;
  userId: string;
  apiToken: string;
}

/**
 * Section 6.7 - Developer Tooling: TypeScript SDK.
 * Thin, fully-typed wrapper over the REST API (apps/backend). The CLI (apps/cli)
 * and MCP server (apps/mcp-server) are both built on top of this same client, so
 * "SDK/CLI/MCP" (Section 6.7) share one source of truth for request/response
 * shapes and error handling.
 */
export class BitGoAgentWalletClient {
  private baseUrl: string;
  private apiToken: string | undefined;
  private enterpriseId: string | undefined;
  private fetchImpl: typeof fetch;

  constructor(options: BitGoAgentWalletClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:4000/api/v1';
    this.apiToken = options.apiToken;
    this.enterpriseId = options.enterpriseId;
    // Bind to globalThis: browsers' native fetch throws "Illegal invocation" if
    // called without `window` as the receiver, which happens once `fetch` is
    // stored as a bare method reference on this class instance.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  setApiToken(token: string): void {
    this.apiToken = token;
  }

  /** Selects which Enterprise subsequent requests act on (sent as the
   * `X-Enterprise-Id` header) - only meaningful when the current identity has
   * access to more than one. */
  setEnterpriseId(enterpriseId: string): void {
    this.enterpriseId = enterpriseId;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {}),
        ...(this.enterpriseId ? { 'x-enterprise-id': this.enterpriseId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const message = json?.error?.message ?? `Request failed with status ${res.status}`;
      throw new BitGoAgentWalletApiError(message, json?.error?.code ?? 'UNKNOWN', res.status, json?.error?.issues);
    }
    return json as T;
  }

  // --- Section 6.7: `authenticate` ---
  async authenticate(apiToken: string): Promise<AuthenticatedIdentity> {
    const identity = await this.request<AuthenticatedIdentity>('POST', '/auth/authenticate', { apiToken });
    this.setApiToken(identity.apiToken);
    this.setEnterpriseId(identity.enterpriseId);
    return identity;
  }

  // --- "Sign up my institution": Organization -> Enterprise -> admin User ---
  async createOrganization(input: CreateOrganizationInput): Promise<BootstrapOrganizationResult> {
    const result = await this.request<BootstrapOrganizationResult>('POST', '/organizations', input);
    this.setApiToken(result.apiToken);
    this.setEnterpriseId(result.enterprise.id);
    return result;
  }

  // --- An Organization can contain more than one Enterprise ---
  async createEnterprise(input: Omit<CreateEnterpriseRequestInput, 'organizationId'>): Promise<Enterprise> {
    return this.request('POST', '/enterprises', input);
  }

  async listEnterprises(): Promise<Enterprise[]> {
    return this.request('GET', '/enterprises');
  }

  async getEnterprise(id: string): Promise<Enterprise> {
    return this.request('GET', `/enterprises/${id}`);
  }

  // --- Section 6.1: Agent Sub-Wallet Creation ---
  async createAgentSubWallet(input: Omit<CreateAgentSubWalletInput, 'enterpriseId'>): Promise<AgentSubWallet> {
    return this.request('POST', '/sub-wallets', input);
  }

  async listAgentSubWallets(): Promise<AgentSubWallet[]> {
    return this.request('GET', '/sub-wallets');
  }

  async getAgentSubWallet(id: string): Promise<AgentSubWallet> {
    return this.request('GET', `/sub-wallets/${id}`);
  }

  // --- Section 6.7: `get-balance` ---
  async getBalance(subWalletId: string): Promise<{
    fundingSource: string;
    allocatedOrLimitUsd: number;
    spentUsd: number;
    quarantinedUsd: number;
    availableUsd: number;
  }> {
    return this.request('GET', `/sub-wallets/${subWalletId}/balance`);
  }

  // --- Section 6.6 / 6.7: Emergency Stop / `revoke` ---
  async revoke(subWalletId: string, reason?: string): Promise<AgentSubWallet> {
    return this.request('POST', `/sub-wallets/${subWalletId}/suspend`, { reason });
  }

  // --- Section 6.4: Autonomy Modes ---
  async setAutonomyMode(subWalletId: string, mode: AutonomyMode): Promise<AgentSubWallet> {
    return this.request('POST', `/sub-wallets/${subWalletId}/autonomy-mode`, { mode });
  }

  // --- Section 6.10: EIP-7702 gas sponsorship delegation ---
  async delegateEip7702(subWalletId: string): Promise<AgentSubWallet> {
    return this.request('POST', `/sub-wallets/${subWalletId}/delegate-eip7702`);
  }

  // --- Section 6.2: Policy / Pact Engine ---
  async createPact(input: CreatePactInput): Promise<Pact> {
    return this.request('POST', '/pacts', input);
  }

  async updatePact(pactId: string, patch: Partial<CreatePactInput>): Promise<Pact> {
    return this.request('PATCH', `/pacts/${pactId}`, patch);
  }

  async getPactForSubWallet(subWalletId: string): Promise<Pact | null> {
    try {
      return await this.request('GET', `/pacts/by-sub-wallet/${subWalletId}`);
    } catch (err) {
      if (err instanceof BitGoAgentWalletApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  // --- Section 6.7: `send` (submits through simulate -> screen -> policy -> autonomy pipeline) ---
  async send(request: TransactionRequestInput): Promise<TransactionRecord> {
    return this.request('POST', '/transactions', request);
  }

  // --- Section 6.7: `get-status` ---
  async getStatus(transactionId: string): Promise<TransactionRecord> {
    return this.request('GET', `/transactions/${transactionId}`);
  }

  async listTransactions(subWalletId?: string): Promise<TransactionRecord[]> {
    const qs = subWalletId ? `?subWalletId=${encodeURIComponent(subWalletId)}` : '';
    return this.request('GET', `/transactions${qs}`);
  }

  // --- Section 6.5: Human Approval Flow ---
  async listPendingApprovals(): Promise<ApprovalRequest[]> {
    return this.request('GET', '/approvals/pending');
  }

  async decideApproval(
    approvalRequestId: string,
    decision: 'approve' | 'deny',
    reason?: string,
  ): Promise<{ approval: ApprovalRequest; transaction: TransactionRecord }> {
    return this.request('POST', `/approvals/${approvalRequestId}/decide`, { decision, reason });
  }

  // --- Section 6.8: Audit & Compliance ---
  async queryAuditLog(query: Omit<AuditLogQuery, 'enterpriseId'>): Promise<AuditLogEntry[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return this.request('GET', `/audit-log?${params.toString()}`);
  }

  // --- Section 6.9: Incoming Transaction Screening ---
  async simulateIncoming(input: SimulateIncomingTransactionInput): Promise<IncomingTransaction> {
    return this.request('POST', '/incoming', input);
  }

  async listQuarantined(): Promise<IncomingTransaction[]> {
    return this.request('GET', '/incoming/quarantined');
  }

  async releaseQuarantine(input: Omit<ReleaseQuarantineInput, 'releasedByUserId'>): Promise<IncomingTransaction> {
    return this.request('POST', `/incoming/${input.incomingTransactionId}/release`, { note: input.note });
  }
}

export class BitGoAgentWalletApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'BitGoAgentWalletApiError';
  }
}
