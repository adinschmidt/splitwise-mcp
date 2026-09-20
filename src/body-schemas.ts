import * as z from 'zod/v4';

// Contracts follow spec/paths and spec/schemas/expense. `users` is a convenience
// representation of Splitwise's documented users__{index}__{property} fields.
const id = z.number().int();
const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Use a decimal string with at most two decimal places.').describe('Decimal amount as a string, with at most two decimal places.');
const personFields = {
  user_id: id.optional(),
  email: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
};
const person = z.strictObject(personFields).refine(p => p.user_id !== undefined || Boolean(p.email), 'Supply user_id or email.');
const friend = z.strictObject({ email: z.string(), first_name: z.string().optional(), last_name: z.string().optional() });
const share = z.strictObject({ ...personFields, paid_share: money, owed_share: money }).refine(
  p => p.user_id !== undefined || Boolean(p.email && p.first_name && p.last_name),
  'Each share needs user_id or email, first_name, and last_name.',
);
const expenseFields = {
  cost: money.optional(),
  description: z.string().optional(),
  details: z.string().nullable().optional(),
  date: z.iso.datetime({ offset: true }).optional(),
  repeat_interval: z.enum(['never', 'weekly', 'fortnightly', 'monthly', 'yearly']).optional(),
  currency_code: z.string().optional(),
  category_id: id.optional(),
  group_id: id.describe("Group ID, or 0 for an expense outside a group when supplying shares.").optional(),
  split_equally: z.boolean().describe('True splits equally within group_id, with the authenticated user paying. Otherwise supply all user shares.').optional(),
};

function withUsers<S extends z.ZodRawShape>(shape: S, user: z.ZodType, required: boolean, expense = false) {
  return z.object({ ...shape, users: z.array(user).min(1).describe(expense
      ? 'Shares, converted to users__{index}__{property}. Each share needs paid_share, owed_share and user_id or email, first_name, last_name. Updating users replaces ALL existing shares. Do not combine with flattened fields.'
      : 'Members, converted to users__{index}__{property}. Do not combine with flattened fields.').optional() })
    .catchall(z.union([z.string(), z.number()]))
    .superRefine((body, ctx) => {
      const rows: Record<string, Record<string, unknown>> = {};
      for (const [key, value] of Object.entries(body)) {
        if (key in shape || key === 'users') continue;
        const match = /^users__(\d+)__(\w+)$/.exec(key);
        if (!match) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'Unknown request field.' });
          continue;
        }
        const row = rows[match[1]] ??= {};
        row[match[2]] = match[2] === 'user_id' && typeof value === 'string' ? Number(value) : value;
      }
      if (body.users && Object.keys(rows).length) {
        ctx.addIssue({ code: 'custom', message: 'Use either users or flattened user fields, not both.' });
      }
      for (const [index, row] of Object.entries(rows)) {
        const parsed = user.safeParse(row);
        if (!parsed.success) ctx.addIssue({ code: 'custom', message: `Invalid users__${index} share or member: ${parsed.error.message}` });
      }
      if (required && !body.users && !Object.keys(rows).length && Reflect.get(body, 'split_equally') !== true) {
        ctx.addIssue({ code: 'custom', message: expense ? 'Supply users, flattened user fields, or split_equally: true.' : 'Supply users or flattened user fields.' });
      }
    });
}

const createExpense = withUsers({ ...expenseFields, cost: money, description: z.string(), group_id: id.describe("Group ID; use 0 for an expense outside a group with explicit shares.") }, share, true, true)
  .superRefine((body, ctx) => {
    if (Reflect.get(body, 'split_equally') === true && (body.users || Object.keys(body).some(key => key.startsWith('users__')))) {
      ctx.addIssue({ code: 'custom', message: 'Choose an equal split or explicit shares.' });
    }
  });

export const bodySchemas: Record<string, z.ZodType> = {
  create_expense: createExpense,
  update_expense_id: withUsers(expenseFields, share, false, true),
  create_group: withUsers({
    name: z.string(),
    group_type: z.enum(['home', 'trip', 'couple', 'other', 'apartment', 'house']).optional(),
    simplify_by_default: z.boolean().optional(),
  }, person, false),
  create_friends: withUsers({}, friend, true),
  // The upstream required list says `email`, but its property and API use user_email.
  create_friend: z.strictObject({ user_email: z.string(), user_first_name: z.string().optional(), user_last_name: z.string().optional() }),
  add_user_to_group: z.union([
    z.strictObject({ group_id: id, user_id: id }),
    z.strictObject({ group_id: id, first_name: z.string(), last_name: z.string(), email: z.string() }),
  ]),
  remove_user_from_group: z.strictObject({ group_id: id, user_id: id }),
  create_comment: z.strictObject({ expense_id: id, content: z.string() }),
  update_user_id: z.strictObject({
    first_name: z.string().optional(), last_name: z.string().optional(), email: z.string().optional(),
    password: z.string().optional(), locale: z.string().optional(), default_currency: z.string().optional(),
  }),
};

export function flattenUsers(body: Record<string, unknown>): Record<string, unknown> {
  const { users, ...output } = body;
  if (Array.isArray(users)) {
    for (const [index, user] of users.entries()) {
      for (const [key, value] of Object.entries(user)) output[`users__${index}__${key}`] = value;
    }
  }
  return output;
}
