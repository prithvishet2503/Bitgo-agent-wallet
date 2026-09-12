import { type SimulationResult, type TransactionRequestInput, nowIso } from '@bitgo-agent-wallet/shared';

/**
 * Section 6.3 - Pre-Execution Simulation.
 * "Every transaction is simulated prior to signature: shows resulting balance
 * changes, contract interactions, and estimated fees."
 *
 * This mocks the chain-simulation call (e.g. eth_call / Tenderly-style trace) BitGo
 * would make in production. Non-Functional Requirements (Section 7) cap simulation +
 * screening latency at ~1-2s for non-flagged transactions - this mock is
 * near-instant, which stays comfortably inside that budget.
 */
export function simulate(request: TransactionRequestInput): SimulationResult {
  // Deterministic mock fee model: flat base fee + 0.05% of transferred value.
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
