// Orchestrates Studio's chat panel: owns the running/cancel state and picks
// which backend answers. The actual model loops live in providers/.
//
// Runs main-process-only — credentials never cross into the renderer, and the
// MCP client whose tools the agent drives already lives here.

import type { BrowserWindow } from "electron";
import { createHash } from "node:crypto";

import { loadConfig, loadProviderKey } from "./configStore";
import { mcpIsConnected } from "./mcpClient";
import { getEditorContext } from "./projectTools";
import { cancelPendingToolApprovals } from "./toolApproval";
import { AnthropicProvider } from "./providers/anthropicProvider";
import { OpenAICompatibleProvider, listModels } from "./providers/openaiProvider";
import type { AgentEvent, ChatProvider } from "./providers/types";

export type { AgentEvent } from "./providers/types";

/**
 * Lists models for an endpoint. `keyOverride` lets Settings use a key the user
 * has just typed but not saved yet, so "paste key → Load models" works in one go.
 */
export function listAvailableModels(baseUrl: string, keyOverride?: string) {
  return listModels(baseUrl, keyOverride || loadProviderKey(baseUrl));
}

let provider: ChatProvider | null = null;
let providerKey = "";
let running = false;

/**
 * Providers are rebuilt when the relevant settings change — and since each owns
 * its own history, that also means switching provider or model starts a fresh
 * conversation rather than replaying one model's transcript into another.
 */
function getProvider(): ChatProvider {
  const config = loadConfig();

  if (config.agentProvider === "openai") {
    const apiKey = loadProviderKey(config.openaiBaseUrl);
    // Do not collapse every non-empty credential into one cache key: replacing
    // a key must rebuild the client/history. Store only a fingerprint here.
    const keyFingerprint = apiKey ? createHash("sha256").update(apiKey).digest("hex") : "open";
    const key = `openai:${config.openaiBaseUrl}:${config.openaiModel}:${keyFingerprint}`;
    if (!provider || providerKey !== key) {
      provider = new OpenAICompatibleProvider({
        baseUrl: config.openaiBaseUrl,
        model: config.openaiModel,
        apiKey,
      });
      providerKey = key;
    }
    return provider;
  }

  if (!provider || providerKey !== "anthropic") {
    provider = new AnthropicProvider();
    providerKey = "anthropic";
  }
  return provider;
}

export function resetConversation(): void {
  cancelPendingToolApprovals("The conversation was reset.");
  if (running) provider?.cancel();
  provider?.reset();
}

export function cancelTurn(): void {
  cancelPendingToolApprovals();
  provider?.cancel();
}

export function isRunning(): boolean {
  return running;
}

function emit(win: BrowserWindow, event: AgentEvent): void {
  if (!win.isDestroyed()) win.webContents.send("agent:event", event);
}

export async function sendMessage(win: BrowserWindow, userMessage: string): Promise<void> {
  if (running) {
    emit(win, { type: "error", message: "The agent is already working on a message." });
    return;
  }

  running = true;
  try {
    // Not a hard stop any more: without MCP the agent loses the server tools but
    // keeps the project file tools, so it can still read and edit code.
    if (!mcpIsConnected()) {
      emit(win, {
        type: "error",
        message:
          "The bundled coding runtime is unavailable — the agent can still read and edit project files, but cannot read logs or reload resources.",
      });
    }

    // A live selection is prepended as context so "look at my highlighted code"
    // works without the model having to know to go ask for it.
    const editor = getEditorContext();
    const prompt = editor.selectedText
      ? `[The user currently has this selected in ${editor.path ?? "the editor"}, lines ${editor.startLine}-${editor.endLine}:\n\n${editor.selectedText}\n]\n\n${userMessage}`
      : userMessage;

    await getProvider().runTurn(prompt, (event) => emit(win, event));
  } finally {
    running = false;
    emit(win, { type: "done" });
  }
}
