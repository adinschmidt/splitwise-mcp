Check out my [other MCP tools](https://github.com/adinschmidt/mcps)

# splitwise-mcp

MCP server that exposes every endpoint from Splitwise's public self-serve API docs as MCP tools.

Current coverage from `spec/paths/index.yaml`: **27 API operations**.

## Authentication

Splitwise uses Bearer authentication for API calls. This server accepts any of these env vars:

- `SPLITWISE_API_KEY` (recommended for personal use; easiest path)
- `SPLITWISE_ACCESS_TOKEN`
- `SPLITWISE_OAUTH_ACCESS_TOKEN`
- `SPLITWISE_BEARER_TOKEN`

If none are set, tool calls fail with an auth error.

### Which key/credential do you need?

- Personal scripts/single account: create a Splitwise app and use its **personal API key** as a Bearer token.
- Multi-user app: use **OAuth 2.0 Authorization Code** (client key + client secret) to get user access tokens, then pass the access token as Bearer.
- OAuth 1.0 is not used by the current docs.

## Run with Bunx

Bunx expects a package + executable. For path/GitHub sources, use `-p` and then the bin name (`splitwise-mcp`).

Published package (npm):

```bash
SPLITWISE_API_KEY=your_token bunx splitwise-mcp
```

Local path source:

```bash
SPLITWISE_API_KEY=your_token bunx -p /absolute/path/to/splitwise-mcp splitwise-mcp
```

GitHub source:

```bash
SPLITWISE_API_KEY=your_token bunx -p github:adinschmidt/splitwise-mcp splitwise-mcp
```

Note: `bunx /path/to/repo` is not supported by Bun 1.3.x. Use `-p` form above.

## MCP Client Config Example

Using published npm package:

```json
{
  "mcpServers": {
    "splitwise": {
      "command": "bunx",
      "args": ["splitwise-mcp"],
      "env": {
        "SPLITWISE_API_KEY": "your_splitwise_token"
      }
    }
  }
}
```

Using a local checkout:

```json
{
  "mcpServers": {
    "splitwise": {
      "command": "bunx",
      "args": ["-p", "/absolute/path/to/splitwise-mcp", "splitwise-mcp"],
      "env": {
        "SPLITWISE_API_KEY": "your_splitwise_token"
      }
    }
  }
}
```

## Tool Naming

Each API path is mapped to one tool name by path normalization.

Examples:

- `/get_current_user` -> `get_current_user`
- `/get_user/{id}` -> `get_user_id`
- `/delete_expense/{id}` -> `delete_expense_id`

There is also a helper tool:

- `splitwise_list_operations`: lists all registered Splitwise operations.

## Request Shape for Tools

Every tool accepts:

- Path/query parameters as top-level fields (for example `id`, `limit`, `offset`)
- `body` for JSON request bodies (when the endpoint supports/needs a body)
- For best results, pass `body` as an object. If you pass a string, use a JSON object string or URL-encoded form string.

## Spec Sync

To refresh specs from Splitwise official docs repo:

```bash
bun run sync-spec
```

Then restart the MCP server.

## Sources

- Splitwise API docs: https://dev.splitwise.com/
- Splitwise API OpenAPI source: https://github.com/splitwise/api-docs
