/**
 * x402 Payment Protocol Integration
 *
 * Implements the x402 open payment standard (HTTP 402 Payment Required) so
 * this wallet's API can charge for access to its operations. Uses the
 * self-facilitation pattern: the backend's own treasury key acts as the
 * payment recipient AND the in-process facilitator that verifies and settles
 * payments — no external facilitator service needed.
 *
 * Supports a demo mode (X402_DEMO_MODE=true) that simulates the full 402
 * flow without requiring real on-chain transactions — ideal for demos,
 * integration testing, and CI.
 *
 * The x402 flow:
 *   1. Client requests a protected endpoint with no payment header
 *   2. Server responds 402 + PAYMENT-REQUIRED header (payment requirements)
 *   3. Client signs a payment authorization (EIP-3009 or Permit2) and retries
 *      with PAYMENT-SIGNATURE header
 *   4. Server verifies the authorization via the in-process facilitator
 *   5. Server runs the route handler, then settles the payment on-chain
 *   6. Server responds 200 + PAYMENT-RESPONSE header
 *
 * This module is optional — it only activates when configured. In mock mode
 * or when x402 is not configured, no routes require payment and the
 * middleware is a no-op pass-through.
 *
 * PRD mapping: Section 6.7 Developer Tooling (SDK/CLI/MCP). The x402
 * payment capability makes this wallet consumable by AI agents as a
 * pay-per-use API — the flagship integration from PRD Section 8.
 */

import { ethers } from 'ethers';
import { x402Facilitator } from '@x402/core/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme as registerFacilitatorScheme } from '@x402/evm/exact/facilitator';
import { ExactEvmScheme as ExactEvmServerScheme } from '@x402/evm/exact/server';
import { registerExactEvmScheme as registerServerScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import type { RoutesConfig } from '@x402/core/server';
import type { Network, SupportedResponse } from '@x402/core/types';
import type { PaymentPayload, PaymentRequirements, VerifyResponse, SettleResponse } from '@x402/core/types';
import type { FacilitatorClient } from '@x402/core/server';
import type { RequestHandler } from 'express';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, mainnet, optimism, arbitrum, base } from 'viem/chains';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface X402Config {
  enabled: boolean;
  payToAddress: string;
  network: Network;
  pricePerWrite: string;
  demoMode: boolean;
}

function resolveViemChain(): (typeof baseSepolia | typeof mainnet | typeof optimism | typeof arbitrum | typeof base) | null {
  const rpcUrl = process.env.CHAIN_RPC_URL;
  if (!rpcUrl) return null;

  if (rpcUrl.includes('sepolia')) return baseSepolia;
  if (rpcUrl.includes('mainnet')) return mainnet;
  if (rpcUrl.includes('base') && !rpcUrl.includes('sepolia')) return base;
  if (rpcUrl.includes('optimism')) return optimism;
  if (rpcUrl.includes('arbitrum')) return arbitrum;

  return baseSepolia;
}

function resolveNetwork(): Network {
  const override = process.env.X402_NETWORK;
  if (override) return override as Network;

  const rpcUrl = process.env.CHAIN_RPC_URL;
  if (!rpcUrl) {
    // Base Sepolia has a default USDC asset in the x402 package (eip155:84532).
    // Ethereum Sepolia (eip155:11155111) does not have one configured.
    return 'eip155:84532' as Network;
  }

  if (rpcUrl.includes('sepolia')) return 'eip155:11155111' as Network;
  if (rpcUrl.includes('mainnet')) return 'eip155:1' as Network;
  if (rpcUrl.includes('base')) return 'eip155:8453' as Network;
  if (rpcUrl.includes('optimism')) return 'eip155:10' as Network;
  if (rpcUrl.includes('arbitrum')) return 'eip155:42161' as Network;

  return 'eip155:84532' as Network;
}

function resolveX402Config(): X402Config | null {
  const isDemo = process.env.X402_DEMO_MODE === 'true';

  const rpcUrl = process.env.CHAIN_RPC_URL;
  const factoryAddress = process.env.AGENT_SUB_WALLET_FACTORY_ADDRESS;
  const signingKey =
    process.env.CHAIN_SIGNER_PRIVATE_KEY ??
    process.env.CHAIN_MPC_KEY_SHARE_A ??
    process.env.CHAIN_SIGNER_KEY_SHARES;

  // In demo mode we don't need real chain config.
  if (!isDemo && (!rpcUrl || !factoryAddress || !signingKey)) {
    return null;
  }

  const network = resolveNetwork();

  const expectedAddress = process.env.CHAIN_SIGNER_EXPECTED_ADDRESS;
  let payToAddress = expectedAddress ?? '';
  if (!payToAddress && process.env.CHAIN_SIGNER_PRIVATE_KEY) {
    try {
      payToAddress = new ethers.Wallet(process.env.CHAIN_SIGNER_PRIVATE_KEY).address;
    } catch {
      // fall through
    }
  }
  if (!payToAddress) {
    payToAddress = process.env.X402_PAY_TO_ADDRESS ?? '';
  }
  // In demo mode, use a placeholder address if none configured.
  if (!payToAddress && isDemo) {
    payToAddress = '0x0000000000000000000000000000000000000001';
  }

  if (!payToAddress || !ethers.isAddress(payToAddress)) {
    // eslint-disable-next-line no-console
    console.warn('[x402] Cannot determine payTo address — x402 disabled');
    return null;
  }

  const pricePerWrite = process.env.X402_PRICE_PER_WRITE ?? '0.001';

  return {
    enabled: true,
    payToAddress,
    network,
    pricePerWrite,
    demoMode: isDemo,
  };
}

// ---------------------------------------------------------------------------
// Mock facilitator (demo mode)
// ---------------------------------------------------------------------------

class MockFacilitator implements FacilitatorClient {
  async verify(
    _paymentPayload: PaymentPayload,
    _paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return {
      isValid: true,
      payer: '0x0000000000000000000000000000000000000002',
    };
  }

  async settle(
    _paymentPayload: PaymentPayload,
    _paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return {
      success: true,
      transaction: '[SECRET:ethereum-private-key]',
      network: resolveNetwork(),
      payer: '0x0000000000000000000000000000000000000002',
    };
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: resolveNetwork(),
        },
      ],
      extensions: [],
      signers: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Route configuration
// ---------------------------------------------------------------------------

function buildRoutesConfig(config: X402Config): RoutesConfig {
  const { payToAddress, network, pricePerWrite } = config;

  const accepts = [
    {
      scheme: 'exact' as const,
      price: `$${pricePerWrite}`,
      network,
      payTo: payToAddress,
    },
  ];

  return {
    'POST /sub-wallets': {
      accepts,
      description: 'Create an agent sub-wallet (deploys on-chain account)',
      mimeType: 'application/json',
    },
    'POST /transactions': {
      accepts,
      description: 'Submit a transaction (moves real value on-chain)',
      mimeType: 'application/json',
    },
    'POST /approvals/:id/approve': {
      accepts,
      description: 'Approve a pending transaction',
      mimeType: 'application/json',
    },
    'POST /approvals/:id/deny': {
      accepts,
      description: 'Deny a pending transaction',
      mimeType: 'application/json',
    },
    'POST /incoming/:id/release': {
      accepts,
      description: 'Release a quarantined incoming transaction',
      mimeType: 'application/json',
    },
    'POST /sub-wallets/:id/suspend': {
      accepts,
      description: 'Emergency-suspend a sub-wallet',
      mimeType: 'application/json',
    },
    'POST /sub-wallets/:id/autonomy-mode': {
      accepts,
      description: 'Change autonomy mode of a sub-wallet',
      mimeType: 'application/json',
    },
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

let x402MiddlewareInitialized = false;

async function buildMiddleware(config: X402Config): Promise<RequestHandler> {
  let server: x402ResourceServer;

  if (config.demoMode) {
    // Demo mode: use the mock facilitator — no real chain interaction.
    const mockFacilitator = new MockFacilitator();
    server = new x402ResourceServer(mockFacilitator);
    registerServerScheme(server);
    // eslint-disable-next-line no-console
    console.log('[x402] DEMO MODE — payments are simulated, no on-chain transactions');
  } else {
    // Real mode: build a viem wallet client for the facilitator signer.
    const privateKey = process.env.CHAIN_SIGNER_PRIVATE_KEY ?? process.env.X402_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('No signing key for x402 facilitator');
    }

    const viemChain = resolveViemChain();
    if (!viemChain) {
      throw new Error('Cannot resolve viem chain from CHAIN_RPC_URL');
    }

    const rpcUrl = process.env.CHAIN_RPC_URL!;
    const evmAccount = privateKeyToAccount(privateKey as `0x${string}`);

    const viemClient = createWalletClient({
      account: evmAccount,
      chain: viemChain,
      transport: http(rpcUrl),
    }).extend(publicActions);

    const evmSigner = toFacilitatorEvmSigner({
      address: evmAccount.address,
      getCode: viemClient.getCode,
      readContract: viemClient.readContract,
      verifyTypedData: async (args) => viemClient.verifyTypedData(args as Parameters<typeof viemClient.verifyTypedData>[0]),
      writeContract: viemClient.writeContract,
      sendTransaction: viemClient.sendTransaction,
      waitForTransactionReceipt: viemClient.waitForTransactionReceipt,
    });

    const facilitator = new x402Facilitator();
    registerFacilitatorScheme(facilitator, {
      signer: evmSigner,
      networks: config.network,
    });

    server = new x402ResourceServer({
      verify: (paymentPayload, paymentRequirements) =>
        facilitator.verify(paymentPayload, paymentRequirements),
      settle: (paymentPayload, paymentRequirements) =>
        facilitator.settle(paymentPayload, paymentRequirements),
      getSupported: async () => {
        const supported = await facilitator.getSupported();
        return {
          ...supported,
          kinds: supported.kinds.map(k => ({ ...k, network: k.network as `${string}:${string}` })),
        };
      },
    });
    registerServerScheme(server);
  }

  const routes = buildRoutesConfig(config);

  x402MiddlewareInitialized = true;
  return paymentMiddleware(routes, server);
}

/**
 * Creates and returns the x402 payment middleware for the Express app.
 *
 * When X402_DEMO_MODE=true, uses a mock facilitator that simulates payments
 * without on-chain transactions — ideal for demos and integration testing.
 *
 * Returns null when x402 is not configured — the app skips adding the
 * middleware entirely and all routes remain free.
 */
export async function createX402Middleware(): Promise<RequestHandler | null> {
  if (x402MiddlewareInitialized) {
    return null;
  }

  const config = resolveX402Config();
  if (!config) {
    // eslint-disable-next-line no-console
    console.log('[x402] Not configured — no payment required for any endpoint');
    return null;
  }

  // eslint-disable-next-line no-console
  console.log(`[x402] Enabling payment required for write endpoints — payTo: ${config.payToAddress}, network: ${config.network}, price: $${config.pricePerWrite}`);

  return buildMiddleware(config);
}
