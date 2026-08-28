import { useEffect, useRef, useState } from "react";
import type { AgentEvent, RuntimeWorkspaceMatch, StudioConfig, TurnUsage } from "../global";
import { matchPreset } from "../providerPresets";

/**
 * A transcript entry. Tool calls get their own entries rather than being folded
 * into the assistant's text, so it's always visible what the agent actually ran
 * against the live server versus what it merely said.
 */
type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      approvalId?: string;
      approvalRisk?: "write" | "dangerous";
      approvalSummary?: string;
      approvalStatus?: "pending" | "responding" | "approved" | "denied";
      approvalReason?: string;
    }
  | { kind: "error"; text: string };

/** Conversation-wide totals, built up from the per-response usage events. */
interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  contextTokens: number;
  contextWindow?: number;
  /** API requests so far — a tool-heavy turn makes many. */
  requests: number;
}

const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  contextTokens: 0,
  requests: 0,
};

function accumulate(prev: SessionUsage | null, turn: TurnUsage): SessionUsage {
  const base = prev ?? EMPTY_USAGE;
  return {
    inputTokens: base.inputTokens + turn.inputTokens,
    outputTokens: base.outputTokens + turn.outputTokens,
    cacheReadTokens: base.cacheReadTokens + turn.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + turn.cacheWriteTokens,
    costUsd: base.costUsd + (turn.costUsd ?? 0),
    // Context is how big the last request was, not a running sum — the
    // conversation is resent whole every time, so summing would multiply it.
    contextTokens: turn.contextTokens,
    contextWindow: turn.contextWindow ?? base.contextWindow,
    requests: base.requests + 1,
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Sub-cent totals round to $0.00, which reads as free rather than as small. */
function formatCost(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object" || Object.keys(input).length === 0) return "";
  const text = JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

interface ChatPanelProps {
  connected: boolean;
  config: StudioConfig;
  workspaceMatch: RuntimeWorkspaceMatch | null;
  /** Live editor selection, if any — shown as a chip so it's never a surprise what gets sent. */
  selection: { path: string | null; selectedText: string; startLine: number; endLine: number } | null;
}

export default function ChatPanel({ connected, config, workspaceMatch, selection }: ChatPanelProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isAnthropic = config.agentProvider === "anthropic";
  const preset = matchPreset(config.agentProvider, config.openaiBaseUrl);
  const backendLabel = isAnthropic ? "Claude" : `${config.openaiModel || "?"} via ${preset.label}`;

  // A purely local backend needs no credential, so readiness differs by provider.
  useEffect(() => {
    if (isAnthropic) {
      window.api.agent.hasApiKey().then(setReady);
      return;
    }
    const configured = Boolean(config.openaiBaseUrl && config.openaiModel);
    if (!configured || !preset.needsKey) {
      setReady(configured);
      return;
    }
    window.api.agent.hasProviderKey(config.openaiBaseUrl).then((has) => setReady(configured && has));
  }, [isAnthropic, config.openaiBaseUrl, config.openaiModel, preset.needsKey]);

  useEffect(() => {
    return window.api.agent.onEvent((event: AgentEvent) => {
      // Usage is a running tally rather than a transcript entry, so it's kept
      // out of the entries list entirely.
      if (event.type === "usage") {
        setUsage((prev) => accumulate(prev, event.usage));
        return;
      }
      setEntries((prev) => applyEvent(prev, event));
      if (event.type === "done") setBusy(false);
    });
  }, []);

  // Keep the newest output in view as it streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  function applyEvent(prev: Entry[], event: AgentEvent): Entry[] {
    switch (event.type) {
      case "text":
      case "thinking": {
        const kind = event.type === "text" ? "assistant" : "thinking";
        const last = prev[prev.length - 1];
        // Append to the in-progress block rather than making an entry per delta.
        if (last?.kind === kind) {
          return [...prev.slice(0, -1), { ...last, text: last.text + event.text }];
        }
        return [...prev, { kind, text: event.text } as Entry];
      }
      case "tool_use":
        return [...prev, { kind: "tool", id: event.id, name: event.name, input: event.input }];
      case "tool_result":
        return prev.map((e) =>
          e.kind === "tool" && e.id === event.id ? { ...e, result: event.content, isError: event.isError } : e,
        );
      case "approval_request":
        return prev.map((entry) =>
          entry.kind === "tool" && entry.id === event.toolCallId
            ? {
                ...entry,
                approvalId: event.approvalId,
                approvalRisk: event.risk,
                approvalSummary: event.summary,
                approvalStatus: "pending",
              }
            : entry,
        );
      case "approval_resolved":
        return prev.map((entry) =>
          entry.kind === "tool" && entry.approvalId === event.approvalId
            ? {
                ...entry,
                approvalStatus: event.approved ? "approved" : "denied",
                approvalReason: event.reason,
              }
            : entry,
        );
      case "error":
        return [...prev, { kind: "error", text: event.message }];
      default:
        return prev;
    }
  }

  async function respondToApproval(approvalId: string, approved: boolean) {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.kind === "tool" && entry.approvalId === approvalId ? { ...entry, approvalStatus: "responding" } : entry,
      ),
    );
    try {
      await window.api.agent.respondToApproval(approvalId, approved);
    } catch (err) {
      setEntries((prev) => [
        ...prev.map((entry) =>
          entry.kind === "tool" && entry.approvalId === approvalId ? { ...entry, approvalStatus: "pending" as const } : entry,
        ),
        { kind: "error", text: (err as Error).message || "Could not answer the approval request." },
      ]);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setEntries((prev) => [...prev, { kind: "user", text }]);
    setDraft("");
    setBusy(true);
    try {
      await window.api.agent.send(text);
    } catch (err) {
      setEntries((prev) => [...prev, { kind: "error", text: (err as Error).message || "Could not send the message." }]);
      setBusy(false);
    }
  }

  async function newChat() {
    try {
      await window.api.agent.reset();
      setEntries([]);
      setUsage(null);
    } catch (err) {
      setEntries((prev) => [...prev, { kind: "error", text: (err as Error).message || "Could not start a new chat." }]);
    }
  }

  return (
    <div className="pane" style={{ height: "100%" }}>
      <div className="pane-header">
        <span>Agent Chat</span>
        <div style={{ flex: 1 }} />
        {entries.length > 0 && (
          <button className="btn small" onClick={newChat} disabled={busy}>
            New chat
          </button>
        )}
      </div>

      {/* Held back until a turn finishes, so a streaming first reply doesn't
          flash "didn't report" before its usage chunk arrives at the end. */}
      {(usage || (entries.length > 0 && !busy)) && <UsageBar usage={usage} />}

      <div className="chat-messages" ref={scrollRef}>
        {ready === false && (
          <div className="chat-message system">
            {isAnthropic
              ? "No Anthropic API key yet — add one in Settings, or switch to a provider with a free tier."
              : `${preset.label} isn't configured yet — finish setting it up in Settings.`}
          </div>
        )}
        {ready && !connected && (
          <div className="chat-message system">
            The bundled coding runtime is unavailable. Project-file tools remain available.
          </div>
        )}
        {ready && connected && workspaceMatch && !workspaceMatch.ok && (
          <div className="chat-message system">
            Resource lifecycle changes are unavailable because the workspace and local runtime do not match. Project tools and console output still work.
          </div>
        )}
        {entries.length === 0 && ready && connected && (
          <div className="chat-message system">
            Using <strong>{backendLabel}</strong>. Ask the agent to inspect code, check recent console output, or restart a
            resource after an approved change.
          </div>
        )}

        {entries.map((entry, i) => {
          if (entry.kind === "tool") {
            return (
              <div key={i} className={`tool-call ${entry.isError ? "error" : ""}`}>
                <div className="tool-call-head">
                  <span className="tool-call-name">{entry.name}</span>
                  <span className="tool-call-args">{summarizeInput(entry.input)}</span>
                  {entry.result === undefined && <span className="tool-call-status">running…</span>}
                </div>
                {entry.approvalId && (
                  <div className={`tool-approval ${entry.approvalRisk === "dangerous" ? "dangerous" : "write"}`}>
                    <div className="tool-approval-summary">
                      <strong>{entry.approvalRisk === "dangerous" ? "Dangerous action" : "Review change"}</strong>
                      <span>{entry.approvalSummary}</span>
                    </div>
                    <details>
                      <summary>Inspect arguments</summary>
                      <pre>{JSON.stringify(entry.input, null, 2)}</pre>
                    </details>
                    {entry.approvalStatus === "pending" ? (
                      <div className="tool-approval-actions">
                        <button className="btn small primary" onClick={() => void respondToApproval(entry.approvalId!, true)}>
                          Approve once
                        </button>
                        <button className="btn small" onClick={() => void respondToApproval(entry.approvalId!, false)}>
                          Deny
                        </button>
                      </div>
                    ) : entry.approvalStatus === "responding" ? (
                      <div className="tool-approval-state">Recording decision…</div>
                    ) : (
                      <div className={`tool-approval-state ${entry.approvalStatus}`}>
                        {entry.approvalStatus === "approved" ? "Approved once" : entry.approvalReason ?? "Denied"}
                      </div>
                    )}
                  </div>
                )}
                {entry.result !== undefined && <pre className="tool-call-result">{entry.result}</pre>}
              </div>
            );
          }
          if (entry.kind === "error") {
            return (
              <div key={i} className="chat-message error">
                {entry.text}
              </div>
            );
          }
          return (
            <div key={i} className={`chat-message ${entry.kind}`}>
              {entry.text}
            </div>
          );
        })}

        {busy && (
          <div className="chat-working">
            {entries.some((entry) => entry.kind === "tool" && entry.approvalStatus === "pending")
              ? "Waiting for your approval…"
              : "Working…"}
          </div>
        )}
      </div>

      {selection && (
        <div className="selection-chip">
          <span className="icon">✎</span>
          <span>
            {selection.path?.split(/[/\\]/).pop() ?? "selection"} · lines {selection.startLine}–{selection.endLine} will
            be included
          </span>
        </div>
      )}

      <div className="chat-input-row">
        <textarea
          rows={2}
          value={draft}
          placeholder={ready === false ? "Configure a model backend in Settings first…" : "Ask your agent to do something…"}
          disabled={ready === false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button
            className="btn"
            onClick={() => {
              void window.api.agent.cancel().catch((err) => {
                setEntries((prev) => [...prev, { kind: "error", text: (err as Error).message || "Could not stop the agent." }]);
                setBusy(false);
              });
            }}
          >
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={send} disabled={ready === false || !draft.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Token and cost readout for the conversation so far. The context meter only
 * appears when the backend actually reported a window size — an arbitrary
 * OpenAI-compatible endpoint doesn't, and a guessed denominator would be worse
 * than none.
 *
 * A null `usage` after a completed turn means the backend never sent token
 * counts at all. That says so explicitly rather than rendering nothing, so the
 * difference between "this server is silent" and "the feature is broken" is
 * visible instead of being something you have to go read the code to find out.
 */
function UsageBar({ usage }: { usage: SessionUsage | null }) {
  if (!usage) {
    return (
      <div className="usage-bar">
        <div className="usage-row">
          <span className="usage-muted">This model backend didn&rsquo;t report token usage.</span>
        </div>
      </div>
    );
  }

  const cacheTotal = usage.cacheReadTokens + usage.cacheWriteTokens;
  const pct = usage.contextWindow ? Math.min(100, (usage.contextTokens / usage.contextWindow) * 100) : null;
  const level = pct === null ? "" : pct >= 90 ? "critical" : pct >= 70 ? "warn" : "ok";

  return (
    <div className="usage-bar">
      <div className="usage-row">
        <span className="usage-stat" title="Prompt tokens billed at full rate (cache hits excluded)">
          <span className="usage-arrow">↑</span>
          {formatTokens(usage.inputTokens)}
        </span>
        <span className="usage-stat" title="Tokens the model generated, including reasoning">
          <span className="usage-arrow">↓</span>
          {formatTokens(usage.outputTokens)}
        </span>
        {cacheTotal > 0 && (
          <span
            className="usage-stat"
            title={`${usage.cacheReadTokens.toLocaleString()} read from cache, ${usage.cacheWriteTokens.toLocaleString()} written to it`}
          >
            <span className="usage-key">cache</span>
            {formatTokens(cacheTotal)}
          </span>
        )}
        <span className="usage-spacer" />
        <span className="usage-stat" title={`${usage.requests} API request${usage.requests === 1 ? "" : "s"} this conversation`}>
          <span className="usage-key">reqs</span>
          {usage.requests}
        </span>
        {usage.costUsd > 0 && (
          <span className="usage-cost" title="Estimated from list pricing for this conversation">
            {formatCost(usage.costUsd)}
          </span>
        )}
      </div>

      {pct === null ? (
        <div className="usage-context">
          <span>{usage.contextTokens.toLocaleString()} tokens in context</span>
        </div>
      ) : (
        <div
          className="usage-context"
          title={`${usage.contextTokens.toLocaleString()} of ${usage.contextWindow!.toLocaleString()} tokens used in the context window`}
        >
          <div className="usage-track">
            <div className={`usage-fill ${level}`} style={{ width: `${pct}%` }} />
          </div>
          <span>
            {formatTokens(usage.contextTokens)} / {formatTokens(usage.contextWindow!)} · {pct.toFixed(0)}%
          </span>
        </div>
      )}
    </div>
  );
}
