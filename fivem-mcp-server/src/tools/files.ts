import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { rootsSummary } from "../workspace.js";
import {
  MAX_WRITE_BYTES,
  opCheckLua,
  opEditFile,
  opListDir,
  opReadFile,
  opSearchFiles,
  opWriteFile,
} from "../fileOps.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Direct filesystem access for the coding workspace. These tools run on the
 * host itself, so a cloud agent pays one round-trip instead of an SSH
 * handshake per file. Enabled with MCP_ENABLE_FILES=1. The operations
 * themselves live in fileOps.ts, shared with the `batch` tool. */
export function registerFileTools(server: McpServer): void {
  server.tool(
    "read_file",
    "Read a UTF-8 text file inside the workspace roots (" + rootsSummary() + "). " +
      "Returns the content plus its sha256, which write_file accepts for conflict-safe saves.",
    {
      path: z.string().max(4096).describe("Absolute path on this host."),
      start_line: z.number().int().positive().optional()
        .describe("First line to return (1-based). Omit for the whole file."),
      line_count: z.number().int().positive().max(2000).optional()
        .describe("How many lines from start_line."),
    },
    async ({ path: target, start_line, line_count }) =>
      text(opReadFile({ path: target, start_line, line_count })),
  );

  server.tool(
    "write_file",
    "Write a UTF-8 text file inside the workspace roots, atomically (temp file + rename). " +
      "Pass expected_sha256 from a prior read_file to fail instead of overwriting concurrent changes. " +
      "Creates parent directories. Remember to restart the resource afterwards for the server to pick it up.",
    {
      path: z.string().max(4096).describe("Absolute path on this host."),
      content: z.string().max(MAX_WRITE_BYTES).describe("Full new file content."),
      expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional()
        .describe("sha256 the current on-disk file must have; omit for a new file or a forced write."),
    },
    async ({ path: target, content, expected_sha256 }) =>
      text(opWriteFile({ path: target, content, expected_sha256 })),
  );

  server.tool(
    "edit_file",
    "Replace an exact substring in a UTF-8 file, atomically. The old text must occur exactly once " +
      "(or pass occurrences to assert a different count and replace all of them). Much cheaper than " +
      "write_file for a small change — no need to resend the whole file.",
    {
      path: z.string().max(4096),
      old_text: z.string().min(1).max(100_000).describe("Exact text to find."),
      new_text: z.string().max(100_000).describe("Replacement text."),
      occurrences: z.number().int().positive().max(1000).default(1)
        .describe("How many times old_text must occur; all are replaced."),
    },
    async ({ path: target, old_text, new_text, occurrences }) =>
      text(opEditFile({ path: target, old_text, new_text, occurrences })),
  );

  server.tool(
    "list_dir",
    "List a directory inside the workspace roots: name, kind and size per entry.",
    {
      path: z.string().max(4096).describe("Absolute directory path on this host."),
    },
    async ({ path: target }) => text(opListDir({ path: target })),
  );

  server.tool(
    "search_files",
    "Search file contents under a directory in the workspace roots (grep -RIn). Returns matching " +
      "lines as path:line:text, capped. Use a specific directory to keep it fast.",
    {
      pattern: z.string().min(1).max(512).describe("Extended regular expression (grep -E)."),
      path: z.string().max(4096).describe("Directory to search under."),
      max_results: z.number().int().positive().max(500).default(100),
    },
    async ({ pattern, path: target, max_results }) =>
      text(await opSearchFiles({ pattern, path: target, max_results })),
  );

  server.tool(
    "check_lua",
    "Syntax-check a Lua file with luac (parse only, nothing runs). Do this before restarting a " +
      "resource — a file that fails here will kill the resource on load.",
    {
      path: z.string().max(4096).describe("Absolute path to a .lua file on this host."),
    },
    async ({ path: target }) => text(await opCheckLua({ path: target })),
  );
}
