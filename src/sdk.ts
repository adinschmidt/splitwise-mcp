/**
 * Splitwise SDK — importable TypeScript API for all Splitwise endpoints.
 *
 * Usage:
 *   import { createClient } from './splitwise-mcp/src/sdk.js';
 *   const sw = await createClient();
 *
 *   // Discover available operations
 *   const ops = sw.operations;
 *   console.log(ops.map(o => `${o.method.toUpperCase()} ${o.apiPath} — ${o.summary}`));
 *
 *   // Call any operation by tool name
 *   const me = await sw.call('get_current_user');
 *   const expenses = await sw.call('get_expenses', { limit: 10, group_id: 123 });
 *   const created = await sw.call('create_expense', {
 *     body: { cost: '25.00', description: 'Dinner', group_id: 123 },
 *   });
 *
 * Requires env var: SPLITWISE_API_KEY (or SPLITWISE_ACCESS_TOKEN, etc.)
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Types (from index.ts)
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
type JsonRecord = Record<string, unknown>;

interface RawPathRef { $ref?: string }
interface RawSchema { type?: string; format?: string }
interface RawParameter {
  in?: string;
  name?: string;
  required?: boolean;
  description?: string;
  schema?: RawSchema;
}
interface RawRequestBody { required?: boolean; description?: string }
interface RawOperation {
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: RawRequestBody;
}

export interface ParameterSpec {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schemaType?: string;
  schemaFormat?: string;
}

export interface OperationSpec {
  toolName: string;
  method: HttpMethod;
  apiPath: string;
  summary: string;
  description?: string;
  pathParameters: ParameterSpec[];
  queryParameters: ParameterSpec[];
  hasBody: boolean;
  bodyRequired: boolean;
  bodyDescription?: string;
}

export interface ApiCallResult {
  ok: boolean;
  status: number;
  statusText: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Env / auth
// ---------------------------------------------------------------------------

const TOKEN_ENV_KEYS = [
  'SPLITWISE_API_KEY',
  'SPLITWISE_ACCESS_TOKEN',
  'SPLITWISE_OAUTH_ACCESS_TOKEN',
  'SPLITWISE_BEARER_TOKEN',
] as const;

const SPLITWISE_BASE_URL =
  process.env.SPLITWISE_BASE_URL ?? 'https://secure.splitwise.com/api/v3.0';

function getAccessToken(): string {
  for (const envKey of TOKEN_ENV_KEYS) {
    const value = process.env[envKey];
    if (value && value.trim().length > 0) return value.trim();
  }
  throw new Error(`Missing Splitwise token. Set one of: ${TOKEN_ENV_KEYS.join(', ')}.`);
}

// ---------------------------------------------------------------------------
// Internal helpers (from index.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRepoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function sanitizeToolName(path: string): string {
  return path
    .replace(/^\//, '')
    .replace(/\//g, '_')
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function dedupeToolName(baseName: string, method: HttpMethod, existingNames: Set<string>): string {
  const normalizedBase = baseName.length > 0 ? baseName : `${method}_root`;
  if (!existingNames.has(normalizedBase)) return normalizedBase;
  let candidate = `${method}_${normalizedBase}`;
  let counter = 2;
  while (existingNames.has(candidate)) {
    candidate = `${method}_${normalizedBase}_${counter}`;
    counter += 1;
  }
  return candidate;
}

function normalizeParameters(parameters: unknown[] | undefined): ParameterSpec[] {
  if (!Array.isArray(parameters)) return [];
  const output: ParameterSpec[] = [];
  for (const raw of parameters) {
    if (!isRecord(raw)) continue;
    const p = raw as RawParameter;
    if (p.in !== 'path' && p.in !== 'query') continue;
    if (typeof p.name !== 'string' || p.name.length === 0) continue;
    output.push({
      name: p.name,
      in: p.in,
      required: p.in === 'path' ? true : p.required === true,
      description: typeof p.description === 'string' ? p.description : undefined,
      schemaType: typeof p.schema?.type === 'string' ? p.schema.type : undefined,
      schemaFormat: typeof p.schema?.format === 'string' ? p.schema.format : undefined,
    });
  }
  return output;
}

function buildResolvedPath(operation: OperationSpec, args: JsonRecord): string {
  let resolvedPath = operation.apiPath;
  for (const param of operation.pathParameters) {
    const value = args[param.name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing required path parameter: ${param.name}`);
    }
    resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
  }
  return resolvedPath;
}

function appendQueryParam(searchParams: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) searchParams.append(key, String(entry));
    return;
  }
  if (isRecord(value)) {
    searchParams.append(key, JSON.stringify(value));
    return;
  }
  searchParams.append(key, String(value));
}

function normalizeBodyInput(rawBody: unknown): JsonRecord {
  if (typeof rawBody === 'string') {
    const trimmed = rawBody.trim();
    if (trimmed.length === 0) throw new Error('The `body` field cannot be an empty string.');
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      if (!trimmed.includes('=')) throw new Error('String body must be JSON or URL-encoded key/value pairs.');
      const params = new URLSearchParams(trimmed);
      const parsed: JsonRecord = {};
      for (const [k, v] of params.entries()) {
        const existing = parsed[k];
        if (existing === undefined) parsed[k] = v;
        else if (Array.isArray(existing)) existing.push(v);
        else parsed[k] = [existing, v];
      }
      return parsed;
    }
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) throw new Error('The `body` field must decode to a JSON object.');
    return parsed;
  }
  if (!isRecord(rawBody)) throw new Error('The `body` field must be an object.');
  return rawBody;
}

function parseResponseBody(contentType: string | null, rawText: string): unknown {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const advertisedJson = contentType?.includes('application/json') ?? false;
  if (advertisedJson || looksLikeJson) {
    try { return JSON.parse(trimmed); } catch { return rawText; }
  }
  return rawText;
}

// ---------------------------------------------------------------------------
// Core call logic
// ---------------------------------------------------------------------------

async function callSplitwise(operation: OperationSpec, args: JsonRecord): Promise<ApiCallResult> {
  const accessToken = getAccessToken();
  const resolvedPath = buildResolvedPath(operation, args);
  const url = new URL(`${SPLITWISE_BASE_URL}${resolvedPath}`);

  for (const param of operation.queryParameters) {
    const value = args[param.name];
    if (value === undefined || value === null) continue;
    appendQueryParam(url.searchParams, param.name, value);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method: operation.method.toUpperCase(), headers };

  if (operation.hasBody) {
    const body = args.body;
    if (operation.bodyRequired && body === undefined) {
      throw new Error('Missing required request body. Provide `body` field.');
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(normalizeBodyInput(body));
    }
  }

  const response = await fetch(url, init);
  const responseText = await response.text();
  const parsedBody = parseResponseBody(response.headers.get('content-type'), responseText);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    method: init.method ?? operation.method.toUpperCase(),
    url: url.toString(),
    headers: Object.fromEntries(response.headers.entries()),
    data: parsedBody,
  };
}

// ---------------------------------------------------------------------------
// Operation loading
// ---------------------------------------------------------------------------

async function loadOperations(): Promise<OperationSpec[]> {
  const repoRoot = getRepoRoot();
  const indexPath = join(repoRoot, 'spec', 'paths', 'index.yaml');
  const indexDoc = YAML.parse(await readFile(indexPath, 'utf8'));

  if (!isRecord(indexDoc)) throw new Error('spec/paths/index.yaml is not a valid YAML object.');

  const operations: OperationSpec[] = [];
  const usedToolNames = new Set<string>();

  for (const [apiPath, rawRef] of Object.entries(indexDoc)) {
    if (!isRecord(rawRef)) continue;
    const ref = (rawRef as RawPathRef).$ref;
    if (typeof ref !== 'string') continue;

    const pathSpecName = ref.replace(/^\.\//, '');
    const pathSpecPath = join(repoRoot, 'spec', 'paths', pathSpecName);
    const pathDoc = YAML.parse(await readFile(pathSpecPath, 'utf8'));
    if (!isRecord(pathDoc)) continue;

    const sharedParameters = normalizeParameters(
      Array.isArray(pathDoc.parameters) ? pathDoc.parameters : undefined,
    );

    for (const method of HTTP_METHODS) {
      const rawOp = pathDoc[method];
      if (!isRecord(rawOp)) continue;
      const op = rawOp as RawOperation;
      const opParams = normalizeParameters(op.parameters);
      const merged = [...sharedParameters, ...opParams];

      const toolName = dedupeToolName(sanitizeToolName(apiPath), method, usedToolNames);
      usedToolNames.add(toolName);

      operations.push({
        toolName,
        method,
        apiPath,
        summary: typeof op.summary === 'string' ? op.summary : `${method.toUpperCase()} ${apiPath}`,
        description: typeof op.description === 'string' ? op.description : undefined,
        pathParameters: merged.filter((p) => p.in === 'path'),
        queryParameters: merged.filter((p) => p.in === 'query'),
        hasBody: Boolean(op.requestBody),
        bodyRequired: op.requestBody?.required === true,
        bodyDescription: typeof op.requestBody?.description === 'string' ? op.requestBody.description : undefined,
      });
    }
  }

  operations.sort((a, b) => a.toolName.localeCompare(b.toolName));
  return operations;
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export interface SplitwiseClient {
  /** All available API operations (for discovery). */
  operations: OperationSpec[];

  /**
   * Call any Splitwise API operation by its tool name.
   *
   * @param toolName - e.g. 'get_expenses', 'create_expense', 'get_current_user'
   * @param args - path/query params as top-level keys, request body as `body` key
   *
   * @example
   *   const result = await sw.call('get_expenses', { limit: 5 });
   *   console.log(result.data);
   */
  call(toolName: string, args?: Record<string, unknown>): Promise<ApiCallResult>;
}

/**
 * Create a Splitwise SDK client. Loads all operation specs from YAML on init.
 *
 * @example
 *   const sw = await createClient();
 *   const me = await sw.call('get_current_user');
 *   console.log(me.data);
 */
export async function createClient(): Promise<SplitwiseClient> {
  const operations = await loadOperations();
  const opsByName = new Map(operations.map((op) => [op.toolName, op]));

  return {
    operations,
    call: async (toolName: string, args: Record<string, unknown> = {}) => {
      const op = opsByName.get(toolName);
      if (!op) {
        const available = operations.map((o) => o.toolName).join(', ');
        throw new Error(`Unknown operation: "${toolName}". Available: ${available}`);
      }
      return callSplitwise(op, args);
    },
  };
}
