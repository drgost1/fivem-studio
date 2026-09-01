import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";

import type { CfxTarget } from "./configStore";

export const DISCORD_APPLICATION_ID = "1543453950919839754";
export const DISCORD_LARGE_IMAGE_KEY = "qb-studio";
export const DISCORD_ACTIVITY_BUTTONS = [
  { label: "Visit Tufan Studio", url: "https://www.tufanstudio.net" },
  { label: "Download FiveM Studio", url: "https://github.com/drgost1/fivem-studio/releases/latest" },
] as const;

const HANDSHAKE = 0;
const FRAME = 1;
const CLOSE = 2;
const PING = 3;
const PONG = 4;
const MAX_FRAME_BYTES = 1024 * 1024;
const PIPE_COUNT = 10;
const RETRY_MS = 30_000;
// Discord allows five presence updates per 20 seconds. A little headroom avoids
// boundary jitter while still making navigation changes feel prompt.
const MIN_ACTIVITY_UPDATE_MS = 4_200;
const MAX_FILENAME_CHARACTERS = 80;

export const DISCORD_ACTIVITY_VIEWS = [
  "startup",
  "viewport",
  "console",
  "resources",
  "editor",
  "review",
  "assistant",
  "setup",
  "settings",
] as const;

export type DiscordActivityView = (typeof DISCORD_ACTIVITY_VIEWS)[number];

export interface DiscordActivityContext {
  view: DiscordActivityView;
  filename: string | null;
}

export interface DiscordFrame {
  opcode: number;
  payload: Record<string, unknown>;
}

export function encodeDiscordFrame(opcode: number, payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error("Discord RPC frame is too large.");
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

export class DiscordFrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): DiscordFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const output: DiscordFrame[] = [];
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > MAX_FRAME_BYTES) throw new Error("Discord RPC sent an oversized frame.");
      if (this.buffer.length < 8 + length) break;
      const raw = this.buffer.subarray(8, 8 + length).toString("utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Discord RPC payload was invalid.");
      output.push({ opcode, payload: parsed as Record<string, unknown> });
      this.buffer = this.buffer.subarray(8 + length);
    }
    return output;
  }
}

export function discordTargetLabel(target: CfxTarget): string {
  if (target === "legacy") return "FiveM Legacy";
  if (target === "enhanced") return "FiveM Enhanced";
  return "RedM";
}

function truncateFilename(filename: string): string {
  const characters = Array.from(filename);
  if (characters.length <= MAX_FILENAME_CHARACTERS) return filename;
  const extension = path.extname(filename);
  const extensionCharacters = Array.from(extension);
  if (extensionCharacters.length >= MAX_FILENAME_CHARACTERS - 2) {
    return `${characters.slice(0, MAX_FILENAME_CHARACTERS - 1).join("")}…`;
  }
  const stemLength = MAX_FILENAME_CHARACTERS - extensionCharacters.length - 1;
  return `${characters.slice(0, stemLength).join("")}…${extension}`;
}

export function safeDiscordFilename(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32_767) return null;
  const basename = path.posix.basename(value.replace(/\\/g, "/"));
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return truncateFilename(cleaned);
}

export function discordLanguageLabel(filename: string | null): string | null {
  const extension = filename?.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "lua": return "Lua";
    case "js":
    case "cjs":
    case "mjs": return "JavaScript";
    case "ts":
    case "tsx": return "TypeScript";
    case "json": return "JSON";
    case "cfg": return "CFG";
    case "md": return "Markdown";
    case "yml":
    case "yaml": return "YAML";
    case "html": return "HTML";
    case "css": return "CSS";
    case "sql": return "SQL";
    case "xml":
    case "meta": return "XML";
    default: return filename ? "Plain text" : null;
  }
}

export function normalizeDiscordActivityContext(value: unknown): DiscordActivityContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Discord activity context must be an object.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.view !== "string" || !DISCORD_ACTIVITY_VIEWS.includes(candidate.view as DiscordActivityView)) {
    throw new Error("Unsupported Discord activity view.");
  }
  return {
    view: candidate.view as DiscordActivityView,
    filename: candidate.view === "editor" || candidate.view === "review" ? safeDiscordFilename(candidate.filePath) : null,
  };
}

export function discordVersionTooltip(version: string): string {
  const clean = version.trim().replace(/^v/i, "");
  if (!clean || clean === "0.0.0-development") return "FiveM Studio development build";
  return `FiveM Studio v${clean}`;
}

function discordActivityDetails(context: DiscordActivityContext): string {
  switch (context.view) {
    case "viewport": return "Testing in the viewport";
    case "console": return "Monitoring the console";
    case "resources": return "Browsing resources";
    case "editor": return context.filename ? `Editing ${context.filename}` : "Editing code";
    case "review": return context.filename ? `Reviewing ${context.filename}` : "Reviewing changes";
    case "assistant": return "Working with the assistant";
    case "setup": return "Setting up FiveM Studio";
    case "settings": return "Customizing FiveM Studio";
    default: return "Developing with FiveM Studio";
  }
}

export function buildDiscordActivity(
  target: CfxTarget,
  startedAtSeconds: number,
  context: DiscordActivityContext = { view: "startup", filename: null },
  version = "0.0.0-development",
) {
  const language = discordLanguageLabel(context.filename);
  return {
    type: 0,
    details: discordActivityDetails(context),
    state: language ? `${discordTargetLabel(target)} · ${language}` : discordTargetLabel(target),
    timestamps: { start: startedAtSeconds },
    assets: {
      large_image: DISCORD_LARGE_IMAGE_KEY,
      large_text: discordVersionTooltip(version),
    },
    buttons: DISCORD_ACTIVITY_BUTTONS.map((button) => ({ ...button })),
  };
}

function discordPipe(index: number): string {
  return `\\\\?\\pipe\\discord-ipc-${index}`;
}

/** Privacy-safe local Discord RPC. No token, OAuth flow, workspace name, resource
 * name, or server identity ever enters the activity payload. */
export class DiscordPresence {
  private enabled = false;
  private target: CfxTarget = "legacy";
  private context: DiscordActivityContext = { view: "startup", filename: null };
  private version = "0.0.0-development";
  private socket: net.Socket | null = null;
  private ready = false;
  private stopped = false;
  private connecting = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivitySentAt = 0;
  private lastActivityKey = "";
  private decoder = new DiscordFrameDecoder();
  private readonly startedAtSeconds = Math.floor(Date.now() / 1000);

  update(enabled: boolean, target: CfxTarget, version = this.version): void {
    this.enabled = enabled;
    this.target = target;
    this.version = version;
    if (!enabled) {
      this.clearAndDisconnect();
      return;
    }
    this.stopped = false;
    if (this.ready && this.socket) {
      this.publishActivity();
    } else {
      this.connect();
    }
  }

  setContext(value: unknown): DiscordActivityContext {
    this.context = normalizeDiscordActivityContext(value);
    if (this.enabled && this.ready && this.socket) this.publishActivity();
    return this.context;
  }

  stop(): void {
    this.stopped = true;
    this.enabled = false;
    this.clearAndDisconnect();
  }

  private connect(): void {
    if (process.platform !== "win32" || this.connecting || this.socket || !this.enabled || this.stopped) return;
    this.connecting = true;
    this.tryPipe(0);
  }

  private tryPipe(index: number): void {
    if (!this.enabled || this.stopped) {
      this.connecting = false;
      return;
    }
    if (index >= PIPE_COUNT) {
      this.connecting = false;
      this.scheduleRetry();
      return;
    }

    const candidate = net.createConnection(discordPipe(index));
    let connected = false;
    const timeout = setTimeout(() => candidate.destroy(), 750);
    timeout.unref?.();
    candidate.once("connect", () => {
      connected = true;
      clearTimeout(timeout);
      if (!this.enabled || this.stopped) {
        candidate.destroy();
        return;
      }
      this.connecting = false;
      this.socket = candidate;
      this.ready = false;
      this.decoder = new DiscordFrameDecoder();
      candidate.write(encodeDiscordFrame(HANDSHAKE, { v: 1, client_id: DISCORD_APPLICATION_ID }));
    });
    candidate.on("data", (chunk) => this.onData(chunk));
    candidate.once("error", () => clearTimeout(timeout));
    candidate.once("close", () => {
      clearTimeout(timeout);
      if (!connected) {
        this.tryPipe(index + 1);
        return;
      }
      if (this.socket === candidate) {
        this.socket = null;
        this.ready = false;
        this.scheduleRetry();
      }
    });
  }

  private onData(chunk: Buffer): void {
    let frames: DiscordFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.socket?.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === PING) {
        this.socket?.write(encodeDiscordFrame(PONG, frame.payload));
        continue;
      }
      if (frame.opcode === CLOSE) {
        this.socket?.destroy();
        continue;
      }
      if (frame.opcode === FRAME && frame.payload.evt === "READY") {
        this.ready = true;
        this.lastActivityKey = "";
        this.publishActivity(true);
      }
    }
  }

  private publishActivity(force = false): void {
    if (!this.socket || !this.ready) return;
    const activity = buildDiscordActivity(this.target, this.startedAtSeconds, this.context, this.version);
    const key = JSON.stringify(activity);
    if (key === this.lastActivityKey) return;
    const elapsed = Date.now() - this.lastActivitySentAt;
    if (!force && elapsed < MIN_ACTIVITY_UPDATE_MS) {
      if (!this.activityTimer) {
        this.activityTimer = setTimeout(() => {
          this.activityTimer = null;
          this.publishActivity();
        }, MIN_ACTIVITY_UPDATE_MS - elapsed);
        this.activityTimer.unref?.();
      }
      return;
    }
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    this.sendActivity(activity);
    this.lastActivitySentAt = Date.now();
    this.lastActivityKey = key;
  }

  private sendActivity(activity: ReturnType<typeof buildDiscordActivity> | null): void {
    if (!this.socket || (!this.ready && activity !== null)) return;
    try {
      this.socket.write(encodeDiscordFrame(FRAME, {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity },
        nonce: randomUUID(),
      }));
    } catch {
      this.socket.destroy();
    }
  }

  private clearAndDisconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    const active = this.socket;
    if (active) {
      this.sendActivity(null);
      active.end();
      active.destroy();
    }
    this.socket = null;
    this.ready = false;
    this.connecting = false;
    this.lastActivitySentAt = 0;
    this.lastActivityKey = "";
  }

  private scheduleRetry(): void {
    if (!this.enabled || this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }
}
