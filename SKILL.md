# Splitwise SDK

Import the shared client for scripts that process full responses without MCP output limits.

```typescript
import { createClient } from './splitwise-mcp/src/sdk.js';
const sw = await createClient();
```

Set one of `SPLITWISE_API_KEY`, `SPLITWISE_ACCESS_TOKEN`, `SPLITWISE_OAUTH_ACCESS_TOKEN`, or `SPLITWISE_BEARER_TOKEN`.

## Discovery and calls

`sw.operations` lists all 27 operations, including tool names, path and query parameters. Call `sw.call(toolName, args)` with path and query parameters at the top level and write fields inside `body`.

```typescript
const me = await sw.call('get_current_user');
const expense = await sw.call('get_expense_id', { id: 555 });
const created = await sw.call('create_expense', {
  body: { cost: '25.00', description: 'Dinner', group_id: 789, split_equally: true },
});
if (!created.ok) throw new Error(JSON.stringify(created.data));
```

Results have `ok`, `status`, `statusText`, `method`, `url`, `headers`, and `data`. `data` is `unknown`; narrow it before accessing fields. `ok` requires a successful HTTP status and no Splitwise `success: false` or nonempty `errors`. Validate `ok` even when HTTP status is 200.

The client validates the same schemas advertised by MCP. Request bodies accept objects and legacy JSON or URL-encoded strings. Unknown fields fail validation. Costs and shares are decimal strings with at most two decimal places.

## Expense shares and members

```typescript
await sw.call('create_expense', {
  body: {
    cost: '25.00', description: 'Dinner', group_id: 0,
    users: [
      { user_id: 123, paid_share: '25.00', owed_share: '12.50' },
      { user_id: 456, paid_share: '0', owed_share: '12.50' },
    ],
  },
});
```

Each share needs `paid_share`, `owed_share`, and either `user_id` or `email`, `first_name`, and `last_name`. `users` also works for `create_group` and `create_friends` with their member fields. The client converts arrays to Splitwise's flattened fields. Legacy `users__0__user_id` style fields remain accepted, but cannot be mixed with `users`.

`update_expense_id` accepts only fields that changed. Supplying any shares replaces all existing shares, so include every participant when updating them.

## Bulk expenses

```typescript
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

const output = createWriteStream('./expenses.jsonl');
for await (const expense of sw.expenses({ group_id: 789, limit: 100 })) {
  if (!output.write(JSON.stringify(expense) + '\n')) await once(output, 'drain');
}
output.end();
await once(output, 'finish');
```

`sw.expenses(filters, { maxPages: 1000 })` yields full records one page at a time. It preserves filters, advances the offset by records returned, and ends on an empty page, even if earlier pages were shorter than requested. It throws on errors and when the page limit is reached. Breaking the loop stops further requests. Offset pagination is not a snapshot; concurrent changes may affect results.

`sw.call('get_expenses', args)` returns one page plus `pagination` metadata. SDK expense calls default to 20 records and require a positive limit. The SDK has no local output cap. Notifications expose `updated_after` and `limit`, but no documented offset; do not assume you can retrieve complete notification history by increasing limits.

MCP limits expense and notification pages to 100 records and omits response data over 50 KB with `outputTruncated: true`. Use the SDK for complete exports and filter locally before returning a summary to an agent.
