# BitGo Agent Wallet

A working implementation of the [BitGo Agent Wallet PRD](./docs/PRD.pdf) v1 scope:
an institutional-grade agentic wallet with governance-conservative defaults
(Strict Mode by default, deny-on-timeout, hard-blocking screening) layered on top
of mocked BitGo custody primitives.

This is a prototype: **MPC/HSM key management, real chain RPC, and the
threat/sanctions screening vendor are all mocked** so the repo runs standalone
with no external dependencies. Every governance rule from PRD Section 6 (Policy
& Pact Engine, pre-execution checks, autonomy modes, human approval, kill switch,
audit log, incoming-transaction quarantine, EIP-7702 gas sponsorship) is real,
enforced business logic — not a stub. Its internal architecture (layering,
account hierarchy, and how chain interaction is structured) deliberately mirrors
the patterns used in BitGo's real microservices (`wallet-platform` and
`user-management-service`) rather than inventing its own conventions - see
"Architecture patterns mirrored from BitGo's real services" below.

## Architecture

```
packages/shared      Domain types + zod schemas shared by every app (Section 6 data model)
packages/sdk         TypeScript SDK - thin, fully-typed client over the REST API
packages/sdk-python  Python SDK - mirrors the TS client (Section 6.7: "at minimum TypeScript/Python")
packages/contracts   Prototype/demo smart contracts (Hardhat), deployed live to Sepolia testnet
apps/backend         Express API + all governance business logic (in-memory store)
apps/frontend        React admin console (Vite) - the institutional/compliance UI
apps/cli             CLI (Section 6.7: authenticate, create-agent-wallet, send, get-balance, get-status, revoke, ...)
apps/mcp-server      MCP server (Section 6.7) - lets agent frameworks call the wallet directly
```

### On-chain contracts (Sepolia) - wired up live

`packages/contracts` has a minimal `AgentSubWalletFactory` + `AgentSubWallet`
pair (prototype/demo, not audited - see that package's README) deployed live to
Ethereum Sepolia: factory at
[`0x97FCa4F8B07C7645552925860673943C086C6189`](https://sepolia.etherscan.io/address/0x97FCa4F8B07C7645552925860673943C086C6189).

The backend can drive this factory for real. `apps/backend/src/services/chainExecutor.ts`
has two implementations of a `ChainExecutor` interface:

- **`MockChainExecutor`** (default) - fake addresses/tx hashes, zero network
  calls, so the app runs standalone with no external dependency.
- **`RealChainExecutor`** - real `ethers.js` calls against the deployed
  contracts. Activates when `CHAIN_RPC_URL`, `AGENT_SUB_WALLET_FACTORY_ADDRESS`,
  and a signing key (`CHAIN_SIGNER_PRIVATE_KEY` or `CHAIN_SIGNER_KEY_SHARES` -
  see "Custody" below) are set (see `apps/backend/.env.example`). Verified
  working end-to-end, with independently-checked on-chain proof, not just
  self-reported success:
  - Creating an agent sub-wallet really deploys an `AgentSubWallet` via the
    factory on Sepolia, then really funds it with real ETH.
  - Submitting a transaction to a real address really calls its `execute()`
    on-chain and really moves real ETH - confirmed by reading the
    destination's and the sub-wallet's balances before and after (a $200
    transaction at the default demo rate moved exactly 0.0002 ETH; the
    sub-wallet's on-chain balance dropped by exactly that amount).

Submitting a transaction to a non-address (e.g. a demo placeholder like
`0xdest1`) in real mode fails the broadcast cleanly - the transaction stays
`approved` (queued, retryable) and the SendQueue entry is marked failed with a
clear error, rather than crashing. Use a real hex address to see a transaction
reach `executed` in real mode.

**Note on value**: the ETH/USD exchange rate is now real -
[Chainlink Price Feeds](https://docs.chain.link/data-feeds/price-feeds/addresses),
the standard decentralized on-chain price oracle for EVM chains, read live via
`services/priceOracle.ts` (a plain contract call through the same RPC provider
`chainExecutor.ts` already holds - no API key, no signup). What's still a
deliberate demo choice is `CHAIN_VALUE_SCALE_FACTOR` (default `0.0005`): it
scales the *amount* of that real rate actually moved on-chain down to a
testnet-safe size, so a `valueUsd` figure turns into a real-but-tiny wei
amount without requiring testnet ETH in amounts that would be annoying to
keep re-funding. Each newly deployed `AgentSubWallet` is funded with
`CHAIN_SUB_WALLET_FUNDING_ETH` (default `0.0003` ETH) so it has a real balance
to draw from, and the backend never sends itself below
`CHAIN_MIN_TREASURY_RESERVE_ETH` doing so.

Verified: a $100 transaction at a live-fetched price of $2,481.04/ETH computed
to exactly 20,152,844,384,953 wei (0.0000201528... ETH) - confirmed to be
exactly the amount the destination address's on-chain balance increased by.
`GET /api/v1/chain/status` reports the live price, its source feed, treasury
balance, and custody scheme on demand (not cached).

### Custody: real threshold-ECDSA MPC via BitGo's own DKLS library

Three custody options, in order of preference (`services/keyCustody.ts` picks
whichever is configured):

**1. Real MPC (`CHAIN_MPC_KEY_SHARE_A`/`_B`, recommended).** Uses
[`@bitgo/sdk-lib-mpc`](https://www.npmjs.com/package/@bitgo/sdk-lib-mpc) -
BitGo's own published, audited DKLS threshold-ECDSA implementation, the same
library their production TSS wallets use for ECDSA coins. Generate a real
2-of-2 key pair with `npm run generate-mpc-keys` (runs an actual multi-round
DKG ceremony). `services/mpcSigner.ts` implements `DklsMpcSigner`, a real
`ethers.AbstractSigner` - it drops into `ethers.Contract(...)` exactly like
`ethers.Wallet` does, but every `signTransaction()` call runs a full 5-round
Distributed Signature Generation (DSG) ceremony between two parties (each
holding only its own key share) to produce the signature. **The complete
private key never exists as a single value anywhere, in any process, at any
point** - not even transiently. That's a different and stronger guarantee than
option 2 below.

Verified with three independent on-chain checks: derived an address from a
real DKG ceremony, funded it, then deployed a real `AgentSubWallet` and
executed a real value-moving transaction - both signed via the DSG ceremony -
and confirmed via direct RPC (`getTransactionReceipt`) that `from` matched the
MPC-derived address exactly and `to` matched the deployed contract, with
`status: 1`.

**2. Shamir's Secret Sharing (`CHAIN_SIGNER_KEY_SHARES`).** M-of-N custody via
the [`shamir-secret-sharing`](https://github.com/privy-io/shamir-secret-sharing)
library (independently audited by Cure53 and Zellic). Generate shares from an
existing key with `npm run split-key -- <privateKeyHex> 3 2` (3 shares, 2
required). Reconstructs the key fresh for every signing operation rather than
keeping it resident in memory for the process's lifetime - genuinely removes
any single point of *storage* for the complete key, but still assembles it
transiently to sign. Verified: split a key into 3 shares, ran the backend on
only 2, confirmed it reconstructed the identical address and successfully
deployed + funded + executed against it on Sepolia.

**3. Single hot key (`CHAIN_SIGNER_PRIVATE_KEY`).** Simplest, one point of
storage.

All three verify against `CHAIN_SIGNER_EXPECTED_ADDRESS` if set. Options 1 and
2 both run every party/share in the same backend process for this prototype -
for MPC that's a deployment simplification, not a cryptographic one (moving
Party B to a genuinely separate service later changes nothing about the
protocol); for Shamir, running the parts of a real deployment that reconstruct
the key on one machine is exactly the risk splitting it is meant to reduce, so
option 1 is the more honest "real" answer to "no single point holds the key."

### Where signing and broadcasting happen - a deliberate divergence from BitGo

wallet-platform's real split: a narrow KMS/MPC interface
(`SingleSigKmsProvider`) does the signing, and a *separate* service (a Kafka
worker / indexer) consumes `SendQueue` and does the broadcasting - two
different services, two different trust boundaries.

This repo does not have that second service. `scheduler/sendQueueWorker.ts`
dequeues a `SendQueueEntry` and calls straight into `chainExecutor.ts` in the
same backend process, which holds the key, signs, and submits to the chain in
one step. The `SendQueue` still exists and is still real (chain-touching work
is never done inline inside an HTTP request - see below), but it exists purely
to keep chain latency off the request path, not to hand work to another
service or trust boundary.

The SDK, CLI, MCP server, and frontend are all thin clients of the same backend
REST API, so there is exactly one implementation of the governance logic
(`apps/backend/src/services/*`).

### Account hierarchy: Organization → Enterprise → Agent Sub-Wallet

Mirrors BitGo's real `user-management-service` model (`OrganizationEntity` →
`EnterpriseEntity`, wallets as permissioned resources under an Enterprise):

- **Organization** - the top-level tenant. Created via `POST /api/v1/organizations`
  ("sign up my institution"), which also creates a first **Enterprise** and admin
  **User** in one call and returns that user's API token.
- **Enterprise** - what the rest of this PRD calls a "master account". An
  Organization can have more than one (separate business units, fund entities);
  an admin creates additional ones via `POST /api/v1/enterprises`.
- **Agent Sub-Wallet** - nested under exactly one Enterprise (Section 6.1).

A user's requests act on their home Enterprise by default; if they have access to
more than one, they select which via the `X-Enterprise-Id` header (the console
exposes this as the sidebar's Enterprise switcher; the SDK via
`client.setEnterpriseId()`).

### Data-access layer (DAO pattern) - and real persistence

Services never touch storage directly - they call a `dal/models/*.dao.ts`
singleton (`subWalletDao`, `pactDao`, `enterpriseDao`, ...) implementing a shared
`BaseDao` interface (`apps/backend/src/dal/base.dao.ts`), mirroring
wallet-platform's `app/dal/interfaces/base.dao.ts` + `app/dal/models/*.dao.ts`.

This paid off directly: `apps/backend/src/store/db.ts` now persists to SQLite
by default (`data/bitgo-agent-wallet.sqlite`, gitignored) via
`store/sqliteMap.ts` - a `Map`-compatible wrapper around `better-sqlite3` - and
**nothing else changed**. Every `dal/models/*.dao.ts` file and every service
built on it is exactly as it was; only `db.ts` knows storage is now a real
file instead of memory. Verified: created a sub-wallet, killed the backend
process outright, confirmed the port was free, started a fresh process, and
the sub-wallet (including its real on-chain address) was still there. Set
`PERSISTENCE_MODE=memory` to opt back into wipe-on-restart (tests, throwaway
demos).

### Smart-contract interaction: build-and-queue, never inline

An HTTP request never signs or broadcasts anything itself. It validates,
builds, and enqueues a `SendQueueEntry` (`services/sendQueueService.ts`); the
background worker (`scheduler/sendQueueWorker.ts`) dequeues it and calls
`chainExecutor.ts` (mock or real - see above) to actually deploy/execute. This
governs both:

- **Agent sub-wallet deployment** (Section 6.1) - a new sub-wallet is created with
  `pendingDeployment: true` and `address: null`; the worker resolves its real
  address once on-chain deployment completes (real block time in real mode).
- **Transaction execution** (Sections 6.3-6.5) - a compliant/approved transaction
  moves to `approved` (queued) before the worker flips it to `executed`.

A transaction submitted while its sub-wallet is still `pendingDeployment` is
denied immediately (`SUB_WALLET_NOT_DEPLOYED`) rather than racing ahead of a
deployment that, in real mode, hasn't actually landed on-chain yet.

## PRD section → code map

| PRD section | Implementation |
| --- | --- |
| 6.1 Agent Sub-Wallet Creation | `apps/backend/src/services/subWalletService.ts` |
| 6.2 Policy / Pact Engine | `apps/backend/src/services/pactService.ts` |
| 6.3 Pre-Execution Checks | `apps/backend/src/services/simulationService.ts`, `screeningService.ts` |
| 6.4 Autonomy Modes | `apps/backend/src/services/transactionService.ts` (routing), `subWalletService.ts` (mode changes) |
| 6.5 Human Approval Flow | `apps/backend/src/services/approvalService.ts`, `scheduler/approvalTimeoutSweeper.ts` |
| 6.6 Emergency Stop | `subWalletService.suspendSubWallet` |
| 6.7 Developer Tooling | `packages/sdk`, `packages/sdk-python`, `apps/cli`, `apps/mcp-server` |
| 6.8 Audit & Compliance | `apps/backend/src/services/auditService.ts` |
| 6.9 Incoming Transaction Screening | `apps/backend/src/services/incomingScreeningService.ts` |
| 6.10 Gas Sponsorship (EIP-7702) | `apps/backend/src/services/gasSponsorshipService.ts`, `chainExecutor.ts`, `sendQueueService.ts` |
| RBAC (named permissions) | `packages/shared/src/types/permissions.ts` |
| Organization/Enterprise signup | `apps/backend/src/services/organizationService.ts`, `enterpriseService.ts` |

Every service file has a doc comment citing the exact PRD section (or BitGo
microservice pattern) it implements.

## Running it

```bash
npm install
npm run build          # builds packages/shared -> packages/sdk -> everything else, in order
```

Start the backend (seeds a demo Organization/Enterprise + 4 role-scoped users):

```bash
npm run dev:backend    # http://localhost:4000
```

Start the console:

```bash
npm run dev:frontend   # http://localhost:5173, proxies /api to :4000
```

Log in with one of the seeded demo tokens (shown on the login screen):
`demo-admin-token`, `demo-compliance-token`, `demo-dev-token`, `demo-viewer-token`.
Or use the **Create organization** tab to sign up a brand-new tenant from scratch.

By default the backend runs in mock chain mode with SQLite persistence (no
setup needed beyond `npm install`). To make it actually deploy/execute on
Sepolia:

```bash
cd apps/backend
cp .env.example .env
# Recommended: npm run generate-mpc-keys, then set CHAIN_MPC_KEY_SHARE_A/_B +
#   CHAIN_SIGNER_EXPECTED_ADDRESS from its output and fund that address.
# Simpler alternatives: npm run split-key (Shamir), or just
#   CHAIN_SIGNER_PRIVATE_KEY with a funded Sepolia key.
# (AGENT_SUB_WALLET_FACTORY_ADDRESS already points at the deployed factory)
npm run dev   # or: node dist/index.js after npm run build
```

The startup log says which mode it's in and which custody scheme:
`[chainExecutor] REAL mode - custody: ...` or `[chainExecutor] MOCK mode - ...`.

### CLI

```bash
cd apps/cli
node dist/index.js authenticate demo-admin-token
# or: node dist/index.js create-organization --organization-name "Acme" --enterprise-name "Acme Treasury" --admin-name "You"
node dist/index.js create-agent-wallet --name "Treasury Bot" --allocated-balance 50000 --autonomy-mode bounded_auto
node dist/index.js create-pact --sub-wallet-id <id> --max-tx-value 5000 --daily-cap 20000 --weekly-cap 50000
node dist/index.js send --sub-wallet-id <id> --to 0xdest1 --value-usd 1000
node dist/index.js get-status --transaction-id <id>
node dist/index.js revoke --sub-wallet-id <id> --reason "compromised key"
node dist/index.js create-enterprise --name "Trading Desk"   # additional Enterprise under your Organization
node dist/index.js use-enterprise --enterprise-id <id>       # switch which one commands act on
```

### MCP server

```bash
BITGO_AGENT_WALLET_API_TOKEN=demo-dev-token node apps/mcp-server/dist/index.js
```

Point an MCP-compatible agent framework (Claude Code, LangChain, etc. - the
flagship integration called out in PRD Section 8) at this stdio server to let it
create sub-wallets, submit transactions, and check status/balance directly.

## Demo flow worth trying

1. Log in as **Ava Admin** (admin), or use **Create organization** to sign up fresh.
2. Create an agent sub-wallet in **Bounded Auto** mode - note its address shows
   "Pending" for a moment while the SendQueue worker "deploys" it.
3. Create a Pact with a low max-transaction-value cap.
4. Submit a transaction under the cap → status goes `approved` → `executed`
   within ~1.5s as the SendQueue worker picks it up.
5. Submit a transaction over the cap → escalates to **Approvals** with the
   specific policy violation shown; approve or deny it there.
6. Try sending to `0xsanctioned0001`, a real address from the live OFAC feed
   (check `GET /api/v1/screening/status`), or a real known-bad address like
   the Ronin bridge exploiter (`0x098B716B8Aaf21512996dC57EB0615e2383E2f96`,
   flagged live by GoPlus) → hard-blocked by screening regardless of autonomy
   mode.
7. Record an incoming transaction from `0xsanctioned0001` on the sub-wallet
   detail page → it's quarantined; release it from **Incoming Quarantine**.
8. Check **Audit Log** - every step above is there, immutably, including the
   `SUB_WALLET_DEPLOYMENT_QUEUED` / `SUB_WALLET_DEPLOYED` and
   `TRANSACTION_QUEUED_FOR_BROADCAST` / `TRANSACTION_EXECUTED` pairs.
9. From the sidebar, click **+ New enterprise** to create a second Enterprise
   under the same Organization and switch to it.

## What's real now, and what's still mocked

Real, with independently-verified on-chain/on-disk proof (not just
self-reported success) - see the sections above for how each was checked:

- **Chain deployment/execution** - real signed, broadcast, confirmed Sepolia
  transactions when `chainExecutor.ts` is configured; falls back to a
  deterministic mock with zero setup otherwise.
- **Custody** - real threshold-ECDSA MPC (`keyCustody.ts` / `mpcSigner.ts`,
  via BitGo's own `@bitgo/sdk-lib-mpc`) as the preferred option - the full
  private key never exists as a single value anywhere; Shamir's Secret
  Sharing and a single hot key remain as simpler fallbacks.
- **Persistence** - SQLite by default (`store/db.ts` / `store/sqliteMap.ts`);
  survives a real process restart, including which Sepolia addresses have
  already been deployed.
- **Sanctions + malicious-contract/mixer screening** - the real, free, public
  OFAC SDN crypto-address feed (bulk, refreshed every 6h) *and* GoPlus
  Security's free `address_security` API (live per-address lookup, aggregating
  real security-firm data - SlowMist, BlockSec) - `screeningService.ts`.
  Verified against a real-world case: the Ronin bridge exploiter's address
  correctly comes back flagged (`stealing_attack`/`sanctioned`) and a real
  transaction to it is hard-blocked; a clean address (Vitalik's) passes.
- **Economic value transfer** - `execute()` calls move a real (deliberately
  scaled-down) amount of wei derived from `valueUsd` and a real, live Chainlink
  price (see "Note on value" above), and newly deployed sub-wallets are really
  funded to be able to do so.
- **Price oracle** - Chainlink Price Feeds (`priceOracle.ts`), read live
  on-chain, not a fixed constant - see "Note on value" above.

Still mocked, and why:

- **HSM-backed key generation / hardware isolation** - the two MPC parties'
  shares (and the DSG ceremony itself) run as plain in-process objects, not on
  separate hardware or in separate trust domains. That's a deployment-topology
  gap, not a cryptographic one (see "Custody" above) - the algorithm's "full
  key never assembled" guarantee holds regardless of where each party runs.
- **Full-coverage threat intelligence** - GoPlus's free tier covers a lot
  (see above) but a paid vendor (Blockaid/Chainalysis - PRD Section 11 open
  question) would add deeper transaction-simulation-based drainer/scam
  detection GoPlus's address-reputation model doesn't attempt. GoPlus lookups
  also fail open on a vendor outage/timeout (3s) - documented in
  `screeningService.ts` as a real tradeoff, mitigated by the OFAC feed and
  curated demo sets still applying regardless.
- **Notifications** - Slack/mobile-push delivery are `console.log` lines
  (`apps/backend/src/notifications/channels.ts`).
- **RBAC depth** - one role per user (`packages/shared/src/types/permissions.ts`
  maps role → permission strings) rather than BitGo's full per-enterprise
  Role/Permission/Resource join-table system.

Swapping any of the still-mocked ones for the real thing touches only the
file(s) named above - no other service's governance logic needs to change, by
design (DAO layer + narrow ChainExecutor/KeySource/SendQueue interfaces).
