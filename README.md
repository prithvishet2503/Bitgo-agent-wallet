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
enforced business logic — not a stub.

## Architecture

```
packages/shared      Domain types + zod schemas shared by every app (Section 6 data model)
packages/sdk         TypeScript SDK - thin, fully-typed client over the REST API
packages/sdk-python  Python SDK - mirrors the TS client (Section 6.7: "at minimum TypeScript/Python")
apps/backend         Express API + all governance business logic (in-memory store)
apps/frontend        React admin console (Vite) - the institutional/compliance UI
apps/cli             CLI (Section 6.7: authenticate, create-agent-wallet, send, get-balance, get-status, revoke, ...)
apps/mcp-server      MCP server (Section 6.7) - lets agent frameworks call the wallet directly
```

The SDK, CLI, MCP server, and frontend are all thin clients of the same backend
REST API, so there is exactly one implementation of the governance logic
(`apps/backend/src/services/*`).

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
| 6.10 Gas Sponsorship (EIP-7702) | `apps/backend/src/services/gasSponsorshipService.ts` |

Every service file has a doc comment citing the exact PRD section it implements.

## Running it

```bash
npm install
npm run build          # builds packages/shared -> packages/sdk -> everything else, in order
```

Start the backend (seeds demo master account + 4 role-scoped users):

```bash
npm run dev:backend    # http://localhost:4000
```

Start the console:

```bash
npm run dev:frontend   # http://localhost:5173, proxies /api to :4000
```

Log in with one of the seeded demo tokens (shown on the login screen):
`demo-admin-token`, `demo-compliance-token`, `demo-dev-token`, `demo-viewer-token`.

### CLI

```bash
cd apps/cli
node dist/index.js authenticate demo-admin-token
node dist/index.js create-agent-wallet --name "Treasury Bot" --allocated-balance 50000 --autonomy-mode bounded_auto
node dist/index.js create-pact --sub-wallet-id <id> --max-tx-value 5000 --daily-cap 20000 --weekly-cap 50000
node dist/index.js send --sub-wallet-id <id> --to 0xdest1 --value-usd 1000
node dist/index.js get-status --transaction-id <id>
node dist/index.js revoke --sub-wallet-id <id> --reason "compromised key"
```

### MCP server

```bash
BITGO_AGENT_WALLET_API_TOKEN=demo-dev-token node apps/mcp-server/dist/index.js
```

Point an MCP-compatible agent framework (Claude Code, LangChain, etc. - the
flagship integration called out in PRD Section 8) at this stdio server to let it
create sub-wallets, submit transactions, and check status/balance directly.

## Demo flow worth trying

1. Log in as **Ava Admin** (admin).
2. Create an agent sub-wallet in **Bounded Auto** mode.
3. Create a Pact with a low max-transaction-value cap.
4. Submit a transaction under the cap → auto-executes immediately.
5. Submit a transaction over the cap → escalates to **Approvals** with the
   specific policy violation shown; approve or deny it there.
6. Try sending to `0xsanctioned0001` → hard-blocked by screening regardless of
   autonomy mode.
7. Record an incoming transaction from `0xsanctioned0001` on the sub-wallet
   detail page → it's quarantined; release it from **Incoming Quarantine**.
8. Check **Audit Log** - every step above is there, immutably.

## What's intentionally mocked

- **Custody**: no real MPC/HSM; sub-wallet keys are opaque string references.
- **Chain**: no real RPC; simulation and EIP-7702 delegation are deterministic mocks.
- **Screening**: `screeningService.ts` uses a small in-memory watchlist instead of
  a licensed vendor (Blockaid/Chainalysis - PRD Section 11 open question).
- **Notifications**: Slack/mobile-push delivery are `console.log` lines
  (`apps/backend/src/notifications/channels.ts`).
- **Persistence**: everything lives in an in-memory store
  (`apps/backend/src/store/db.ts`) that resets on restart.

Swapping any of these for the real thing only touches the one file listed above -
no service's governance logic needs to change.
