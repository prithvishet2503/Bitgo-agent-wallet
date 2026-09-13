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
  contracts. Activates automatically when `CHAIN_RPC_URL`,
  `CHAIN_SIGNER_PRIVATE_KEY`, and `AGENT_SUB_WALLET_FACTORY_ADDRESS` are all set
  (see `apps/backend/.env.example`). Verified working end-to-end: creating an
  agent sub-wallet really deploys an `AgentSubWallet` via the factory on
  Sepolia, and submitting a transaction to a real address really calls its
  `execute()` on-chain - both signed and broadcast by the backend itself (see
  below).

Submitting a transaction to a non-address (e.g. a demo placeholder like
`0xdest1`) in real mode fails the broadcast cleanly - the transaction stays
`approved` (queued, retryable) and the SendQueue entry is marked failed with a
clear error, rather than crashing. Use a real hex address (your own deployer
address works as a harmless self-call) to see a transaction reach `executed`
in real mode.

**Note on value**: `execute()` calls in real mode always send zero ETH with
empty calldata - a real, gas-paying, on-chain transaction that proves the
sign-and-broadcast path end to end, but `valueUsd` stays a backend-tracked
ledger figure rather than an amount actually transferred on-chain. Wiring real
economic transfers (funding each deployed `AgentSubWallet` and encoding a real
value/calldata per transaction) is a bigger, riskier follow-up, deliberately
out of scope here.

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

### Data-access layer (DAO pattern)

Services never touch storage directly - they call a `dal/models/*.dao.ts`
singleton (`subWalletDao`, `pactDao`, `enterpriseDao`, ...) implementing a shared
`BaseDao` interface (`apps/backend/src/dal/base.dao.ts`), mirroring
wallet-platform's `app/dal/interfaces/base.dao.ts` + `app/dal/models/*.dao.ts`.
Swapping the in-memory store (`apps/backend/src/store/db.ts`) for a real database
means rewriting that one file and the DAOs' two-line bodies - no service logic
changes.

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

By default the backend runs in mock chain mode (no setup needed). To make it
actually deploy/execute on Sepolia:

```bash
cd apps/backend
cp .env.example .env
# fill in CHAIN_SIGNER_PRIVATE_KEY with a funded Sepolia key
# (AGENT_SUB_WALLET_FACTORY_ADDRESS already points at the deployed factory)
npm run dev   # or: node dist/index.js after npm run build
```

The startup log says which mode it's in: `[chainExecutor] REAL mode - ...` or
`[chainExecutor] MOCK mode - ...`.

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
6. Try sending to `0xsanctioned0001` → hard-blocked by screening regardless of
   autonomy mode.
7. Record an incoming transaction from `0xsanctioned0001` on the sub-wallet
   detail page → it's quarantined; release it from **Incoming Quarantine**.
8. Check **Audit Log** - every step above is there, immutably, including the
   `SUB_WALLET_DEPLOYMENT_QUEUED` / `SUB_WALLET_DEPLOYED` and
   `TRANSACTION_QUEUED_FOR_BROADCAST` / `TRANSACTION_EXECUTED` pairs.
9. From the sidebar, click **+ New enterprise** to create a second Enterprise
   under the same Organization and switch to it.

## What's intentionally mocked (and what isn't, anymore)

- **Chain deployment/execution**: real when `chainExecutor.ts` is configured
  (see above) - actual signed, broadcast, confirmed Sepolia transactions.
  Falls back to a deterministic mock with zero setup otherwise.
- **Custody**: still no real MPC/HSM - the backend's chain-signing key is a
  single hot private key in `.env` (fine for a testnet demo; production would
  put this behind an MPC/HSM signer instead, still called from
  `chainExecutor.ts` and nowhere else). Sub-wallet `sessionKeyRef` fields
  remain opaque string references, not real key material.
- **Screening**: `screeningService.ts` uses a small in-memory watchlist instead of
  a licensed vendor (Blockaid/Chainalysis - PRD Section 11 open question).
- **Notifications**: Slack/mobile-push delivery are `console.log` lines
  (`apps/backend/src/notifications/channels.ts`).
- **Persistence**: everything lives in an in-memory store
  (`apps/backend/src/store/db.ts`) that resets on restart - including the
  record of what's been deployed on-chain, so restarting the backend forgets
  which Sepolia addresses it already owns (the contracts themselves are
  unaffected; only the backend's index of them resets).
- **Economic value**: `execute()` calls never move real funds (see above) -
  `valueUsd` is a ledger figure, not a wei amount.
- **RBAC**: one role per user (`packages/shared/src/types/permissions.ts` maps
  role → permission strings) rather than BitGo's full per-enterprise
  Role/Permission/Resource join-table system.

Swapping any of these for the real thing touches only the file(s) listed above -
no other service's governance logic needs to change, by design (DAO layer +
narrow ChainExecutor/SendQueue interfaces).
