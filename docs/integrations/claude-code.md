# Claude Code Integration

Connect Claude Code to the BitGo Agent Wallet MCP server so Claude can create
sub-wallets, check balances, submit transactions, and review audit logs
directly.

## Prerequisites

- BitGo Agent Wallet backend running (default `http://localhost:4000`)
- An API token with appropriate permissions (admin, compliance, or developer)
- Claude Code CLI installed

## Setup

### 1. Start the MCP server

```bash
BITGO_AGENT_WALLET_API_TOKEN=demo-dev-token \
  node apps/mcp-server/dist/index.js
```

The server runs on stdio and prints diagnostic messages to stderr. On success
it prints `BitGo Agent Wallet MCP server running on stdio` to stderr and
waits for MCP JSON-RPC messages on stdin.

### 2. Configure Claude Code

Add the server to your Claude Code MCP configuration:

**`~/.claude/servers.json`** (global) or **`.claude/servers.json`** (project-local):

```json
{
  "mcpServers": {
    "bitgo-agent-wallet": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp-server/dist/index.js"],
      "env": {
        "BITGO_AGENT_WALLET_API_TOKEN": "demo-dev-token",
        "BITGO_AGENT_WALLET_BASE_URL": "http://localhost:4000/api/v1"
      }
    }
  }
}
```

Replace `/absolute/path/to` with the absolute path to your clone of this repo.

### 3. Restart Claude Code

After saving the config, restart Claude Code. It will detect the new server and
make the tools available.

## Available tools

| Tool | Description | Section |
|---|---|---|
| `list_agent_wallets` | List agent sub-wallets on the authenticated master account | 6.1 |
| `create_agent_wallet` | Create a new agent sub-wallet | 6.1 |
| `get_balance` | Get spendable balance excluding quarantined funds | 6.7 / 6.9 |
| `send` | Submit a transaction through the full governance pipeline | 6.2-6.5 |
| `get_status` | Get transaction status | 6.7 |
| `revoke` | Emergency-stop an agent sub-wallet (kill switch) | 6.6 |
| `get_pact` | Get the Pact (policy) for a sub-wallet | 6.2 |
| `list_pending_approvals` | List transactions awaiting human approval | 6.5 |
| `query_audit_log` | Query the immutable audit log | 6.8 |
| `get_risk_summary` | Get risk-grading summary (trust score + recent assessments) | 5.2 / 12.4 |

## Example conversation

**User:** "Create an agent sub-wallet named 'Treasury Bot' with $10,000 allocated
balance in Bounded Auto mode."

Claude calls `create_agent_wallet` with the appropriate parameters and returns
the wallet details including its pending deployment status.

**User:** "Send $100 to 0xdest1 from the treasury bot."

Claude calls `send` with the sub-wallet id. The backend runs the full governance
pipeline: simulation, screening, risk assessment, policy evaluation, and
autonomy routing. Claude receives the resulting transaction record including
status, risk tier, and any policy violations.

**User:** "What's the current risk score for this wallet?"

Claude calls `get_risk_summary` and returns the trust score, recent risk
assessments, and historical compliance metrics.

## Troubleshooting

- **"BITGO_AGENT_WALLET_API_TOKEN is required"**: The `BITGO_AGENT_WALLET_API_TOKEN`
  env var was not set. Set it in the `env` block of the server config.
- **Tool returns errors with code `FORBIDDEN`**: The API token does not have the
  required permission for that operation. Use an admin or compliance token.
- **Backend not running**: Ensure `npm run dev:backend` is running in the repo.
  The MCP server proxies all tool calls to the backend REST API.
