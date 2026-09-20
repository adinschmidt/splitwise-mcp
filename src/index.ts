#!/usr/bin/env bun
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { buildInputSchema, createClient, type ApiCallResult, type OperationSpec, type SplitwiseClient } from './sdk.js';

const SERVER_NAME = 'splitwise-mcp';
const SERVER_VERSION = '0.1.0';

/** Preserve the request result metadata, but never silently drop records or clip JSON. */
export function boundResult(result: ApiCallResult): ApiCallResult {
  if (Buffer.byteLength(JSON.stringify(result)) <= 50_000) return result;
  const { pagination, ...metadata } = result;
  return { ...metadata, headers: {}, outputTruncated: true, data: {
    omitted: true,
    message: result.method === 'GET'
      ? 'Response exceeds 50 KB. Retry with a smaller limit and the same offset where supported, or use the SDK for the full response. No response records are included here.'
      : 'Response exceeds 50 KB. Do not repeat this write. Use a read operation to verify the result. Use the SDK for full responses to future requests.',
  } };
}

function humanizeToolName(toolName: string): string {
  return toolName
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function buildAnnotations(operation: OperationSpec): ToolAnnotations {
  const name = operation.toolName;

  if (operation.method === "get") {
    return { readOnlyHint: true };
  }

  if (name.startsWith("delete_") || name.startsWith("remove_")) {
    return { destructiveHint: true, idempotentHint: true };
  }

  if (name.startsWith("undelete_")) {
    return { destructiveHint: false, idempotentHint: true };
  }

  if (name.startsWith("create_") || name.startsWith("add_")) {
    return { destructiveHint: false, idempotentHint: false };
  }

  if (name.startsWith("update_")) {
    return { destructiveHint: true, idempotentHint: true };
  }

  return {};
}

const apiResultOutputSchema = z.object({
  outputTruncated: z.boolean().optional(),
  pagination: z.object({ offset: z.number(), returned: z.number(), nextOffset: z.number().nullable() }).optional(),
  ok: z.boolean().describe("True when HTTP succeeds and Splitwise reports no errors."),
  status: z.number().int().describe("HTTP status code."),
  statusText: z.string(),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  data: z
    .unknown()
    .describe("Parsed JSON body returned by Splitwise (or raw text when not JSON).")
});

export function buildServer(client: SplitwiseClient): McpServer {
  const { operations } = client;
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "Splitwise",
      description: "MCP server exposing the Splitwise API."
    },
    {
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" }
      }
    }
  );

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
        title: humanizeToolName(operation.toolName),
        description,
        inputSchema: buildInputSchema(operation, true),
        outputSchema: apiResultOutputSchema,
        annotations: buildAnnotations(operation)
      },
      async (input) => {
        try {
          const result = await client.call(operation.toolName, input);
          const bounded = boundResult(result);
          const text = JSON.stringify(bounded);

          return {
            isError: !result.ok,
            content: [{ type: "text", text }],
            structuredContent: bounded
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
      title: "List Splitwise Operations",
      description:
        "List all Splitwise API operations currently exposed as MCP tools.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        count: z.number().int(),
        operations: z.array(
          z.object({
            tool: z.string(),
            method: z.string(),
            path: z.string(),
            summary: z.string()
          })
        )
      }),
      annotations: { readOnlyHint: true }
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

  return server;
}

async function main(): Promise<void> {
  const client = await createClient();
  serveStdio(() => buildServer(client), {
    onerror: (error) => console.error('splitwise-mcp serving error', error),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('splitwise-mcp fatal error', error);
    process.exitCode = 1;
  });
}
