# Splitwise SDK

TypeScript SDK for the Splitwise API — all 27 endpoints.

**Import:**

```typescript
import { createClient } from './splitwise-mcp/src/sdk.js';
const sw = await createClient();
```

**Required env var:** one of `SPLITWISE_API_KEY`, `SPLITWISE_ACCESS_TOKEN`, `SPLITWISE_OAUTH_ACCESS_TOKEN`, or `SPLITWISE_BEARER_TOKEN`.

---

## Discovery

The client loads all operations from the API spec at init. Inspect them to find what you need:

```typescript
const sw = await createClient();

// List all operations
for (const op of sw.operations) {
  console.log(`${op.toolName} — ${op.method.toUpperCase()} ${op.apiPath} — ${op.summary}`);
}

// Inspect a specific operation's parameters
const op = sw.operations.find(o => o.toolName === 'get_expenses');
console.log('Path params:', op.pathParameters);
console.log('Query params:', op.queryParameters);
console.log('Has body:', op.hasBody);
```

---

## Calling Operations

Use `sw.call(toolName, args)`. Pass path and query parameters as top-level keys. Pass request bodies under the `body` key.

Every call returns:

```typescript
{
  ok: boolean;       // true if HTTP 2xx
  status: number;    // HTTP status code
  statusText: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  data: unknown;     // Parsed JSON response body
}
```

---

## Operations Reference

### Users

```typescript
// Get the current authenticated user
const me = await sw.call('get_current_user');
console.log(me.data);

// Get a specific user
const user = await sw.call('get_user_id', { id: 12345 });

// Update a user
await sw.call('update_user_id', { id: 12345, body: { first_name: 'Alice' } });
```

### Groups

```typescript
// List all groups
const groups = await sw.call('get_groups');

// Get a specific group
const group = await sw.call('get_group_id', { id: 789 });

// Create a group
await sw.call('create_group', {
  body: { name: 'Apartment', group_type: 'apartment' },
});

// Add/remove users
await sw.call('add_user_to_group', {
  body: { group_id: 789, user_id: 12345 },
});
await sw.call('remove_user_from_group', {
  body: { group_id: 789, user_id: 12345 },
});

// Delete / undelete
await sw.call('delete_group_id', { id: 789 });
await sw.call('undelete_group_id', { id: 789 });
```

### Friends

```typescript
const friends = await sw.call('get_friends');
const friend = await sw.call('get_friend_id', { id: 456 });

await sw.call('create_friend', {
  body: { user_email: 'bob@example.com' },
});
await sw.call('delete_friend_id', { id: 456 });
```

### Expenses

```typescript
// List expenses (supports query filters)
const expenses = await sw.call('get_expenses', {
  limit: 20,
  group_id: 789,
  // Other query params: friend_id, dated_after, dated_before, updated_after, updated_before, offset
});

// Get a specific expense
const expense = await sw.call('get_expense_id', { id: 555 });

// Create an expense
await sw.call('create_expense', {
  body: {
    cost: '25.00',
    description: 'Dinner',
    group_id: 789,
    split_equally: true,
  },
});

// Update an expense
await sw.call('update_expense_id', {
  id: 555,
  body: { description: 'Lunch instead' },
});

// Delete / undelete
await sw.call('delete_expense_id', { id: 555 });
await sw.call('undelete_expense_id', { id: 555 });
```

### Comments

```typescript
// List comments on an expense
const comments = await sw.call('get_comments', { expense_id: 555 });

// Add a comment
await sw.call('create_comment', {
  body: { expense_id: 555, content: 'Looks right to me' },
});

// Delete a comment
await sw.call('delete_comment_id', { id: 999 });
```

### Other

```typescript
const currencies = await sw.call('get_currencies');
const categories = await sw.call('get_categories');
const notifications = await sw.call('get_notifications');
```

---

## Common Patterns

**Filtering and aggregating in code:**

```typescript
const sw = await createClient();
const { data } = await sw.call('get_expenses', { limit: 200 });

const byPerson = new Map<string, number>();
for (const expense of data.expenses) {
  for (const user of expense.users) {
    const name = `${user.user.first_name} ${user.user.last_name}`;
    const owed = parseFloat(user.owed_share);
    byPerson.set(name, (byPerson.get(name) ?? 0) + owed);
  }
}

for (const [name, total] of byPerson) {
  console.log(`${name}: $${total.toFixed(2)}`);
}
```

**Composing multiple calls without round-tripping:**

```typescript
const sw = await createClient();

const { data: groupData } = await sw.call('get_groups');
for (const group of groupData.groups) {
  const { data: expenseData } = await sw.call('get_expenses', {
    group_id: group.id,
    limit: 5,
  });
  const total = expenseData.expenses.reduce(
    (sum: number, e: any) => sum + parseFloat(e.cost),
    0,
  );
  console.log(`${group.name}: ${expenseData.expenses.length} recent expenses, $${total.toFixed(2)} total`);
}
```

**Persisting intermediate data:**

```typescript
import { writeFile } from 'node:fs/promises';

const sw = await createClient();
const { data } = await sw.call('get_expenses', { limit: 500 });

const csv = ['date,description,cost,currency']
  .concat(
    data.expenses.map(
      (e: any) => `${e.date},${e.description},${e.cost},${e.currency_code}`,
    ),
  )
  .join('\n');

await writeFile('./expenses.csv', csv);
console.log(`Exported ${data.expenses.length} expenses`);
```

**Error handling:**

```typescript
const result = await sw.call('get_expense_id', { id: 999999 });
if (!result.ok) {
  console.error(`Failed (${result.status}): ${JSON.stringify(result.data)}`);
} else {
  console.log(result.data);
}
```
