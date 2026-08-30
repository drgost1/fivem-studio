import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { formatResourceStatuses, listResourceStatuses } from "../resourceStatus.js";
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

const resourceStatusOutputSchema = {
  resources: z.array(z.object({
    name: z.string(),
    state: z.enum(["started", "stopped"]),
  })),
  serverStateAvailable: z.boolean(),
};

export function registerResourceTools(server: McpServer, rcon: RconClient) {
  server.registerTool(
    "list_resources",
    {
      description:
        "List resources detected in the selected server-data workspace and show which ones the local " +
        "FXServer currently reports as started. This is read-only and does not rely on an undocumented console command.",
      inputSchema: {},
      outputSchema: resourceStatusOutputSchema,
    },
    async () => {
      const result = await listResourceStatuses(config.serverData.workspacePath, config.rcon.host, config.rcon.port);
      return {
        content: [{ type: "text" as const, text: formatResourceStatuses(result) }],
        structuredContent: result,
      };
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
