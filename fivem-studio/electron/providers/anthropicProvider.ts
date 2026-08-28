// Hosted Claude backend.
//
// Uses a manual streaming loop rather than the SDK's tool runner: the tool set
// is discovered at runtime from the MCP server (so there are no static schemas
// to hand betaZodTool at build time), and the chat UI needs each tool call and
// result surfaced as its own transcript entry as it happens.

import Anthropic from "@anthropic-ai/sdk";

import { loadApiKey } from "../configStore";
import {
  MAX_ITERATIONS,
  SYSTEM_PROMPT,
  allToolDefinitions,
  parseToolArguments,
  runToolCall,
  type ChatProvider,
  type Emit,
  type TurnUsage,
} from "./types";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 32000;
/** claude-opus-5 serves a 1M-token context window. */
const CONTEXT_WINDOW = 1_000_000;
/**
 * claude-opus-5 list price in USD per million tokens. Cache writes bill at
 * 1.25x the input rate and cache reads at 0.1x, so the two cache buckets can't
 * just be folded into the input rate.
 */
const PRICE_PER_MTOK = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

export class AnthropicProvider implements ChatProvider {
  private history: Anthropic.MessageParam[] = [];
  private cancelled = false;
  private activeStream: ReturnType<Anthropic.Messages["stream"]> | null = null;

  reset(): void {
    this.history = [];
  }

  cancel(): void {
    this.cancelled = true;
    this.activeStream?.abort();
  }

  async runTurn(userMessage: string, emit: Emit): Promise<void> {
    const apiKey = loadApiKey();
    if (!apiKey) {
      emit({
        type: "error",
        message: "No Anthropic API key set — add one in Settings, or switch to a provider with a free tier.",
      });
      return;
    }

    this.cancelled = false;
    const client = new Anthropic({ apiKey });
    const tools = allToolDefinitions();

    this.history.push({ role: "user", content: userMessage });

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (this.cancelled) return;

        const stream = client.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          // Agentic tool-driven work is what adaptive thinking is for; a summary
          // keeps the panel from looking frozen while it reasons.
          thinking: { type: "adaptive", display: "summarized" },
          system: SYSTEM_PROMPT,
          tools,
          messages: this.history,
        });
        this.activeStream = stream;

        stream.on("text", (delta) => emit({ type: "text", text: delta }));
        stream.on("thinking", (delta) => emit({ type: "thinking", text: delta }));

        const message = await stream.finalMessage();
        this.activeStream = null;
        // Reported before the cancel check: those tokens were billed whether or
        // not the user is still waiting on the answer.
        emit({ type: "usage", usage: describeUsage(message.usage) });
        if (this.cancelled) return;

        // Push the whole content array, not just text: it carries the thinking
        // blocks that must be echoed back unchanged on the next turn.
        this.history.push({ role: "assistant", content: message.content });

        if (message.stop_reason === "refusal") {
          emit({
            type: "error",
            message: `Claude declined this request${
              message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."
            }`,
          });
          return;
        }

        // A server-side tool hit its own iteration limit — re-send to continue.
        if (message.stop_reason === "pause_turn") continue;

        const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) return;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const call of toolUses) {
          const input =
            typeof call.input === "string"
              ? parseToolArguments(call.input)
              : ((call.input ?? {}) as Record<string, unknown>);
          const { content, isError } = await runToolCall(emit, call.id, call.name, input);
          if (this.cancelled) return;
          results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError });
        }

        // All results for one assistant turn go back in a single user message —
        // splitting them teaches the model to stop calling tools in parallel.
        this.history.push({ role: "user", content: results });
      }
    } catch (err) {
      // abort() from cancel() surfaces here; that's expected, not a failure.
      if (!this.cancelled) emit({ type: "error", message: describeError(err) });
    } finally {
      this.activeStream = null;
    }
  }
}

function describeUsage(usage: Anthropic.Message["usage"]): TurnUsage {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // Anthropic reports the three input buckets as disjoint — input_tokens
    // excludes anything read from or written to cache — so the prompt's real
    // size is their sum, not input_tokens alone.
    contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    contextWindow: CONTEXT_WINDOW,
    costUsd:
      (inputTokens * PRICE_PER_MTOK.input +
        outputTokens * PRICE_PER_MTOK.output +
        cacheWriteTokens * PRICE_PER_MTOK.cacheWrite +
        cacheReadTokens * PRICE_PER_MTOK.cacheRead) /
      1_000_000,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic rejected the credentials — check the API key in Settings.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Anthropic API. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API — check your network connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status}: ${err.message}`;
  }
  return (err as Error).message ?? String(err);
}
