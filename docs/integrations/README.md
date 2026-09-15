# Framework Integration Guides

BitGo Agent Wallet exposes a standard MCP (Model Context Protocol) server and a
fully-typed TypeScript SDK, making it integrable with any agent framework that
supports MCP tool calling. These guides walk through the setup for specific
frameworks.

## Quick comparison

| Framework | Integration type | Setup time | Best for |
|---|---|---|---|
| [Claude Code](./claude-code.md) | MCP stdio server | 5 minutes | Direct Claude Code agent access to wallet operations |
| [LangChain](./langchain.md) | ChatMCP adapter | 10 minutes | LangChain-based agents with tool-calling support |

## Common prerequisites

Before following any guide, ensure you have:

1. A running BitGo Agent Wallet backend (`npm run dev:backend` from the repo root,
   or a deployed instance).
2. An API token for the agent identity (use the demo tokens or create an
   Organization via the login screen).
3. An agent sub-wallet created and deployed (via the console or CLI).

## All guides

- [Claude Code](./claude-code.md) - Connect Claude Code to the BitGo Agent Wallet
  MCP server for direct agent-controlled wallet operations.
- [LangChain](./langchain.md) - Use the LangChain ChatMCP adapter to give
  LangChain-based agents BitGo wallet capabilities.

## Architecture

```
Agent framework (Claude Code, LangChain, etc.)
        |
        | MCP stdio transport
        v
BitGo Agent Wallet MCP server (apps/mcp-server)
        |
        | REST API
        v
BitGo Agent Wallet backend (apps/backend)
        |
        | Governance pipeline:
        | simulate -> screen -> risk assess -> policy -> route
        v
Chain executor (mock or real Sepolia)
```

The MCP server is a thin translation layer: every tool call maps to one SDK
method, which maps to one REST endpoint. All governance logic (simulation,
screening, risk assessment, policy evaluation, autonomy routing) runs in the
backend, not in the MCP server or the agent framework.
