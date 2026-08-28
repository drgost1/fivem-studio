import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RconClient } from "../rcon.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// Collection folders such as [dev] are configured through server.cfg; a
// runnable resource itself must be a single safe console token.
export const resourceNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/, "Resource names may contain only letters, numbers, _, -, and .")
  .max(128)
  .describe("Resource name, exactly as it appears in list_resources.");

export function registerResourceTools(server: McpServer, rcon: RconClient) {
  server.tool(
    "list_resources",
    "List FXServer resources and their loaded/started state. Sends the console `resources` command " +
      "and returns its raw output verbatim — FXServer does not have a documented, stable machine-" +
      "readable format for this over RCON, so this is best-effort text, not parsed JSON.",
    {},
    async () => {
      const output = await rcon.command("resources");
      return text(output.trim().length > 0 ? output : "(no output — check the local RCON configuration)");
    },
  );

  server.tool(
    "start_resource",
    "Start a stopped FXServer resource by name.",
    { name: resourceNameSchema },
    async ({ name }) => {
      const output = await rcon.command(`start ${name}`);
      return text(output.trim() || `Sent: start ${name}`);
    },
  );

  server.tool(
    "stop_resource",
    "Stop a running FXServer resource by name.",
    { name: resourceNameSchema },
    async ({ name }) => {
      const output = await rcon.command(`stop ${name}`);
      return text(output.trim() || `Sent: stop ${name}`);
    },
  );

  server.tool(
    "restart_resource",
    "Restart a FXServer resource by name (stop + start in one console command). If the resource " +
      "isn't currently running, this starts it instead (matches FXServer's `ensure` semantics).",
    { name: resourceNameSchema },
    async ({ name }) => {
      const output = await rcon.command(`ensure ${name}`);
      return text(output.trim() || `Sent: ensure ${name}`);
    },
  );
}
