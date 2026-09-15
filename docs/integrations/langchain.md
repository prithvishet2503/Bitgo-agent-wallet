# LangChain Integration

Give LangChain-based agents the ability to create sub-wallets, check balances,
submit transactions, and query audit logs via the BitGo Agent Wallet MCP server.

## Prerequisites

- BitGo Agent Wallet backend running (default `http://localhost:4000`)
- An API token with appropriate permissions
- Node.js 20+ and npm
- A LangChain project with `@langchain/core` installed

## Setup

### 1. Start the MCP server

```bash
BITGO_AGENT_WALLET_API_TOKEN=demo-dev-token \
  node apps/mcp-server/dist/index.js
```

### 2. Install the LangChain MCP adapter

```bash
npm install @langchain/mcp-adapter
```

### 3. Connect from your LangChain agent

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChatMCPAdapter } from "@langchain/mcp-adapter";
import { ChatOpenAI } from "@langchain/openai";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { pull } from "langchain/hub";

// Create MCP transport pointing at the BitGo Agent Wallet server.
const transport = new StdioClientTransport({
  command: "node",
  args: ["/absolute/path/to/apps/mcp-server/dist/index.js"],
  env: {
    BITGO_AGENT_WALLET_API_TOKEN: "demo-dev-token",
    BITGO_AGENT_WALLET_BASE_URL: "http://localhost:4000/api/v1",
  },
});

const client = new Client(
  { name: "bitgo-agent-wallet-client", version: "0.1.0" },
  { capabilities: {} },
);

await client.connect(transport);

// Wrap MCP tools as LangChain tools.
const mcpAdapter = new ChatMCPAdapter({ client });
const tools = await mcpAdapter.getTools();

// Create an agent with the BitGo wallet tools.
const prompt = await pull<ChatPromptTemplate>("hwchase17/openai-tools-agent");
const llm = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });

const agent = await createToolCallingAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools });

// Now the agent can perform wallet operations conversationally.
const result = await executor.invoke({
  input: "Create an agent sub-wallet named 'Trading Bot' with $5,000 allocated in Bounded Auto mode, then check its balance.",
});

console.log(result.output);
```

## Available tools

All MCP tools from the BitGo Agent Wallet server are automatically available
as LangChain tools. See the [MCP server reference](./claude-code.md#available-tools)
for the full list.

## Example: Send a transaction

```typescript
const result = await executor.invoke({
  input: "Send $200 to 0xdest1 from my Trading Bot sub-wallet. What's the risk assessment?",
});
```

The agent will call `send` (which runs the full governance pipeline: simulation,
screening, risk assessment, policy evaluation, autonomy routing) and return the
transaction record including the risk tier and any policy violations.

## Example: Query risk summary

```typescript
const result = await executor.invoke({
  input: "Show me the risk summary and trust score for my Trading Bot sub-wallet.",
});
```

The agent calls `get_risk_summary` and returns the trust score (0-100), recent
risk assessments, and compliance metrics.

## Troubleshooting

- **`Cannot find module '@langchain/mcp-adapter'`**: Install it with
  `npm install @langchain/mcp-adapter`. The adapter package name may vary by
  LangChain version; check the [LangChain MCP documentation](https://js.langchain.com/docs/integrations/tools/mcp/).
- **MCP connection refused**: Ensure the backend is running and the
  `BITGO_AGENT_WALLET_BASE_URL` env var points to a running instance.
- **Tool call permissions**: The API token's role determines which operations
  are allowed. Admin tokens can do everything; developer tokens can create
  wallets and send transactions but cannot modify policies or release
  quarantined funds.
