# @bitgo-agent-wallet/contracts

**Prototype / demo contracts - not audited, not for production use.** Standing
in for the PRD's ERC-7579 modular smart account (Section 10.1); a real BitGo
Agent Wallet would adopt an audited implementation (Safe/Biconomy/ZeroDev-style),
per the PRD's own note (Section 6.10) that BitGo should not ship a custom
unaudited delegator.

- `AgentSubWallet.sol` - minimal owner-gated wallet (`execute()`, EIP-1271 stub,
  and `executeWithGasRefund()` - see "Gas sponsorship" below).
- `AgentSubWalletFactory.sol` - CREATE2 factory, one call deploys + initializes a
  wallet. Mirrors wallet-platform's `AbstractEthLikeWalletDeployer` pattern.

## Setup

```bash
npm install                       # from repo root, or npm install --workspace packages/contracts
cd packages/contracts
npm run generate-wallet           # creates a throwaway deployer key in .env (gitignored)
```

Fund the printed address with Sepolia ETH from a faucet, e.g.:
- https://cloud.google.com/application/web3/faucet/ethereum/sepolia (Google Cloud, no login beyond a Google account)
- https://www.alchemy.com/faucets/ethereum-sepolia
- https://sepoliafaucet.com (Alchemy-hosted)
- https://faucet.quicknode.com/ethereum/sepolia

You only need a small amount (0.02-0.05 Sepolia ETH is plenty).

```bash
npm run check-balance             # confirm funds arrived (Sepolia)
npm run compile
npm run deploy:sepolia            # writes deployments/sepolia.json
```

Base Sepolia is also configured (`npm run deploy:baseSepolia` /
`npm run check-balance:baseSepolia`) if you switch chains later - same deployer
key works on both.

## After deploying

`deployments/sepolia.json` has the factory address. `apps/backend` is wired to
call this factory for real when configured (`apps/backend/.env` -
`CHAIN_RPC_URL` / `CHAIN_SIGNER_PRIVATE_KEY` / `AGENT_SUB_WALLET_FACTORY_ADDRESS`)
- see `apps/backend/src/services/chainExecutor.ts` and the root README's
"On-chain contracts" section. Without that config it falls back to a mock.

```bash
npm run smoke-test:sepolia        # predicts an address, deploys through the
                                   # factory, confirms the prediction, exercises
                                   # execute()
```

## Gas sponsorship: who actually pays, on-chain

The backend's treasury signer broadcasts *every* transaction (it's the only
address any sub-wallet recognizes as its `owner`), but which contract function
it calls decides who ends up paying for the gas (Section 6.10;
`apps/backend/src/services/gasSponsorshipService.ts` makes the decision,
`chainExecutor.ts` acts on it):

- **Sponsored** - plain `execute()`. The treasury pays gas out of pocket and
  is never reimbursed - genuinely gas-free for the agent/sub-wallet.
- **Not sponsored** (a Pact's sponsorship cap was exceeded, fallback =
  `own_balance`) - `executeWithGasRefund()` instead. Same call, but the
  sub-wallet's own ETH balance reimburses the treasury for (an approximation
  of) this call's gas cost, via a real transfer emitted as `GasRefunded`.

The refund is necessarily approximate - a known limitation of on-chain
gas-refund patterns (the same one GSN v1's `postRelayedCall` has): sampling
`gasleft()` from inside the function under-counts the flat 21000 base
transaction cost, the calldata's own gas, and the refund transfer's own gas.
Documented in the contract rather than hidden; it under-refunds rather than
over-charging the sub-wallet, and never blocks the underlying `execute()` call
if the sub-wallet can't cover the refund in full.

Verified against Sepolia (`npm run smoke-test-gas-refund:sepolia`,
`scripts/smokeTestGasRefund.ts`): funded a fresh sub-wallet, called
`executeWithGasRefund`, and independently confirmed via separate balance
reads (not just the event log) that the sub-wallet's balance dropped by
exactly the refunded amount and the owner's balance changed by exactly
`refund - its own tx gas cost`.

## Deployed instance (Sepolia)

- **AgentSubWalletFactory**: [`0x1BB2A18BA48204B600D5122395e2CBa7B46A0A9a`](https://sepolia.etherscan.io/address/0x1BB2A18BA48204B600D5122395e2CBa7B46A0A9a)
  ([deploy tx](https://sepolia.etherscan.io/tx/0xa6ddfbe70ea1c0fa4a46eccf09d4d54ee01598e4531759e0f111e4d09b3c6b63))
  - redeployed to add `executeWithGasRefund` / `GasRefunded` to
    `AgentSubWallet` (its bytecode is embedded in the factory's `CREATE2`
    creation code, so a contract change means a new factory address). The
    prior factory (`0x97FCa4F8B07C7645552925860673943C086C6189`) still exists
    on-chain but is no longer referenced by the backend.
- Verified end-to-end via `smoke-test:sepolia`: CREATE2 address prediction
  matched the actual deployment exactly, and the owner-gated `execute()` call
  succeeded on-chain.
