// QB Studio's dashboard and coding agent share the same narrow loopback
// runtime protocol, so console and resource lifecycle state stay in sync.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "node:path";

import { loadConfig } from "./configStore";
import { parseLoopbackHttpUrl } from "./localUrl";

export interface McpToolSummary {
  name: string;
  description?: string;
}

/** Full tool definition, in the shape the Anthropic Messages API wants for `tools`.
 *  `type` is pinned to the literal "object" so this structurally satisfies the
 *  SDK's InputSchema without a cast at the call site. */
export interface McpToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; [key: string]: unknown };
}

let toolDefinitions: McpToolDefinition[] = [];

export function mcpToolDefinitions(): McpToolDefinition[] {
  return toolDefinitions;
}

export interface McpConnectResult {
  ok: boolean;
  error?: string;
  tools?: McpToolSummary[];
  runtimeIdentity?: RuntimeIdentity;
  workspaceMatch?: RuntimeWorkspaceMatch;
}

/** Versioned, secret-free identity returned by the bundled runtime. */
export interface RuntimeIdentity {
  contractVersion: "3" | string;
  mcp: { name: string; version: string };
  runtime: {
    serverData: { workspacePath: string; configPath: string };
    txAdmin: { dataDirectory: string | null; controlProfile: string | null };
    rcon: { host: string; port: number; configured: boolean };
  };
  capabilities: {
    console: boolean;
    resourceLifecycle: boolean;
  };
}

/** Non-secret server identity calculated by managedRuntime from the selected
 * server.cfg. This stays in Electron's main process and is never exposed to
 * the renderer. */
export interface ManagedServerIdentity {
  workspacePath: string;
  serverConfigPath: string;
  rcon: { host: string; port: number };
}

export interface RuntimeWorkspaceMatch {
  ok: boolean;
  reason?: string;
}

export interface ResourceStatusItem {
  name: string;
  state: "started" | "stopped";
}

export interface ResourceStatusResult {
  resources: ResourceStatusItem[];
  serverStateAvailable: boolean;
}

let client: Client | null = null;
let connectedUrl: string | null = null;
let runtimeIdentity: RuntimeIdentity | null = null;
let managedServerIdentity: ManagedServerIdentity | null = null;
let connectionGeneration = 0;

// Everything outside this set can change the running server or a connected
// client. Studio is a local IDE, but it still must not restart profile B after
// the editor has written profile A.
const READ_ONLY_RUNTIME_TOOLS = new Set([
  "get_runtime_identity",
  "get_console_output",
  "list_resources",
]);

/** Notified when the transport drops on its own (server stopped, network died),
 *  so the UI can reflect it instead of showing a stale "Connected". */
let onDropped: (() => void) | null = null;

export function setOnDropped(callback: () => void): void {
  onDropped = callback;
}

export async function mcpConnect(
  url: string,
  token: string,
  expectedServerIdentity?: ManagedServerIdentity,
): Promise<McpConnectResult> {
  const generation = ++connectionGeneration;
  await closeActiveClient();
  let newClient: Client | null = null;

  try {
    const transport = new StreamableHTTPClientTransport(parseLoopbackHttpUrl(url, "MCP URL"), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    newClient = new Client({ name: "qb-studio", version: "0.0.0-development" });
    newClient.onclose = () => {
      // Only react if this is still the active client — a reconnect closes the old one.
      if (client === newClient) {
        client = null;
        connectedUrl = null;
        toolDefinitions = [];
        runtimeIdentity = null;
        managedServerIdentity = null;
        onDropped?.();
      }
    };
    await newClient.connect(transport);

    if (generation !== connectionGeneration) {
      await newClient.close().catch(() => undefined);
      return { ok: false, error: "Connection attempt was superseded by newer settings." };
    }

    const listed = await newClient.listTools();
    const identity = listed.tools.some((tool) => tool.name === "get_runtime_identity")
      ? await readRuntimeIdentity(newClient)
      : null;
    if (generation !== connectionGeneration) {
      await newClient.close().catch(() => undefined);
      return { ok: false, error: "Connection attempt was superseded by newer settings." };
    }
    client = newClient;
    connectedUrl = url;
    runtimeIdentity = identity;
    managedServerIdentity = expectedServerIdentity ?? null;
    toolDefinitions = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: { ...(t.inputSchema ?? { properties: {} }), type: "object" as const },
    }));

    return {
      ok: true,
      tools: listed.tools.map((t) => ({ name: t.name, description: t.description })),
      runtimeIdentity: identity ?? undefined,
      workspaceMatch: runtimeWorkspaceMatch(identity),
    };
  } catch (err) {
    if (newClient && client !== newClient) await newClient.close().catch(() => undefined);
    if (generation === connectionGeneration) {
      client = null;
      connectedUrl = null;
      toolDefinitions = [];
      runtimeIdentity = null;
      managedServerIdentity = null;
    }
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

export async function mcpDisconnect(): Promise<void> {
  connectionGeneration += 1;
  await closeActiveClient();
}

async function closeActiveClient(): Promise<void> {
  // Clear the reference first: close() fires onclose, and that handler must not
  // treat an intentional disconnect as a dropped connection.
  const closing = client;
  client = null;
  connectedUrl = null;
  toolDefinitions = [];
  runtimeIdentity = null;
  managedServerIdentity = null;

  if (closing) {
    try {
      await closing.close();
    } catch {
      // best effort — the transport may already be dead
    }
  }
}

export function mcpIsConnected(): boolean {
  return client !== null;
}

export function mcpConnectedUrl(): string | null {
  return connectedUrl;
}

export function mcpRuntimeIdentity(): RuntimeIdentity | null {
  return runtimeIdentity;
}

export function mcpRuntimeWorkspaceMatch(): RuntimeWorkspaceMatch {
  return runtimeWorkspaceMatch(runtimeIdentity);
}

/**
 * Calls a tool and returns its result as plain text — every tool in
 * The bundled runtime responds with a single text content block (JSON-encoded
 * for structured results), so this is the one shape the UI needs to handle.
 */
export async function mcpCallTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!client) throw new Error("Not connected to the bundled coding runtime.");

  if (!READ_ONLY_RUNTIME_TOOLS.has(name)) {
    const match = runtimeWorkspaceMatch(runtimeIdentity);
    if (!match.ok) {
      throw new Error(
        `${match.reason ?? "The active workspace does not match the connected Cfx.re runtime."} ` +
          "Runtime mutations are blocked until Settings points QB Studio at the same server-data workspace and local RCON endpoint.",
      );
    }
  }

  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const textBlock = content?.find((c) => c.type === "text");

  if (result.isError) {
    throw new Error(textBlock?.text ?? `${name} failed`);
  }
  return textBlock?.text ?? "";
}

/** Typed UI path for list_resources. The agent continues to receive the
 * unchanged text block while the renderer gets validated structured state. */
export async function mcpListResourceStatuses(): Promise<ResourceStatusResult> {
  if (!client) throw new Error("Not connected to the bundled coding runtime.");
  const result = await client.callTool({ name: "list_resources", arguments: {} });
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const textBlock = content?.find((block) => block.type === "text")?.text;
  if (result.isError) throw new Error(textBlock ?? "Could not list resources.");

  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("The bundled runtime did not return structured resource state.");
  }
  const value = structured as Record<string, unknown>;
  if (!Array.isArray(value.resources) || typeof value.serverStateAvailable !== "boolean") {
    throw new Error("The bundled runtime returned invalid resource state.");
  }
  const resources = value.resources.map((entry): ResourceStatusItem => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>).name !== "string" ||
      !["started", "stopped"].includes(String((entry as Record<string, unknown>).state))
    ) {
      throw new Error("The bundled runtime returned an invalid resource entry.");
    }
    const item = entry as Record<string, unknown>;
    return { name: item.name as string, state: item.state as ResourceStatusItem["state"] };
  });
  return { resources, serverStateAvailable: value.serverStateAvailable };
}

async function readRuntimeIdentity(activeClient: Client): Promise<RuntimeIdentity | null> {
  try {
    const result = await activeClient.callTool({ name: "get_runtime_identity", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find((block) => block.type === "text")?.text;
    if (!text || result.isError) return null;
    const parsed = JSON.parse(text) as RuntimeIdentity;
    const serverData = parsed?.runtime?.serverData;
    const txAdmin = parsed?.runtime?.txAdmin;
    const rcon = parsed?.runtime?.rcon;
    if (
      !parsed ||
      parsed.contractVersion !== "3" ||
      typeof parsed.mcp?.name !== "string" ||
      typeof parsed.mcp?.version !== "string" ||
      !serverData ||
      typeof serverData.workspacePath !== "string" ||
      !path.isAbsolute(serverData.workspacePath) ||
      typeof serverData.configPath !== "string" ||
      !path.isAbsolute(serverData.configPath) ||
      !txAdmin ||
      (txAdmin.dataDirectory !== null && typeof txAdmin.dataDirectory !== "string") ||
      (txAdmin.controlProfile !== null && typeof txAdmin.controlProfile !== "string") ||
      !rcon ||
      typeof rcon.host !== "string" ||
      !rcon.host ||
      !Number.isInteger(rcon.port) ||
      rcon.port < 1 ||
      rcon.port > 65535 ||
      typeof rcon.configured !== "boolean" ||
      typeof parsed.capabilities?.console !== "boolean" ||
      typeof parsed.capabilities?.resourceLifecycle !== "boolean"
    ) {
      return null;
    }
    return parsed;
  } catch {
    // Connection remains useful for read-only diagnostics. Mutations stay
    // blocked until an identity can be verified.
    return null;
  }
}

function runtimeWorkspaceMatch(identity: RuntimeIdentity | null): RuntimeWorkspaceMatch {
  if (!identity) {
    return { ok: false, reason: "The MCP server did not provide a compatible runtime identity." };
  }

  const config = loadConfig();
  if (!config.txDataPath || !config.selectedProfile) {
    return { ok: false, reason: "No local server-data workspace is selected in QB Studio." };
  }

  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const selectedWorkspace = path.resolve(config.txDataPath, config.selectedProfile);
  const selectedConfigPath = path.join(selectedWorkspace, "server.cfg");
  if (normalize(selectedWorkspace) !== normalize(identity.runtime.serverData.workspacePath)) {
    return {
      ok: false,
      reason:
        `QB Studio is editing ${selectedWorkspace}, but the runtime controls ` +
        `${identity.runtime.serverData.workspacePath}.`,
    };
  }

  if (normalize(selectedConfigPath) !== normalize(identity.runtime.serverData.configPath)) {
    return {
      ok: false,
      reason:
        `QB Studio expects ${selectedConfigPath}, but the runtime identifies ` +
        `${identity.runtime.serverData.configPath} as its server.cfg.`,
    };
  }

  if (!managedServerIdentity) {
    return { ok: false, reason: "No managed local-server identity is available to verify the runtime RCON endpoint." };
  }

  if (
    normalize(selectedWorkspace) !== normalize(managedServerIdentity.workspacePath) ||
    normalize(selectedConfigPath) !== normalize(managedServerIdentity.serverConfigPath)
  ) {
    return { ok: false, reason: "The selected workspace changed after the managed runtime was started. Reconnect the coding runtime." };
  }

  const normalizeHost = (value: string) => value.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalizeHost(identity.runtime.rcon.host) !== normalizeHost(managedServerIdentity.rcon.host) ||
    identity.runtime.rcon.port !== managedServerIdentity.rcon.port
  ) {
    return {
      ok: false,
      reason:
        `The runtime RCON endpoint ${identity.runtime.rcon.host}:${identity.runtime.rcon.port} does not match ` +
        `the selected server's ${managedServerIdentity.rcon.host}:${managedServerIdentity.rcon.port}.`,
    };
  }

  return { ok: true };
}
