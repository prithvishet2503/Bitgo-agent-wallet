#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BitGoAgentWalletApiError, BitGoAgentWalletClient } from '@bitgo-agent-wallet/sdk';
import { AuditEventTypeSchema } from '@bitgo-agent-wallet/shared';

/**
 * Section 6.7 - Developer Tooling: MCP Server (transactional).
 * "Expand current docs-only MCP server to expose the same operations as the CLI, so
 * agent frameworks (Claude Code, LangChain-based agents, etc.) can call BitGo
 * directly." This is the flagship framework integration called out in Section 8's
 * risk mitigation ("Prioritize MCP server + one flagship integration... for launch
 * credibility").
 *
 * Every tool below wraps the same SDK client used by the CLI - no separate logic.
 * Configure via env vars:
 *   BITGO_AGENT_WALLET_BASE_URL  (default http://localhost:4000/api/v1)
 *   BITGO_AGENT_WALLET_API_TOKEN (required - the agent's own scoped API token)
 */

const baseUrl = process.env.BITGO_AGENT_WALLET_BASE_URL ?? 'http://localhost:4000/api/v1';
const apiToken = process.env.BITGO_AGENT_WALLET_API_TOKEN;

if (!apiToken) {
  console.error('BITGO_AGENT_WALLET_API_TOKEN is required to start the MCP server.');
  process.exit(1);
}

const client = new BitGoAgentWalletClient({ baseUrl, apiToken });

const server = new McpServer({ name: 'bitgo-agent-wallet', version: '0.1.0' });

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function safe(fn: () => Promise<unknown>): Promise<ReturnType<typeof textResult>> {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof BitGoAgentWalletApiError) {
      return textResult({ error: { code: err.code, message: err.message } });
    }
    throw err;
  }
}

server.tool(
  'list_agent_wallets',
  'List agent sub-wallets on the authenticated master account (Section 6.1).',
  {},
  async () => safe(() => client.listAgentSubWallets()),
);

server.tool(
  'create_agent_wallet',
  'Create a new agent sub-wallet nested under the master account (Section 6.1).',
  {
    agentName: z.string(),
    chain: z.enum(['ethereum-mainnet', 'base', 'optimism', 'arbitrum']).default('ethereum-mainnet'),
    fundingSource: z.enum(['allocated_balance', 'draw_down']).default('allocated_balance'),
    allocatedBalanceUsd: z.number().default(0),
    drawDownLimitUsd: z.number().nullable().default(null),
    autonomyMode: z.enum(['strict', 'bounded_auto']).default('strict'),
  },
  async (args) => safe(() => client.createAgentSubWallet(args)),
);

server.tool(
  'get_balance',
  "Get an agent sub-wallet's spendable balance, excluding any quarantined funds (Section 6.7 / 6.9).",
  { subWalletId: z.string() },
  async ({ subWalletId }) => safe(() => client.getBalance(subWalletId)),
);

server.tool(
  'send',
  'Submit an agent-initiated transaction. Runs simulation, screening, policy, and ' +
    'autonomy-mode checks; may return status "executed", "pending_approval", ' +
    '"policy_denied", "screening_blocked", or "simulation_failed" (Sections 6.2-6.5).',
  {
    subWalletId: z.string(),
    to: z.string(),
    valueUsd: z.number(),
    network: z.string().default('ethereum-mainnet'),
    contractAddress: z.string().nullable().default(null),
    protocol: z.string().nullable().default(null),
    functionDescription: z.string().default('transfer'),
  },
  async (args) => safe(() => client.send(args)),
);

server.tool(
  'get_status',
  'Get the current status of a previously submitted transaction (Section 6.7).',
  { transactionId: z.string() },
  async ({ transactionId }) => safe(() => client.getStatus(transactionId)),
);

server.tool(
  'revoke',
  "Emergency-stop (kill switch) an agent sub-wallet's signing ability (Section 6.6). Requires admin/compliance role.",
  { subWalletId: z.string(), reason: z.string().optional() },
  async ({ subWalletId, reason }) => safe(() => client.revoke(subWalletId, reason)),
);

server.tool(
  'get_pact',
  "Get the Pact (policy) currently attached to an agent sub-wallet (Section 6.2).",
  { subWalletId: z.string() },
  async ({ subWalletId }) => safe(() => client.getPactForSubWallet(subWalletId)),
);

server.tool(
  'list_pending_approvals',
  'List transactions currently awaiting human approval (Section 6.5).',
  {},
  async () => safe(() => client.listPendingApprovals()),
);

server.tool(
  'query_audit_log',
  'Query the immutable audit log of agent actions, policy decisions, and approvals (Section 6.8).',
  {
    subWalletId: z.string().optional(),
    eventType: AuditEventTypeSchema.optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().max(1000).default(50),
  },
  async (args) => {
    const result = await client.queryAuditLog(args);
    return textResult(result);
  },
);

server.tool(
  'get_risk_summary',
  "Get risk-grading summary for a sub-wallet: current trust score and recent risk assessments (Section 5.2 / 12.4).",
  { subWalletId: z.string() },
  async ({ subWalletId }) => safe(() => client.getRiskSummary(subWalletId)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('BitGo Agent Wallet MCP server running on stdio');
