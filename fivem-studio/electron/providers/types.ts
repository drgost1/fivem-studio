// Shared surface between the two chat backends (hosted Claude, and any
// OpenAI-compatible endpoint such as a local Ollama / LM Studio server).
//
// Each provider owns its own conversation history in its own native format
// rather than sharing a neutral message type. That's deliberate: Anthropic
// requires thinking blocks to be echoed back unchanged on the next turn, and
// the OpenAI format has its own tool_call_id round-trip semantics — a unified
// message shape would leak one provider's rules into the other.

import { mcpCallTool, mcpToolDefinitions, type McpToolDefinition } from "../mcpClient";
import { PROJECT_TOOL_NAMES, projectToolDefinitions, runProjectTool } from "../projectTools";
import { redactCredentialText } from "../revertStore";
import {
  requestToolApproval,
  type ToolApprovalRequestEvent,
  type ToolApprovalResolvedEvent,
} from "../toolApproval";

/**
 * Token accounting for one API response — not one user turn. A turn that calls
 * tools makes several requests, so the panel sums these as they arrive.
 *
 * `inputTokens` means the same thing for both providers: prompt tokens billed
 * at full rate, with cache hits excluded. The two APIs disagree on that (see
 * the OpenAI provider), so it's normalized here rather than in the UI.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from cache — roughly a tenth of the input price. */
  cacheReadTokens: number;
  /** Prompt tokens written into the cache — roughly 1.25x the input price. */
  cacheWriteTokens: number;
  /**
   * Everything the model saw on this request. A level, not a total: the panel
   * replaces it each time rather than accumulating, since resending history is
   * what makes the number grow.
   */
  contextTokens: number;
  /** Omitted when the window isn't knowable — any OpenAI-compatible endpoint. */
  contextWindow?: number;
  /** Omitted when per-token pricing isn't known, e.g. a local model. */
  costUsd?: number;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | ToolApprovalRequestEvent
  | ToolApprovalResolvedEvent
  | { type: "usage"; usage: TurnUsage }
  | { type: "done" }
  | { type: "error"; message: string };

export type Emit = (event: AgentEvent) => void;

export interface ChatProvider {
  /** Runs one user turn to completion, including any tool round-trips. */
  runTurn(userMessage: string, emit: Emit): Promise<void>;
  /** Clears conversation history. */
  reset(): void;
  /** Aborts an in-flight turn. */
  cancel(): void;
}

/** Stops a misbehaving loop from billing (or spinning) forever; a normal turn uses a handful. */
export const MAX_ITERATIONS = 25;

export const SYSTEM_PROMPT = `You are the agent built into FiveM Studio, a desktop IDE for local Cfx.re server-resource development.

You have coding-oriented access to the developer's own local Cfx.re dev server (FiveM or RedM) through your tools: read recent console output, inspect resource status, and start, stop, or restart resources after approval.

You can also read, search, and edit the developer's actual resource code: list_project_files, read_project_file, search_project, write_project_file, and get_editor_context (the file they have open and any text they've highlighted).

How to work:
- This is the developer's own machine and local dev server. Use available project and resource tools when they help verify a coding change.
- Read real state (console output, resource status, and actual file contents) instead of guessing.
- To find where something lives, use search_project rather than asking the developer.
- Always read an existing file before writing it, preserve everything you weren't asked to change, and pass the exact revision returned by read_project_file. Use expected_revision="new" only to create a path that does not exist.
- Read-only tools run immediately. File writes and runtime mutations require the developer's explicit approval in FiveM Studio; if approval is denied, respect that decision and continue without retrying the same mutation.
- Credential-bearing files are intentionally withheld and console/editor text is redacted before you receive it. Never ask the developer to bypass that boundary or paste a secret into chat.
- After editing a resource, offer to restart that resource and verify the change through console output when appropriate.
- When something fails, read the console before theorizing about why.
- Be concise. Report what you did and what the tools actually returned, not what you expect they would return.

Writing Cfx.re Lua:
- Determine the resource's game target from its existing fxmanifest.lua and server.cfg before making game-specific changes. FiveM uses gta5; RedM uses rdr3. Preserve multi-game manifests unless the developer asks to narrow them.
- Treat every client-supplied value as hostile. Validate server-side.
- Pass values to SQL as ? placeholders in the parameter table. Never concatenate them into the query string.
- Make a balance change safe by putting the sufficient-funds test in the UPDATE's own WHERE clause, or by using a transaction, so the check and the write cannot separate. The same applies to inventory.
- Notify both parties with TriggerClientEvent.
- Always include fxmanifest.lua with a server_scripts block.
- Never invent natives or APIs.
- This is plain Lua, not Luau. Never write type annotations, \`type\` aliases, or \`::\` assertions here; they are a parse error in Cfx.re Lua.`;

/**
 * Runs one tool call and emits the matching transcript events. Shared by both
 * providers so a tool call renders identically in the UI regardless of which
 * model asked for it.
 */
/** MCP tools that support the coding workflow surfaced by FiveM Studio. */
const AGENT_MCP_TOOLS = new Set([
  "get_runtime_identity",
  "get_console_output",
  "list_resources",
  "start_resource",
  "stop_resource",
  "restart_resource",
]);

/** Everything the model can call: approved coding-oriented MCP tools and project file tools. */
export function allToolDefinitions(): McpToolDefinition[] {
  return [
    ...mcpToolDefinitions().filter((tool) => AGENT_MCP_TOOLS.has(tool.name)),
    ...projectToolDefinitions(),
  ];
}

export async function runToolCall(
  emit: Emit,
  id: string,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  emit({ type: "tool_use", id, name, input });

  if (!PROJECT_TOOL_NAMES.has(name) && !AGENT_MCP_TOOLS.has(name)) {
    const content = `${name} is not available in FiveM Studio.`;
    emit({ type: "tool_result", id, name, content, isError: true });
    return { content, isError: true };
  }

  const approved = await requestToolApproval(id, name, input, emit);
  if (!approved) {
    const content = `The developer did not approve ${name}; no mutation was performed.`;
    emit({ type: "tool_result", id, name, content, isError: true });
    return { content, isError: true };
  }

  let content: string;
  let isError = false;
  try {
    // Project tools run here in the main process; everything else is an MCP
    // tool and goes out to the bundled loopback runtime.
    content = PROJECT_TOOL_NAMES.has(name)
      ? (await runProjectTool(name, input)) || "(no output)"
      : (await mcpCallTool(name, input)) || "(no output)";
    if (name === "get_console_output") content = redactCredentialText(content);
  } catch (err) {
    content = name === "get_console_output"
      ? redactCredentialText((err as Error).message)
      : (err as Error).message;
    isError = true;
  }

  emit({ type: "tool_result", id, name, content, isError });
  return { content, isError };
}

/** Tolerant parse for model-produced JSON tool arguments — never raw-string-match these. */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
