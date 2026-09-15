import { type SimulationResult, type TransactionRequestInput, nowIso } from '@bitgo-agent-wallet/shared';
import { chainExecutor } from './chainExecutor.js';

/**
 * Section 6.3 - Pre-Execution Simulation.
 * "Every transaction is simulated prior to signature: shows resulting balance
 * changes, contract interactions, and estimated fees."
 *
 * Two modes, mirroring the ChainExecutor split:
 *
 * - **Real mode** (chainExecutor.mode === 'real', sub-wallet deployed): a
 *   genuine `eth_call` of the exact `AgentSubWallet.execute()` call that
 *   `executeTransaction` would broadcast - run from the owner so the
 *   onlyOwner gate passes - plus `estimateGas` for real gas units at the live
 *   gas price (fee computed inside the executor, which owns the provider).
 *   A predicted revert is caught here, before anything is signed or queued
 *   (previously a revert only surfaced at broadcast time, leaving the
 *   transaction stuck `approved` in the SendQueue).
 *
 * - **Mock mode**: the deterministic placeholder model (flat fee + 0.05% of
 *   value; a destination containing "revert" exercises the failure path).
 *   Demo addresses like `0xdest1` only exist in this mode by design.
 *
 * Non-Functional Requirements (Section 7) cap simulation + screening latency
 * at ~1-2s for non-flagged transactions; the mock path is near-instant, and
 * the real path is one eth_call + one estimateGas against the configured RPC.
 */
export async function simulate(
  request: TransactionRequestInput,
  subWallet?: { address: string | null },
): Promise<SimulationResult> {
  // Real path: only when the executor is live AND this sub-wallet actually
  // has an on-chain address to simulate against.
  if (chainExecutor.mode === 'real' && subWallet?.address && chainExecutor.simulateTransaction) {
    const result = await chainExecutor.simulateTransaction({
      subWalletAddress: subWallet.address,
      to: request.to,
      valueUsd: request.valueUsd,
    });
    // estimateGas/getFeeData unavailable on the RPC - fall back to the mock
    // fee model rather than blocking a call eth_call says will succeed.
    const estimatedFeeUsd =
      result.estimatedFeeUsd ?? Number((0.5 + request.valueUsd * 0.0005).toFixed(2));
    return {
      simulatedAt: nowIso(),
      estimatedFeeUsd,
      balanceChanges: [
        { asset: 'USD', deltaUsd: -request.valueUsd },
        { asset: 'GAS', deltaUsd: -estimatedFeeUsd },
      ],
      contractInteractions: request.contractAddress ? [request.contractAddress] : [],
      willSucceed: result.willSucceed,
      failureReason: result.failureReason,
    };
  }

  // Deterministic mock model (mock chain mode, or a sub-wallet still pending
  // deployment in real mode - the pipeline blocks those before simulation
  // anyway, so this is defense in depth).
  const estimatedFeeUsd = Number((0.5 + request.valueUsd * 0.0005).toFixed(2));

  // A destination address containing "revert" lets the demo/tests exercise the
  // simulation-failure path without a real chain.
  const willSucceed = !request.to.toLowerCase().includes('revert');

  return {
    simulatedAt: nowIso(),
    estimatedFeeUsd,
    balanceChanges: [
      { asset: 'USD', deltaUsd: -request.valueUsd },
      { asset: 'GAS', deltaUsd: -estimatedFeeUsd },
    ],
    contractInteractions: request.contractAddress ? [request.contractAddress] : [],
    willSucceed,
    failureReason: willSucceed ? null : 'Simulated execution reverted',
  };
}
