// Any OpenAI-compatible chat-completions endpoint.
//
// This one class covers most of the ecosystem, because nearly everyone exposes
// an OpenAI-shaped API: local runtimes (Ollama, LM Studio, llama.cpp, vLLM) and
// hosted providers alike (Google Gemini via its OpenAI-compat layer, Groq,
// OpenRouter, Mistral, DeepSeek, Together, OpenAI itself). Adding a provider is
// therefore usually just a base URL and a model name, not new code.
//
// Caveat this provider can't paper over: the agent is entirely tool-driven, and
// tool-calling quality varies a lot — especially among smaller local models. A
// model without solid tool support will connect fine and then just answer in
// prose, never calling anything. Settings flags that.

import OpenAI from "openai";

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

export interface OpenAIProviderOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Strict servers answer an unrecognized request field with a 400 or 422. */
function rejectsUnknownField(err: unknown): boolean {
  return err instanceof OpenAI.APIError && (err.status === 400 || err.status === 422);
}

function describeUsage(usage: OpenAI.CompletionUsage): TurnUsage {
  const promptTokens = usage.prompt_tokens ?? 0;
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    // Unlike Anthropic, prompt_tokens here is inclusive of the cached tokens.
    // Subtracting keeps inputTokens meaning "billed at full rate" on both
    // providers, so the panel isn't double-counting cache hits on this one.
    inputTokens: Math.max(0, promptTokens - cacheReadTokens),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens,
    // No cache-write accounting in the OpenAI response shape.
    cacheWriteTokens: 0,
    contextTokens: promptTokens,
    // The window size and the per-token price depend on which server is behind
    // this URL, and neither is discoverable from a chat-completions response —
    // so the panel shows raw counts here instead of a percentage or a cost.
  };
}

/**
 * Asks the endpoint what models it serves. Every OpenAI-compatible server
 * implements GET /models, so this works for hosted providers and local runtimes
 * alike — no need to hardcode (and then out-date) model names per provider.
 */
/**
 * Ollama's own API reports per-model capabilities, which the OpenAI-compatible
 * /models endpoint doesn't expose. Since this agent is useless with a model that
 * can't call tools, surface that up front rather than letting the user find out
 * when the model cheerfully chats instead of doing anything.
 *
 * Best effort: any failure just yields no annotations.
 */
async function probeOllamaToolSupport(baseUrl: string, models: string[]): Promise<Record<string, boolean> | undefined> {
  // /v1 is the OpenAI-compat prefix; /api/show lives at the server root.
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!/localhost|127\.0\.0\.1/.test(root)) return undefined;

  try {
    const entries = await Promise.all(
      models.map(async (model) => {
        try {
          const res = await fetch(`${root}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return null;
          const body = (await res.json()) as { capabilities?: string[] };
          if (!Array.isArray(body.capabilities)) return null;
          return [model, body.capabilities.includes("tools")] as const;
        } catch {
          return null;
        }
      }),
    );
    const known = entries.filter((e): e is readonly [string, boolean] => e !== null);
    return known.length > 0 ? Object.fromEntries(known) : undefined;
  } catch {
    return undefined;
  }
}

export async function listModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; models?: string[]; toolCapable?: Record<string, boolean>; error?: string }> {
  if (!baseUrl.trim()) return { ok: false, error: "No server URL set." };
  try {
    const client = new OpenAI({ baseURL: baseUrl, apiKey: apiKey || "local" });
    const page = await client.models.list();
    const models = page.data
      // Gemini's /models lists ids as "models/gemini-3.7-flash", but its
      // chat-completions endpoint rejects that form and wants the bare id.
      // Normalize here, at the point the id enters the app.
      .map((m) => m.id.replace(/^models\//, ""))
      .sort((a, b) => a.localeCompare(b));
    if (models.length === 0) return { ok: false, error: "The server returned no models." };

    return { ok: true, models, toolCapable: await probeOllamaToolSupport(baseUrl, models) };
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) return { ok: false, error: "The provider rejected the API key." };
    if (err instanceof OpenAI.APIConnectionError) return { ok: false, error: `Could not reach ${baseUrl}.` };
    if (err instanceof OpenAI.APIError) return { ok: false, error: `${err.status}: ${err.message}` };
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

export class OpenAICompatibleProvider implements ChatProvider {
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private cancelled = false;
  private controller: AbortController | null = null;
  /** Set once a server has rejected stream_options, so we stop re-sending it. */
  private usageStreamUnsupported = false;

  private options: OpenAIProviderOptions;

  constructor(options: OpenAIProviderOptions) {
    this.options = {
      ...options,
      // Same "models/" normalization as listModels, applied again here so a
      // config already saved with the prefixed form heals itself instead of
      // failing every turn until someone re-picks the model.
      model: options.model.replace(/^models\//, ""),
    };
  }

  reset(): void {
    this.history = [];
  }

  cancel(): void {
    this.cancelled = true;
    this.controller?.abort();
  }

  async runTurn(userMessage: string, emit: Emit): Promise<void> {
    if (!this.options.baseUrl.trim()) {
      emit({ type: "error", message: "No model server URL set — pick a provider in Settings." });
      return;
    }
    if (!this.options.model.trim()) {
      emit({ type: "error", message: "No model name set — add one in Settings." });
      return;
    }

    this.cancelled = false;
    const client = new OpenAI({
      baseURL: this.options.baseUrl,
      // Local servers ignore this, but the SDK requires something non-empty.
      apiKey: this.options.apiKey || "local",
    });

    const tools: OpenAI.Chat.ChatCompletionTool[] = allToolDefinitions().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    if (this.history.length === 0) {
      this.history.push({ role: "system", content: SYSTEM_PROMPT });
    }
    this.history.push({ role: "user", content: userMessage });

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (this.cancelled) return;

        this.controller = new AbortController();
        const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model: this.options.model,
          messages: this.history,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          // Ollama's OpenAI-compatible endpoint does NOT inherit the
          // Modelfile's temperature: omitting it yields 1.0, verified by
          // seed-matched comparison against /api/chat. On this coder,
          // measured scores were 140/160 at 0.4 versus 118/160 at 0.7, so
          // the default was actively harmful. top_k and repeat_penalty are
          // not OpenAI fields and do still come from the Modelfile.
          temperature: 0.4,
          top_p: 0.8,
        };
        // A streaming response carries no token counts unless asked. Support is
        // not universal across OpenAI-compatible servers, so a rejection
        // downgrades this connection permanently and retries — losing the token
        // readout is acceptable, failing the whole turn over it is not.
        if (!this.usageStreamUnsupported) body.stream_options = { include_usage: true };

        let stream;
        try {
          stream = await client.chat.completions.create(body, { signal: this.controller.signal });
        } catch (err) {
          if (this.cancelled || this.usageStreamUnsupported || !rejectsUnknownField(err)) throw err;
          this.usageStreamUnsupported = true;
          delete body.stream_options;
          stream = await client.chat.completions.create(body, { signal: this.controller.signal });
        }

        // Tool calls arrive as deltas keyed by index, with name and arguments
        // streamed in pieces — accumulate before we can act on any of them.
        let text = "";
        let usage: OpenAI.CompletionUsage | undefined;
        const partialCalls = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();

        for await (const chunk of stream) {
          if (this.cancelled) return;
          // The usage chunk comes last and has an empty choices array, so it
          // has to be read before the delta guard below skips it.
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            text += delta.content;
            emit({ type: "text", text: delta.content });
          }

          for (const call of delta.tool_calls ?? []) {
            const existing = partialCalls.get(call.index) ?? { id: "", name: "", args: "" };
            // Providers may hang extra per-call metadata off the tool call that
            // isn't part of the OpenAI schema, and that must be echoed back
            // verbatim on the next turn. Gemini's thinking models do exactly
            // this with extra_content.google.thought_signature, and dropping it
            // (which a plain OpenAI client does) makes the *next* request fail
            // with a 400 — so carry through whatever we're handed.
            const extra = (call as { extra_content?: unknown }).extra_content;
            partialCalls.set(call.index, {
              id: call.id ?? existing.id,
              name: call.function?.name ?? existing.name,
              args: existing.args + (call.function?.arguments ?? ""),
              extra: extra ?? existing.extra,
            });
          }
        }
        this.controller = null;
        if (usage) emit({ type: "usage", usage: describeUsage(usage) });
        if (this.cancelled) return;

        const calls = [...partialCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, c], n) => ({
            // Some local servers omit tool-call ids; the id only has to be
            // consistent between our request and the follow-up result.
            id: c.id || `call_${i}_${index}_${n}`,
            name: c.name,
            args: c.args,
            extra: c.extra,
          }))
          .filter((c) => c.name);

        this.history.push({
          role: "assistant",
          content: text || null,
          ...(calls.length > 0 && {
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.args || "{}" },
              // Cast: extra_content isn't in the OpenAI schema, but it has to go
              // back on the wire untouched for providers that sent it (see above).
              ...(c.extra ? { extra_content: c.extra } : {}),
            })),
          }),
        } as OpenAI.Chat.ChatCompletionMessageParam);

        if (calls.length === 0) return;

        for (const call of calls) {
          const { content } = await runToolCall(emit, call.id, call.name, parseToolArguments(call.args));
          if (this.cancelled) return;
          // The OpenAI format wants one tool message per call, each keyed by id —
          // unlike Anthropic, where all results share a single user message.
          this.history.push({ role: "tool", tool_call_id: call.id, content });
        }
      }
    } catch (err) {
      if (!this.cancelled) emit({ type: "error", message: this.describeError(err) });
    } finally {
      this.controller = null;
    }
  }

  private describeError(err: unknown): string {
    const isLocal = /localhost|127\.0\.0\.1/.test(this.options.baseUrl);
    if (err instanceof OpenAI.APIConnectionError) {
      return isLocal
        ? `Could not reach the model server at ${this.options.baseUrl}. Is it running? (For Ollama: \`ollama serve\`.)`
        : `Could not reach ${this.options.baseUrl} — check the URL and your network connection.`;
    }
    if (err instanceof OpenAI.AuthenticationError) {
      return "The provider rejected the API key — check it in Settings.";
    }
    if (err instanceof OpenAI.NotFoundError) {
      return isLocal
        ? `The server has no model named "${this.options.model}". (For Ollama: \`ollama pull ${this.options.model}\`.)`
        : `No model named "${this.options.model}" at this provider — check the model name in Settings.`;
    }
    if (err instanceof OpenAI.RateLimitError) {
      return "Rate limited by the provider — free tiers cap requests per minute/day. Wait a moment and retry.";
    }
    if (err instanceof OpenAI.APIError) {
      return `Model server error ${err.status}: ${err.message}`;
    }
    return (err as Error).message ?? String(err);
  }
}
