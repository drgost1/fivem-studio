import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assertInsideRoots, runProc } from "../workspace.js";
import { RconClient } from "../rcon.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Raw FXServer console command over loopback RCON. Enabled with
 * MCP_ENABLE_RAW_RCON=1 — off by default because it is the server's full
 * console (refresh, ensure, convars, resource commands, everything). */
export function registerRawRconTool(server: McpServer, rcon: RconClient): void {
  server.tool(
    "server_command",
    "Send a raw console command to FXServer over loopback RCON and return its reply. The full " +
      "console surface: refresh, ensure <res>, restart <res>, convars, resource-registered commands. " +
      "After copying new files for a resource with a changed fxmanifest, run refresh before ensure.",
    {
      command: z.string().min(1).max(512).regex(/^[^\r\n\x00]+$/, "Single line only.")
        .describe("Exact console command line."),
    },
    async ({ command }) => {
      const output = await rcon.command(command);
      return text(output.trim() || `Sent: ${command}`);
    },
  );
}

/** Arbitrary shell commands inside the workspace roots. Enabled with
 * MCP_ENABLE_SHELL=1 — the operator's deliberate opt-in, because this is
 * general host execution (bounded by timeout, output cap and working dir). */
export function registerShellTool(server: McpServer): void {
  server.tool(
    "run_command",
    "Run a shell command on this host (sh -c), with the working directory inside the workspace " +
      "roots, a hard timeout and a capped combined output. For anything the purpose-built tools " +
      "don't cover: tar, rsync between resources, chmod, find, node scripts.",
    {
      command: z.string().min(1).max(4_000).describe("Shell command line (sh -c)."),
      cwd: z.string().max(4096).describe("Absolute working directory inside the workspace roots."),
      timeout_seconds: z.number().int().positive().max(300).default(60),
    },
    async ({ command, cwd, timeout_seconds }) => {
      const resolved = assertInsideRoots(cwd);
      const result = await runProc("sh", ["-c", command], {
        cwd: resolved,
        timeoutMs: timeout_seconds * 1000,
        maxBytes: 128 * 1024,
      });
      const body = `${result.stdout}\n${result.stderr}`.trim().slice(-8_000);
      return text(`exit ${result.code}${result.timedOut ? " (timed out)" : ""}\n${body}`);
    },
  );
}
