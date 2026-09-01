import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assertInsideRoots, rootsSummary, runProc } from "../workspace.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_DIR_ENTRIES = 500;

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Direct filesystem access for the coding workspace. These tools run on the
 * host itself, so a cloud agent pays one round-trip instead of an SSH
 * handshake per file. Enabled with MCP_ENABLE_FILES=1. */
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
    async ({ path: target, start_line, line_count }) => {
      const resolved = assertInsideRoots(target);
      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) return text(`Not a file: ${resolved}`);
      if (stat.size > MAX_READ_BYTES) {
        return text(`File is ${stat.size} bytes; the cap is ${MAX_READ_BYTES}. Use start_line/line_count on a smaller slice, or search_files.`);
      }
      const raw = fs.readFileSync(resolved);
      if (raw.includes(0)) return text(`Binary file (${stat.size} bytes) — refusing to return as text.`);
      const content = raw.toString("utf8");
      const digest = sha256(raw);
      if (start_line !== undefined) {
        const lines = content.split("\n");
        const slice = lines.slice(start_line - 1, start_line - 1 + (line_count ?? 200));
        return text(`sha256:${digest} lines ${start_line}-${start_line - 1 + slice.length} of ${lines.length}\n` + slice.join("\n"));
      }
      return text(`sha256:${digest}\n${content}`);
    },
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
    async ({ path: target, content, expected_sha256 }) => {
      const resolved = assertInsideRoots(target);
      const existing = fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
      if (expected_sha256 && existing && sha256(existing) !== expected_sha256) {
        return text("CONFLICT: the file changed since that sha256 was read. Re-read it and merge.");
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const temp = `${resolved}.mcp-${process.pid}.tmp`;
      fs.writeFileSync(temp, content, "utf8");
      fs.renameSync(temp, resolved);
      return text(`Wrote ${Buffer.byteLength(content, "utf8")} bytes. New sha256:${sha256(content)}`);
    },
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
    async ({ path: target, old_text, new_text, occurrences }) => {
      const resolved = assertInsideRoots(target);
      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) return text(`Not a file: ${resolved}`);
      if (stat.size > MAX_WRITE_BYTES) return text(`File exceeds the ${MAX_WRITE_BYTES}-byte edit cap.`);
      const raw = fs.readFileSync(resolved);
      if (raw.includes(0)) return text("Binary file — refusing to edit as text.");
      const content = raw.toString("utf8");
      const found = content.split(old_text).length - 1;
      if (found !== occurrences) {
        return text(`Expected ${occurrences} occurrence(s), found ${found}. Nothing changed.`);
      }
      const next = content.split(old_text).join(new_text);
      const temp = `${resolved}.mcp-${process.pid}.tmp`;
      fs.writeFileSync(temp, next, "utf8");
      fs.renameSync(temp, resolved);
      return text(`Replaced ${found} occurrence(s). New sha256:${sha256(next)}`);
    },
  );

  server.tool(
    "list_dir",
    "List a directory inside the workspace roots: name, kind and size per entry.",
    {
      path: z.string().max(4096).describe("Absolute directory path on this host."),
    },
    async ({ path: target }) => {
      const resolved = assertInsideRoots(target);
      const entries = fs.readdirSync(resolved, { withFileTypes: true }).slice(0, MAX_DIR_ENTRIES);
      const lines = entries.map((entry) => {
        const kind = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
        let size = "";
        if (kind === "file") {
          try {
            size = ` ${fs.statSync(path.join(resolved, entry.name)).size}`;
          } catch {
            // unreadable entry; the name is still worth listing
          }
        }
        return `${kind}${size}\t${entry.name}`;
      });
      return text(lines.join("\n") || "(empty)");
    },
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
    async ({ pattern, path: target, max_results }) => {
      const resolved = assertInsideRoots(target);
      const result = await runProc(
        "grep",
        ["-RInE", "--binary-files=without-match", "--exclude-dir=.git", "--exclude-dir=node_modules",
          "--exclude-dir=cache", "-m", "5", "-e", pattern, "."],
        { cwd: resolved, timeoutMs: 30_000, maxBytes: 256 * 1024 },
      );
      // grep exits 1 for "no matches", which is a result, not a failure.
      if (result.code > 1) return text(`Search failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      const lines = result.stdout.split("\n").filter(Boolean).slice(0, max_results);
      return text(lines.length > 0 ? lines.join("\n") : "(no matches)");
    },
  );

  server.tool(
    "check_lua",
    "Syntax-check a Lua file with luac (parse only, nothing runs). Do this before restarting a " +
      "resource — a file that fails here will kill the resource on load.",
    {
      path: z.string().max(4096).describe("Absolute path to a .lua file on this host."),
    },
    async ({ path: target }) => {
      const resolved = assertInsideRoots(target);
      for (const binary of ["luac5.4", "luac5.3", "luac"]) {
        const result = await runProc(binary, ["-p", resolved], { cwd: path.dirname(resolved), timeoutMs: 15_000 });
        if (result.code === 0) return text(`OK: ${path.basename(resolved)} parses cleanly (${binary}).`);
        if (!/not found|ENOENT/i.test(result.stderr)) {
          return text(`SYNTAX ERROR (${binary}):\n${(result.stderr || result.stdout).trim()}`);
        }
      }
      return text("No luac binary found on this host (tried luac5.4, luac5.3, luac).");
    },
  );
}
