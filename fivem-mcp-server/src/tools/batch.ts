import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  opCheckLua,
  opEditFile,
  opListDir,
  opReadFile,
  opSearchFiles,
  opWriteFile,
} from "../fileOps.js";

const MAX_OPERATIONS = 25;

/**
 * Per-call latency against a remote host is dominated by the round trip, not
 * by the work — so a ten-file change costs ten times more in waiting than in
 * doing. This runs a sequence of file operations over a single call. Each step
 * is the same function the individual tool calls, so behaviour and jailing are
 * identical.
 */
const operationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("read_file"),
    path: z.string().max(4096),
    start_line: z.number().int().positive().optional(),
    line_count: z.number().int().positive().max(2000).optional(),
  }),
  z.object({
    op: z.literal("write_file"),
    path: z.string().max(4096),
    content: z.string().max(2 * 1024 * 1024),
    expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  z.object({
    op: z.literal("edit_file"),
    path: z.string().max(4096),
    old_text: z.string().min(1).max(100_000),
    new_text: z.string().max(100_000),
    occurrences: z.number().int().positive().max(1000).optional(),
  }),
  z.object({ op: z.literal("list_dir"), path: z.string().max(4096) }),
  z.object({
    op: z.literal("search_files"),
    pattern: z.string().min(1).max(512),
    path: z.string().max(4096),
    max_results: z.number().int().positive().max(500).optional(),
  }),
  z.object({ op: z.literal("check_lua"), path: z.string().max(4096) }),
]);

type Operation = z.infer<typeof operationSchema>;

async function runOperation(operation: Operation): Promise<string> {
  switch (operation.op) {
    case "read_file":
      return opReadFile(operation);
    case "write_file":
      return opWriteFile(operation);
    case "edit_file":
      return opEditFile(operation);
    case "list_dir":
      return opListDir(operation);
    case "search_files":
      return opSearchFiles(operation);
    case "check_lua":
      return opCheckLua(operation);
  }
}

/** A step whose result text reports a refusal rather than a completed action. */
function looksFailed(result: string): boolean {
  return /^(?:CONFLICT|Not a file|Binary file|Expected \d+ occurrence|SYNTAX ERROR|Search failed|File is \d+ bytes|File exceeds)/.test(result);
}

export function registerBatchTool(server: McpServer): void {
  server.registerTool(
    "batch",
    {
      description:
        "Run several workspace file operations in ONE call: read_file, write_file, edit_file, list_dir, " +
        "search_files, check_lua. They execute in order and stop at the first failure unless " +
        "continue_on_error is set. Prefer this whenever you already know the next few steps — against a " +
        "remote host each separate call pays a network round trip, and this pays one for all of them.",
      inputSchema: {
        operations: z.array(operationSchema).min(1).max(MAX_OPERATIONS)
          .describe("Operations to run in order. Each needs an `op` naming the tool plus that tool's arguments."),
        continue_on_error: z.boolean().default(false)
          .describe("Keep going after a step fails. Off by default so a bad edit does not cascade."),
      },
      outputSchema: {
        results: z.array(z.object({
          index: z.number(),
          op: z.string(),
          ok: z.boolean(),
          result: z.string(),
        })),
        completed: z.number(),
        failed: z.number(),
      },
    },
    async ({ operations, continue_on_error }) => {
      const results: Array<{ index: number; op: string; ok: boolean; result: string }> = [];
      let failed = 0;
      for (const [index, operation] of operations.entries()) {
        let ok = true;
        let result: string;
        try {
          result = await runOperation(operation);
          if (looksFailed(result)) ok = false;
        } catch (err) {
          ok = false;
          result = (err as Error).message;
        }
        if (!ok) failed += 1;
        results.push({ index, op: operation.op, ok, result });
        if (!ok && !continue_on_error) {
          results.push({
            index: index + 1,
            op: "(halted)",
            ok: false,
            result: `Stopped after step ${index} failed; ${operations.length - index - 1} operation(s) not attempted. Pass continue_on_error to run them anyway.`,
          });
          break;
        }
      }
      const body = results
        .map((entry) => `[${entry.index}] ${entry.op} ${entry.ok ? "OK" : "FAILED"}\n${entry.result}`)
        .join("\n\n");
      return {
        content: [{ type: "text" as const, text: body }],
        structuredContent: { results, completed: results.filter((r) => r.ok).length, failed },
      };
    },
  );
}
