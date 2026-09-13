# @bitgo-agent-wallet/contracts

**Prototype / demo contracts - not audited, not for production use.** Standing
in for the PRD's ERC-7579 modular smart account (Section 10.1); a real BitGo
Agent Wallet would adopt an audited implementation (Safe/Biconomy/ZeroDev-style),
per the PRD's own note (Section 6.10) that BitGo should not ship a custom
unaudited delegator.

- `AgentSubWallet.sol` - minimal owner-gated wallet (`execute()`, EIP-1271 stub).
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

## Deployed instance (Sepolia)

- **AgentSubWalletFactory**: [`0x97FCa4F8B07C7645552925860673943C086C6189`](https://sepolia.etherscan.io/address/0x97FCa4F8B07C7645552925860673943C086C6189)
  ([deploy tx](https://sepolia.etherscan.io/tx/0xe07ccbb70013b2e1f8bdb035945e44632915967641c2bfd1048bbcecb723cd9e))
- Verified end-to-end via `smoke-test:sepolia`: CREATE2 address prediction
  matched the actual deployment exactly, and the owner-gated `execute()` call
  succeeded on-chain.
