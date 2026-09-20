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
- Pass `body` as an object. Write tools advertise documented fields and validate them before sending requests. Unknown fields are rejected.
- For groups, friends and expense shares, pass a `users` array. The client converts it to Splitwise's `users__{index}__{property}` fields. Existing flattened fields are also accepted. Do not mix both forms.
- SDK callers can still pass JSON or URL-encoded strings as `body`; they receive the same validation.

For example, `create_expense` accepts:

```json
{
  "body": {
    "cost": "25.00",
    "description": "Dinner",
    "group_id": 123,
    "split_equally": true
  }
}
```

For explicit shares, omit `split_equally` and supply `users`, with `paid_share`, `owed_share` and either `user_id` or `email`, `first_name`, and `last_name` for each person. Use `group_id: 0` for expenses outside a group. Updating expense shares replaces all existing shares.

`ok` means HTTP succeeded and Splitwise reported neither `success: false` nor nonempty `errors`. HTTP 200 alone does not imply that a write succeeded.

## Pagination and large responses

MCP expense and notification requests default to 20 records and accept limits of 1 through 100. Expense results include `pagination.offset`, `returned`, and `nextOffset`. Request `nextOffset` until an empty page returns `null`. A short page alone does not prove that all records were returned. Notifications have no documented offset, so this server does not claim to paginate their complete history.

MCP responses larger than 50 KB omit `data` and set `outputTruncated: true`. They include no records and no continuation offset. Retry reads with a smaller limit and the same offset where supported, or use the SDK to process the full response. Do not repeat writes because their response was omitted. Read back the result instead.

## Scripting

The SDK and MCP server share validation, authentication, request serialization, and error handling. SDK responses are not truncated.

```typescript
import { createClient } from './src/sdk.js';

const sw = await createClient();
for await (const expense of sw.expenses({ group_id: 123, limit: 100 })) {
  console.log(expense.id, expense.cost);
}
```

The iterator advances by the number of records actually returned, preserving filters, and stops only at an empty page. It throws on API failures or after 1,000 pages; change the latter with `sw.expenses(filters, { maxPages: 2000 })`. It fetches one page at a time and stops requesting pages when the loop exits. Offset pagination is not a snapshot; concurrent account changes can affect results.

Other operations remain available through `sw.call(toolName, args)`. See [SKILL.md](SKILL.md) for examples.

## Spec Sync

To refresh specs from Splitwise official docs repo:

```bash
bun run sync-spec
```

Review `src/body-schemas.ts` if request contracts changed, then restart the MCP server.

## Sources

- Splitwise API docs: https://dev.splitwise.com/
- Splitwise API OpenAPI source: https://github.com/splitwise/api-docs
