import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as z from 'zod/v4';
import { buildInputSchema, createClient } from '../src/sdk.js';
import { boundResult, buildServer } from '../src/index.js';

test('MCP schemas describe every operation and reject invalid expense inputs', async () => {
  const client = await createClient();
  assert.equal(client.operations.length, 27);
  const server = buildServer(client);
  for (const op of client.operations) {
    const json = z.toJSONSchema(buildInputSchema(op, true), { io: 'input' });
    assert.equal(json.type, 'object');
  }
  const op = client.operations.find(op => op.toolName === 'create_expense')!;
  const schema = buildInputSchema(op, true);
  assert.equal(schema.safeParse({ body: { cost: '12.345', description: 'Dinner', group_id: 1, split_equally: true } }).success, false);
  assert.equal(schema.safeParse({ body: { cost: '12.00', description: 'Dinner', group_id: 1 } }).success, false);
  assert.equal(schema.safeParse({ body: { cost: '12.00', description: 'Dinner', group_id: 1, split_equally: true } }).success, true);
  assert.equal(schema.safeParse({ body: { cost: '12.00', description: 'Dinner', group_id: 1, users: [{ user_id: 1, paid_share: '12', owed_share: '12' }] } }).success, true);
  assert.equal(schema.safeParse({ body: { cost: '12.00', description: 'Dinner', group_id: 1, users__0__user_id: 1, users__0__paid_share: '12', users__0__owed_share: '12' } }).success, true);
  const expenses = buildInputSchema(client.operations.find(op => op.toolName === 'get_expenses')!, true);
  assert.equal(expenses.parse({}).limit, 20);
  assert.equal(expenses.safeParse({ limit: 0 }).success, false);
  assert.equal(expenses.safeParse({ limit: 101 }).success, false);
  await server.close();
});

test('shared client validates writes, serializes users, detects API errors, and streams capped pages', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SPLITWISE_API_KEY;
  process.env.SPLITWISE_API_KEY = 'test-token';
  const requests: { url: string; body: unknown }[] = [];
  let response: unknown = { expenses: [], errors: {} };
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const offset = new URL(String(input)).searchParams.get('offset');
    const data = offset === null ? response : { expenses: Number(offset) < 2 ? [{ id: Number(offset) + 1 }] : [] };
    return Response.json(data);
  }) as typeof fetch;
  try {
    const client = await createClient();
    await assert.rejects(client.call('create_expense', { body: { cost: 'bad' } }));
    assert.equal(requests.length, 0);
    await client.call('create_expense', { body: { cost: '10.00', description: 'Dinner', group_id: 0, users: [{ user_id: 1, paid_share: '10', owed_share: '10' }] } });
    assert.deepEqual(requests[0].body, { cost: '10.00', description: 'Dinner', group_id: 0, users__0__user_id: 1, users__0__paid_share: '10', users__0__owed_share: '10' });
    await client.call('create_expense', { body: 'cost=10.00&description=Dinner&group_id=1&split_equally=true' });
    assert.deepEqual(requests.at(-1)?.body, { cost: '10.00', description: 'Dinner', group_id: 1, split_equally: true });
    await client.call('create_group', { body: 'name=Trip&simplify_by_default=false' });
    assert.deepEqual(requests.at(-1)?.body, { name: 'Trip', simplify_by_default: false });
    await assert.rejects(client.call('create_group', { body: { name: 'Trip', simplify_by_default: 'false' } }));
    response = { errors: { base: ['Unable to create'] } };
    assert.equal((await client.call('create_friend', { body: 'user_email=friend%40example.com' })).ok, false);
    response = { success: false };
    assert.equal((await client.call('remove_user_from_group', { body: { user_id: 1, group_id: 1 } })).ok, false);
    const records = [];
    for await (const expense of client.expenses({ group_id: 5, limit: 20 })) records.push(expense);
    assert.deepEqual(records, [{ id: 1 }, { id: 2 }]);
    const urls = requests.slice(-3).map(r => new URL(r.url));
    assert.deepEqual(urls.map(u => u.searchParams.get('offset')), ['0', '1', '2']);
    assert.ok(urls.every(u => u.searchParams.get('group_id') === '5'));
    await assert.rejects(async () => { for await (const _ of client.expenses({}, { maxPages: 1 })) { /* consume */ } }, /Stopped after 1/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.SPLITWISE_API_KEY;
    else process.env.SPLITWISE_API_KEY = originalToken;
  }
});

test('oversized MCP results are explicit and never suggest repeating a write or skipping unseen records', () => {
  const base = { ok: true, status: 200, statusText: 'OK', method: 'POST', url: 'https://example.com', headers: {}, data: { text: 'a'.repeat(60_000) } };
  const result = boundResult(base);
  assert.equal(result.ok, true);
  assert.equal(result.outputTruncated, true);
  assert.match(JSON.stringify(result.data), /Do not repeat this write/);
  const page = boundResult({ ...base, method: 'GET', pagination: { offset: 0, returned: 20, nextOffset: 20 } });
  assert.equal(page.pagination, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50_000);
});
