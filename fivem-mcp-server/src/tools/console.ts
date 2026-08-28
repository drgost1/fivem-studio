import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tailConsoleLog } from "../logs.js";
import { config } from "../config.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function registerConsoleTools(server: McpServer) {
  server.tool(
    "get_console_output",
    "Return recent lines from the FXServer console log. Reads txAdmin's on-disk fxserver console " +
      "log (TXADMIN_DATA_DIR/<control-profile>/logs/) rather than attaching to stdout, since txAdmin " +
      "owns the server process. Requires both TXADMIN_DATA_DIR and TXADMIN_CONTROL_PROFILE in .env.",
    {
      lines: z
        .number()
        .int()
        .positive()
        .max(5000)
        .default(200)
        .describe("How many trailing lines to return."),
      filter: z
        .string()
        .max(256)
        .optional()
        .describe("Only return lines containing this text (case-insensitive substring match)."),
    },
    async ({ lines, filter }) => {
      const output = tailConsoleLog({
        dataDir: config.txAdmin.dataDir,
        profile: config.txAdmin.controlProfile,
        lines,
        filter,
      });
      return text(output.length > 0 ? output : "(no matching lines)");
    },
  );
}
