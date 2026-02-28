#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import YAML from "yaml";
import * as z from "zod/v4";

const SERVER_NAME = "splitwise-mcp";
const SERVER_VERSION = "0.1.0";
const SPLITWISE_BASE_URL =
  process.env.SPLITWISE_BASE_URL ?? "https://secure.splitwise.com/api/v3.0";

const TOKEN_ENV_KEYS = [
  "SPLITWISE_API_KEY",
  "SPLITWISE_ACCESS_TOKEN",
  "SPLITWISE_OAUTH_ACCESS_TOKEN",
  "SPLITWISE_BEARER_TOKEN"
] as const;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

type JsonRecord = Record<string, unknown>;

interface RawPathRef {
  $ref?: string;
}

interface RawSchema {
  type?: string;
  format?: string;
}

interface RawParameter {
  in?: string;
  name?: string;
  required?: boolean;
  description?: string;
  schema?: RawSchema;
}

interface RawRequestBody {
  required?: boolean;
  description?: string;
}

interface RawOperation {
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: RawRequestBody;
}

interface ParameterSpec {
  name: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schemaType?: string;
  schemaFormat?: string;
}

interface OperationSpec {
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

interface ApiCallResult {
  [key: string]: unknown;
  ok: boolean;
  status: number;
  statusText: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  data: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRepoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function getAccessToken(): string {
  for (const envKey of TOKEN_ENV_KEYS) {
    const value = process.env[envKey];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }

  throw new Error(
    `Missing Splitwise token. Set one of: ${TOKEN_ENV_KEYS.join(", ")}.`
  );
}

function sanitizeToolName(path: string): string {
  return path
    .replace(/^\//, "")
    .replace(/\//g, "_")
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function dedupeToolName(
  baseName: string,
  method: HttpMethod,
  existingNames: Set<string>
): string {
  const normalizedBase = baseName.length > 0 ? baseName : `${method}_root`;

  if (!existingNames.has(normalizedBase)) {
    return normalizedBase;
  }

  let candidate = `${method}_${normalizedBase}`;
  let counter = 2;

  while (existingNames.has(candidate)) {
    candidate = `${method}_${normalizedBase}_${counter}`;
    counter += 1;
  }

  return candidate;
}

function normalizeParameters(parameters: unknown[] | undefined): ParameterSpec[] {
  if (!Array.isArray(parameters)) {
    return [];
  }

  const output: ParameterSpec[] = [];

  for (const raw of parameters) {
    if (!isRecord(raw)) {
      continue;
    }

    const parameter = raw as RawParameter;

    if (parameter.in !== "path" && parameter.in !== "query") {
      continue;
    }

    if (typeof parameter.name !== "string" || parameter.name.length === 0) {
      continue;
    }

    output.push({
      name: parameter.name,
      in: parameter.in,
      required: parameter.in === "path" ? true : parameter.required === true,
      description:
        typeof parameter.description === "string"
          ? parameter.description
          : undefined,
      schemaType:
        typeof parameter.schema?.type === "string"
          ? parameter.schema.type
          : undefined,
      schemaFormat:
        typeof parameter.schema?.format === "string"
          ? parameter.schema.format
          : undefined
    });
  }

  return output;
}

function zodSchemaForParameter(parameter: ParameterSpec): z.ZodType {
  switch (parameter.schemaType) {
    case "integer":
      return z.coerce.number().int();
    case "number":
      return z.coerce.number();
    case "boolean":
      return z.coerce.boolean();
    case "array":
      return z.array(z.string());
    default:
      return z.string();
  }
}

function buildInputSchema(operation: OperationSpec): Record<string, z.ZodType> {
  const schemaShape: Record<string, z.ZodType> = {};

  for (const parameter of [
    ...operation.pathParameters,
    ...operation.queryParameters
  ]) {
    const locationText =
      parameter.in === "path" ? "Path parameter." : "Query parameter.";
    const formatText = parameter.schemaFormat
      ? ` Format: ${parameter.schemaFormat}.`
      : "";
    const descriptionText = parameter.description
      ? ` ${parameter.description}`
      : "";

    const described = zodSchemaForParameter(parameter).describe(
      `${locationText}${descriptionText}${formatText}`.trim()
    );

    schemaShape[parameter.name] = parameter.required
      ? described
      : described.optional();
  }

  if (operation.hasBody) {
    const baseBodySchema = z
      .any()
      .describe(
        [
          "JSON request body.",
          operation.bodyDescription ?? ""
        ]
          .join(" ")
          .trim()
      );

    schemaShape.body = operation.bodyRequired
      ? baseBodySchema
      : baseBodySchema.optional();
  }

  return schemaShape;
}

function buildResolvedPath(
  operation: OperationSpec,
  args: JsonRecord
): string {
  let resolvedPath = operation.apiPath;

  for (const parameter of operation.pathParameters) {
    const value = args[parameter.name];

    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required path parameter: ${parameter.name}`);
    }

    resolvedPath = resolvedPath.replace(
      `{${parameter.name}}`,
      encodeURIComponent(String(value))
    );
  }

  return resolvedPath;
}

function appendQueryParam(
  searchParams: URLSearchParams,
  key: string,
  value: unknown
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      searchParams.append(key, String(entry));
    }
    return;
  }

  if (isRecord(value)) {
    searchParams.append(key, JSON.stringify(value));
    return;
  }

  searchParams.append(key, String(value));
}

function appendBodyField(
  target: JsonRecord,
  key: string,
  value: string
): void {
  const existing = target[key];

  if (existing === undefined) {
    target[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }

  target[key] = [existing, value];
}

function parseUrlEncodedBody(rawBody: string): JsonRecord {
  const params = new URLSearchParams(rawBody);
  const parsed: JsonRecord = {};

  for (const [key, value] of params.entries()) {
    appendBodyField(parsed, key, value);
  }

  return parsed;
}

function normalizeBodyInput(rawBody: unknown): JsonRecord {
  if (typeof rawBody === "string") {
    const trimmed = rawBody.trim();

    if (trimmed.length === 0) {
      throw new Error(
        "The `body` field cannot be an empty string. Provide an object."
      );
    }

    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      if (!trimmed.includes("=")) {
        throw new Error(
          "String body must be a JSON object string or URL-encoded key/value pairs."
        );
      }

      return parseUrlEncodedBody(trimmed);
    }

    try {
      const parsed = JSON.parse(trimmed);

      if (!isRecord(parsed)) {
        throw new Error(
          "The `body` field must decode to a JSON object (not a primitive or array)."
        );
      }

      return parsed;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Invalid JSON in string body. Provide an object or valid JSON object string. ${error.message}`
        );
      }

      throw new Error(
        "Invalid JSON in string body. Provide an object or valid JSON object string."
      );
    }
  }

  if (!isRecord(rawBody)) {
    throw new Error(
      "The `body` field must be an object. Do not send serialized `_json` payloads."
    );
  }

  return rawBody;
}

function parseResponseBody(
  contentType: string | null,
  rawText: string
): unknown {
  const trimmed = rawText.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const advertisedJson = contentType?.includes("application/json") ?? false;

  if (advertisedJson || looksLikeJson) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return rawText;
    }
  }

  return rawText;
}

async function callSplitwise(
  operation: OperationSpec,
  args: JsonRecord
): Promise<ApiCallResult> {
  const accessToken = getAccessToken();
  const resolvedPath = buildResolvedPath(operation, args);
  const url = new URL(`${SPLITWISE_BASE_URL}${resolvedPath}`);

  for (const parameter of operation.queryParameters) {
    const value = args[parameter.name];

    if (value === undefined || value === null) {
      continue;
    }

    appendQueryParam(url.searchParams, parameter.name, value);
  }

  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json"
  };

  const requestInit: RequestInit = {
    method: operation.method.toUpperCase(),
    headers: requestHeaders
  };

  if (operation.hasBody) {
    const body = args.body;

    if (operation.bodyRequired && body === undefined) {
      throw new Error(
        `Missing required request body. Provide input field \`body\`.`
      );
    }

    if (body !== undefined) {
      const normalizedBody = normalizeBodyInput(body);
      requestHeaders["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(normalizedBody);
    }
  }

  const response = await fetch(url, requestInit);
  const responseText = await response.text();
  const parsedBody = parseResponseBody(
    response.headers.get("content-type"),
    responseText
  );

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    method: requestInit.method ?? operation.method.toUpperCase(),
    url: url.toString(),
    headers: Object.fromEntries(response.headers.entries()),
    data: parsedBody
  };
}

async function loadOperations(): Promise<OperationSpec[]> {
  const repoRoot = getRepoRoot();
  const indexPath = join(repoRoot, "spec", "paths", "index.yaml");
  const indexDoc = YAML.parse(await readFile(indexPath, "utf8"));

  if (!isRecord(indexDoc)) {
    throw new Error("spec/paths/index.yaml is not a valid YAML object.");
  }

  const operations: OperationSpec[] = [];
  const usedToolNames = new Set<string>();

  for (const [apiPath, rawRef] of Object.entries(indexDoc)) {
    if (!isRecord(rawRef)) {
      continue;
    }

    const ref = (rawRef as RawPathRef).$ref;

    if (typeof ref !== "string") {
      continue;
    }

    const pathSpecName = ref.replace(/^\.\//, "");
    const pathSpecPath = join(repoRoot, "spec", "paths", pathSpecName);
    const pathDoc = YAML.parse(await readFile(pathSpecPath, "utf8"));

    if (!isRecord(pathDoc)) {
      continue;
    }

    const sharedParameters = normalizeParameters(
      Array.isArray(pathDoc.parameters) ? pathDoc.parameters : undefined
    );

    for (const method of HTTP_METHODS) {
      const rawOperation = pathDoc[method];

      if (!isRecord(rawOperation)) {
        continue;
      }

      const operation = rawOperation as RawOperation;
      const operationParameters = normalizeParameters(operation.parameters);
      const mergedParameters = [...sharedParameters, ...operationParameters];

      const pathParameters = mergedParameters.filter(
        (parameter) => parameter.in === "path"
      );
      const queryParameters = mergedParameters.filter(
        (parameter) => parameter.in === "query"
      );

      const toolName = dedupeToolName(
        sanitizeToolName(apiPath),
        method,
        usedToolNames
      );
      usedToolNames.add(toolName);

      operations.push({
        toolName,
        method,
        apiPath,
        summary:
          typeof operation.summary === "string"
            ? operation.summary
            : `${method.toUpperCase()} ${apiPath}`,
        description:
          typeof operation.description === "string"
            ? operation.description
            : undefined,
        pathParameters,
        queryParameters,
        hasBody: Boolean(operation.requestBody),
        bodyRequired: operation.requestBody?.required === true,
        bodyDescription:
          typeof operation.requestBody?.description === "string"
            ? operation.requestBody.description
            : undefined
      });
    }
  }

  operations.sort((a, b) => a.toolName.localeCompare(b.toolName));

  return operations;
}

async function main(): Promise<void> {
  const operations = await loadOperations();

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  for (const operation of operations) {
    const description = [
      operation.summary,
      `HTTP ${operation.method.toUpperCase()} ${operation.apiPath}`,
      operation.hasBody ? "Provide JSON request payload in `body`." : undefined,
      operation.description
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");

    server.registerTool(
      operation.toolName,
      {
        description,
        inputSchema: buildInputSchema(operation)
      },
      async (input) => {
        try {
          const args = isRecord(input) ? input : {};
          const result = await callSplitwise(operation, args);
          const text = JSON.stringify(result, null, 2);

          return {
            isError: !result.ok,
            content: [{ type: "text", text }],
            structuredContent: result
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown server error";

          return {
            isError: true,
            content: [{ type: "text", text: message }]
          };
        }
      }
    );
  }

  server.registerTool(
    "splitwise_list_operations",
    {
      description:
        "List all Splitwise API operations currently exposed as MCP tools.",
      inputSchema: {}
    },
    async () => {
      const summary = operations.map((operation) => ({
        tool: operation.toolName,
        method: operation.method.toUpperCase(),
        path: operation.apiPath,
        summary: operation.summary
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: summary.length,
                operations: summary
              },
              null,
              2
            )
          }
        ],
        structuredContent: {
          count: summary.length,
          operations: summary
        }
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("splitwise-mcp fatal error", error);
  process.exit(1);
});
