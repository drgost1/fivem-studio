import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { config } from "../config.js";
import { getConsoleCursor, readConsoleSince, tailConsoleLog } from "../logs.js";
import { parseConsoleDiagnostics, formatDiagnostics } from "../diagnostics.js";
import { listResourceStatuses } from "../resourceStatus.js";
import { RconClient } from "../rcon.js";
import { resourceNameSchema } from "./resources.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function consoleConfigured(): boolean {
  return Boolean(config.txAdmin.dataDir && config.txAdmin.controlProfile);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * These two tools add no privilege over the base surface — they are the
 * console reader and the resource lifecycle already exposed, composed into the
 * loop an agent actually runs. They exist to collapse round trips: "restart it
 * and tell me if it broke" was three calls plus reading a wall of log text.
 */
export function registerVerifyTools(server: McpServer, rcon: RconClient): void {
  server.registerTool(
    "restart_and_verify",
    {
      description:
        "Restart a resource and report whether it actually came up clean. Marks the console position, " +
        "sends `ensure`, waits for the resource to load, then returns only the errors and warnings " +
        "produced after that point plus the resource's resulting state. Use this instead of " +
        "restart_resource + get_console_output: it is one round trip and it reads only the new lines.",
      inputSchema: {
        name: resourceNameSchema,
        wait_ms: z.number().int().min(250).max(20_000).default(3000)
          .describe("How long to let the resource load before reading the console. Raise it for heavy resources."),
      },
      outputSchema: {
        resource: z.string(),
        started: z.boolean().nullable().describe("Server-reported state after the restart; null when the server did not answer."),
        ok: z.boolean().describe("Started, with no errors in the new console output."),
        errors: z.array(z.string()),
        warnings: z.array(z.string()),
        consoleAvailable: z.boolean(),
      },
    },
    async ({ name, wait_ms }) => {
      const canReadConsole = consoleConfigured();
      let cursor = null as ReturnType<typeof getConsoleCursor> | null;
      let cursorError: string | null = null;
      if (canReadConsole) {
        try {
          cursor = getConsoleCursor(config.txAdmin.dataDir, config.txAdmin.controlProfile);
        } catch (err) {
          cursorError = (err as Error).message;
        }
      }

      const commandOutput = (await rcon.command(`ensure ${name}`)).trim();
      await sleep(wait_ms);

      let errors: string[] = [];
      let warnings: string[] = [];
      let consoleNote = "";
      if (cursor) {
        try {
          const { lines, rotated } = readConsoleSince(config.txAdmin.dataDir, config.txAdmin.controlProfile, cursor);
          const summary = parseConsoleDiagnostics(lines, { limit: 40 });
          errors = summary.errors.map((d) => `${d.resource ? `[${d.resource}] ` : ""}${d.text}`);
          warnings = summary.warnings.map((d) => `${d.resource ? `[${d.resource}] ` : ""}${d.text}`);
          consoleNote = `read ${lines.length} new console line(s)${rotated ? " (log rotated during the restart)" : ""}`;
        } catch (err) {
          consoleNote = `console unreadable: ${(err as Error).message}`;
        }
      } else {
        consoleNote = cursorError
          ? `console unreadable: ${cursorError}`
          : "console tailing is not configured (TXADMIN_DATA_DIR / TXADMIN_CONTROL_PROFILE), so only the server-reported state was checked";
      }

      let started: boolean | null = null;
      try {
        const status = await listResourceStatuses(config.serverData.workspacePath, config.rcon.host, config.rcon.port);
        if (status.serverStateAvailable) {
          const match = status.resources.find((r) => r.name.toLowerCase() === name.toLowerCase());
          started = match ? match.state === "started" : false;
        }
      } catch {
        // The state probe is a bonus; console findings still stand on their own.
      }

      const ok = started !== false && errors.length === 0;
      const headline = ok
        ? `OK: ${name} restarted cleanly${started === null ? " (state unconfirmed)" : ""}.`
        : `PROBLEM: ${name} ${started === false ? "is not running" : "restarted"} with ${errors.length} error(s).`;
      const body = [
        headline,
        commandOutput ? `console: ${commandOutput}` : "",
        errors.length ? `ERRORS:\n${errors.map((e) => `  ${e}`).join("\n")}` : "",
        warnings.length ? `WARNINGS:\n${warnings.map((w) => `  ${w}`).join("\n")}` : "",
        `(${consoleNote})`,
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text" as const, text: body }],
        structuredContent: { resource: name, started, ok, errors, warnings, consoleAvailable: Boolean(cursor) },
      };
    },
  );

  server.registerTool(
    "get_errors",
    {
      description:
        "Return only the errors and warnings from recent console output, de-duplicated and attributed " +
        "to the resource that produced them. Far cheaper than get_console_output when the question is " +
        "\"what is broken\" — use that one only when you need the surrounding narrative.",
      inputSchema: {
        lines: z.number().int().positive().max(5000).default(500)
          .describe("How many trailing console lines to examine."),
        resource: z.string().max(128).optional()
          .describe("Only report findings attributed to this resource."),
        include_warnings: z.boolean().default(true),
      },
      outputSchema: {
        errors: z.array(z.object({ resource: z.string().nullable(), text: z.string() })),
        warnings: z.array(z.object({ resource: z.string().nullable(), text: z.string() })),
        scannedLines: z.number(),
      },
    },
    async ({ lines, resource, include_warnings }) => {
      const raw = tailConsoleLog({
        dataDir: config.txAdmin.dataDir,
        profile: config.txAdmin.controlProfile,
        lines,
      });
      const summary = parseConsoleDiagnostics(raw.split("\n"), { resource: resource ?? null });
      if (!include_warnings) summary.warnings = [];
      return {
        content: [{ type: "text" as const, text: formatDiagnostics(summary) }],
        structuredContent: {
          errors: summary.errors.map((d) => ({ resource: d.resource, text: d.text })),
          warnings: summary.warnings.map((d) => ({ resource: d.resource, text: d.text })),
          scannedLines: summary.scannedLines,
        },
      };
    },
  );
}
