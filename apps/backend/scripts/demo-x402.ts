#!/usr/bin/env tsx
/**
 * x402 Micropayment Demo — TypeScript
 *
 * Demonstrates the full HTTP 402 Payment Required flow using the SDK's
 * x402 client support. In demo mode (X402_DEMO_MODE=true), payments
 * are simulated — no real on-chain transactions needed.
 *
 * Usage:
 *   X402_DEMO_MODE=true npm run dev:backend &
 *   npx tsx apps/backend/scripts/demo-x402.ts
 */

import { BitGoAgentWalletClient } from '@bitgo-agent-wallet/sdk';
import { toClientEvmSigner } from '@bitgo-agent-wallet/sdk';

const DEMO_PORT = 4098;
const BASE_URL = `http://localhost:${DEMO_PORT}/api/v1`;

async function main() {
  console.log('============================================');
  console.log('  x402 Micropayment Demo');
  console.log('============================================');
  console.log('');

  // ── 1. Create SDK client WITHOUT x402 signer ────────────────────────
  console.log('Step 1: Creating SDK client without x402 signer...');
  const client = new BitGoAgentWalletClient({
    baseUrl: BASE_URL,
    apiToken: 'demo-admin-token',
  });

  // ── 2. Try to create a sub-wallet (no payment → 402) ────────────────
  console.log('Step 2: Creating sub-wallet WITHOUT x402 payment...');
  console.log('');

  try {
    await client.createAgentSubWallet({
      agentName: 'Demo Trading Bot',
      chain: 'ethereum-mainnet',
      fundingSource: 'allocated_balance',
      allocatedBalanceUsd: 10000,
      autonomyMode: 'bounded_auto',
    });
    console.log('  (unexpected: request succeeded without payment)');
  } catch (err: unknown) {
    const apiErr = err as { httpStatus?: number; message?: string; code?: string };
    if (apiErr.httpStatus === 402) {
      console.log('  402 Payment Required — as expected!');
      console.log(`  Error: ${apiErr.message}`);
      console.log('');
    } else {
      console.log(`  Unexpected error: ${apiErr.message ?? err}`);
      process.exit(1);
    }
  }

  // ── 3. Create SDK client WITH x402 signer ──────────────────────────
  console.log('Step 3: Creating SDK client with x402 signer...');
  console.log('');

  // Create a simple signer for demo purposes.
  // In demo mode, the mock facilitator accepts any signature.
  const demoSigner = toClientEvmSigner({
    address: '0x0000000000000000000000000000000000000002' as `0x${string}`,
    signTypedData: async () => '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  });

  const payingClient = new BitGoAgentWalletClient({
    baseUrl: BASE_URL,
    apiToken: 'demo-admin-token',
    x402Signer: demoSigner,
  });

  // ── 4. Create sub-wallet WITH x402 payment ──────────────────────────
  console.log('Step 4: Creating sub-wallet WITH x402 payment...');
  console.log('');

  try {
    const result = await payingClient.createAgentSubWallet({
      agentName: 'Demo Trading Bot',
      chain: 'ethereum-mainnet',
      fundingSource: 'allocated_balance',
      allocatedBalanceUsd: 10000,
      autonomyMode: 'bounded_auto',
    });

    console.log('  200 OK — Payment accepted, sub-wallet created!');
    console.log('');
    console.log('  Sub-wallet:');
    console.log(`    ID:     ${result.id}`);
    console.log(`    Name:   ${result.agentName}`);
    console.log(`    Status: ${result.status}`);
    console.log(`    Mode:   ${result.autonomyMode}`);
    console.log('');

    console.log('============================================');
    console.log('  DEMO SUCCESSFUL');
    console.log('============================================');
    console.log('');
    console.log('The x402 micropayment flow works end-to-end:');
    console.log('  1. Request without payment  → 402 Payment Required');
    console.log('  2. Request with x402 signer → 200 OK');
    console.log('');
    console.log('To try with REAL on-chain payments:');
    console.log('  1. Set CHAIN_RPC_URL, CHAIN_SIGNER_PRIVATE_KEY, etc.');
    console.log('  2. Remove X402_DEMO_MODE or set it to false');
    console.log('  3. Ensure the facilitator has ETH for gas');
    console.log('  4. Ensure the payer has USDC (or the configured token)');
    console.log('');
  } catch (err: unknown) {
    const apiErr = err as { httpStatus?: number; message?: string };
    console.log(`  Error: ${apiErr.message ?? err}`);
    process.exit(1);
  }
}

main().catch(console.error);
