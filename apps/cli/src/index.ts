#!/usr/bin/env node
import { Command } from 'commander';
import { BitGoAgentWalletApiError, BitGoAgentWalletClient } from '@bitgo-agent-wallet/sdk';
import { loadConfig, saveConfig } from './config.js';

/**
 * Section 6.7 - Developer Tooling: CLI.
 * "CLI: authenticate, create-agent-wallet, send, get-balance, get-status, revoke
 * commands." Every command below is a thin call into the SDK client
 * (@bitgo-agent-wallet/sdk), which is itself a thin call into the REST API
 * (apps/backend), so there is exactly one implementation of every governance rule.
 */

function clientFromConfig(): BitGoAgentWalletClient {
  const config = loadConfig();
  if (!config.apiToken) {
    console.error('Not authenticated. Run `authenticate <token>` first, or use `create-organization`.');
    process.exit(1);
  }
  return new BitGoAgentWalletClient({ baseUrl: config.baseUrl, apiToken: config.apiToken, enterpriseId: config.enterpriseId });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof BitGoAgentWalletApiError) {
      console.error(`Error [${err.code}] (${err.httpStatus}): ${err.message}`);
      if (err.issues) console.error(JSON.stringify(err.issues, null, 2));
    } else if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

const program = new Command();
program.name('bitgo-agent-wallet').description('BitGo Agent Wallet CLI (Section 6.7)').version('0.1.0');

program
  .command('authenticate')
  .description('Authenticate with an API token and persist it to ~/.bitgo-agent-wallet/config.json')
  .argument('<apiToken>', 'API token (e.g. one of the seeded demo tokens)')
  .option('--base-url <url>', 'API base URL', 'http://localhost:4000/api/v1')
  .action((apiToken: string, opts: { baseUrl: string }) =>
    run(async () => {
      const client = new BitGoAgentWalletClient({ baseUrl: opts.baseUrl });
      const identity = await client.authenticate(apiToken);
      saveConfig({ apiToken: identity.apiToken, baseUrl: opts.baseUrl, enterpriseId: identity.enterpriseId });
      printJson(identity);
    }),
  );

program
  .command('create-organization')
  .description('Sign up a new Organization + first Enterprise + admin user (the "create a new account" flow)')
  .requiredOption('--organization-name <name>')
  .requiredOption('--enterprise-name <name>')
  .requiredOption('--admin-name <name>')
  .option('--base-url <url>', 'API base URL', 'http://localhost:4000/api/v1')
  .action((opts) =>
    run(async () => {
      const client = new BitGoAgentWalletClient({ baseUrl: opts.baseUrl });
      const result = await client.createOrganization({
        organizationName: opts.organizationName,
        enterpriseName: opts.enterpriseName,
        adminName: opts.adminName,
      });
      saveConfig({ apiToken: result.apiToken, baseUrl: opts.baseUrl, enterpriseId: result.enterprise.id });
      printJson(result);
    }),
  );

program
  .command('create-enterprise')
  .description('Create an additional Enterprise under your Organization (admin only)')
  .requiredOption('--name <name>')
  .action((opts) =>
    run(async () => {
      printJson(await clientFromConfig().createEnterprise({ name: opts.name }));
    }),
  );

program
  .command('list-enterprises')
  .description('List Enterprises you have access to')
  .action(() =>
    run(async () => {
      printJson(await clientFromConfig().listEnterprises());
    }),
  );

program
  .command('use-enterprise')
  .description('Switch which Enterprise subsequent commands act on')
  .requiredOption('--enterprise-id <id>')
  .action((opts) =>
    run(async () => {
      const client = clientFromConfig();
      const enterprise = await client.getEnterprise(opts.enterpriseId);
      saveConfig({ ...loadConfig(), enterpriseId: enterprise.id });
      printJson({ switchedTo: enterprise.name, enterpriseId: enterprise.id });
    }),
  );

program
  .command('create-agent-wallet')
  .description('Create an agent sub-wallet (Section 6.1)')
  .requiredOption('--name <agentName>', 'Agent name')
  .option('--chain <chain>', 'Chain (ethereum-mainnet | base | optimism | arbitrum)', 'ethereum-mainnet')
  .option('--funding-source <source>', 'allocated_balance | draw_down', 'allocated_balance')
  .option('--allocated-balance <usd>', 'Allocated balance in USD', '0')
  .option('--draw-down-limit <usd>', 'Draw-down limit in USD')
  .option('--autonomy-mode <mode>', 'strict | bounded_auto', 'strict')
  .action((opts) =>
    run(async () => {
      printJson(
        await clientFromConfig().createAgentSubWallet({
          agentName: opts.name,
          chain: opts.chain,
          fundingSource: opts.fundingSource,
          allocatedBalanceUsd: Number(opts.allocatedBalance),
          drawDownLimitUsd: opts.drawDownLimit ? Number(opts.drawDownLimit) : null,
          autonomyMode: opts.autonomyMode,
        }),
      );
    }),
  );

program
  .command('list-agent-wallets')
  .description('List agent sub-wallets on your master account')
  .action(() =>
    run(async () => {
      printJson(await clientFromConfig().listAgentSubWallets());
    }),
  );

program
  .command('create-pact')
  .description('Create a Pact (policy) for an agent sub-wallet (Section 6.2, admin/compliance only)')
  .requiredOption('--sub-wallet-id <id>')
  .option('--max-tx-value <usd>', 'Max per-transaction value (USD)', '1000')
  .option('--daily-cap <usd>', 'Daily spend cap (USD)', '5000')
  .option('--weekly-cap <usd>', 'Weekly spend cap (USD)', '20000')
  .option('--network-allowlist <networks>', 'Comma-separated network allowlist', '')
  .option('--destination-allowlist <addrs>', 'Comma-separated destination allowlist', '')
  .action((opts) =>
    run(async () => {
      printJson(
        await clientFromConfig().createPact({
          subWalletId: opts.subWalletId,
          maxTransactionValueUsd: Number(opts.maxTxValue),
          dailySpendCapUsd: Number(opts.dailyCap),
          weeklySpendCapUsd: Number(opts.weeklyCap),
          networkAllowlist: opts.networkAllowlist ? opts.networkAllowlist.split(',').map((s: string) => s.trim()) : [],
          contractAllowlist: [],
          protocolAllowlist: [],
          destinationAllowlist: opts.destinationAllowlist ? opts.destinationAllowlist.split(',').map((s: string) => s.trim()) : [],
          destinationDenylist: [],
          sessionExpiresAt: null,
          gasSponsorshipCapUsdPerTx: null,
          gasSponsorshipCapUsdPerDay: null,
          gasSponsorshipFallback: 'own_balance',
        }),
      );
    }),
  );

program
  .command('send')
  .description('Submit an agent-initiated transaction (Section 6.3-6.5)')
  .requiredOption('--sub-wallet-id <id>')
  .requiredOption('--to <address>')
  .requiredOption('--value-usd <usd>')
  .option('--network <network>', 'Network', 'ethereum-mainnet')
  .option('--contract-address <address>')
  .option('--protocol <protocol>')
  .option('--function-description <desc>', 'Human-readable description of the call', 'transfer')
  .action((opts) =>
    run(async () => {
      printJson(
        await clientFromConfig().send({
          subWalletId: opts.subWalletId,
          to: opts.to,
          valueUsd: Number(opts.valueUsd),
          network: opts.network,
          contractAddress: opts.contractAddress ?? null,
          protocol: opts.protocol ?? null,
          functionDescription: opts.functionDescription,
        }),
      );
    }),
  );

program
  .command('get-balance')
  .description('Get spendable balance for an agent sub-wallet (Section 6.7 / 6.9)')
  .requiredOption('--sub-wallet-id <id>')
  .action((opts) =>
    run(async () => {
      printJson(await clientFromConfig().getBalance(opts.subWalletId));
    }),
  );

program
  .command('get-status')
  .description('Get the status of a submitted transaction')
  .requiredOption('--transaction-id <id>')
  .action((opts) =>
    run(async () => {
      printJson(await clientFromConfig().getStatus(opts.transactionId));
    }),
  );

program
  .command('revoke')
  .description('Emergency-stop an agent sub-wallet (Section 6.6 kill switch)')
  .requiredOption('--sub-wallet-id <id>')
  .option('--reason <reason>')
  .action((opts) =>
    run(async () => {
      printJson(await clientFromConfig().revoke(opts.subWalletId, opts.reason));
    }),
  );

program
  .command('list-approvals')
  .description('List pending approval requests (Section 6.5)')
  .action(() =>
    run(async () => {
      printJson(await clientFromConfig().listPendingApprovals());
    }),
  );

program
  .command('decide-approval')
  .description('Approve or deny a pending approval request (Section 6.5)')
  .requiredOption('--approval-id <id>')
  .requiredOption('--decision <decision>', 'approve | deny')
  .option('--reason <reason>')
  .action((opts) =>
    run(async () => {
      printJson(await clientFromConfig().decideApproval(opts.approvalId, opts.decision, opts.reason));
    }),
  );

program
  .command('audit-log')
  .description('Query the immutable audit log (Section 6.8)')
  .option('--sub-wallet-id <id>')
  .option('--event-type <type>')
  .option('--limit <n>', 'Max entries', '50')
  .action((opts) =>
    run(async () => {
      printJson(
        await clientFromConfig().queryAuditLog({
          subWalletId: opts.subWalletId,
          eventType: opts.eventType,
          limit: Number(opts.limit),
        }),
      );
    }),
  );

program
  .command('risk-summary')
  .description('Get risk-grading summary for a sub-wallet (Section 5.2 / 12.4)')
  .requiredOption('--sub-wallet-id <id>')
  .action((opts) =>
    run(async () => {
      printJson(await clientFromConfig().getRiskSummary(opts.subWalletId));
    }),
  );

program.parseAsync(process.argv);
