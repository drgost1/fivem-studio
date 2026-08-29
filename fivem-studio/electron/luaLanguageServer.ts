import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

export type JsonRpcMessage = Record<string, unknown>;

export class LspFrameParser {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: JsonRpcMessage[] = [];
    while (true) {
      const headerEnd = this.buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buffered.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header);
      if (!match) throw new Error("LuaLS sent an invalid message header.");
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
        throw new Error("LuaLS sent an oversized message.");
      }
      const bodyStart = headerEnd + 4;
      if (this.buffered.length < bodyStart + length) break;
      const body = this.buffered.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffered = this.buffered.subarray(bodyStart + length);
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("LuaLS sent a non-object JSON-RPC message.");
      }
      messages.push(parsed as JsonRpcMessage);
    }
    return messages;
  }
}

export function encodeLspMessage(message: JsonRpcMessage): Buffer {
  const body = JSON.stringify(message);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("LuaLS message is too large.");
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8");
}

function languageServerEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "SystemRoot",
    "WINDIR",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "LANG",
  ];
  return Object.fromEntries(allowed.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

export class LuaLanguageServerProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private generation = 0;

  get running(): boolean {
    return this.child !== null;
  }

  start(
    executablePath: string,
    workspaceRoot: string,
    logPath: string,
    onMessage: (message: JsonRpcMessage) => void,
    onStatus: (status: { state: "stopped" | "error"; message?: string }) => void,
  ): void {
    this.stop();
    const generation = ++this.generation;
    const parser = new LspFrameParser();
    let stderr = "";
    const child = spawn(executablePath, [`--logpath=${logPath}`, "--loglevel=warn"], {
      cwd: workspaceRoot,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: languageServerEnvironment(),
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      if (generation !== this.generation) return;
      try {
        for (const message of parser.push(chunk)) onMessage(message);
      } catch (error) {
        onStatus({ state: "error", message: (error as Error).message });
        this.stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.once("error", (error) => {
      if (generation !== this.generation) return;
      this.child = null;
      onStatus({ state: "error", message: error.message });
    });
    child.once("exit", (code) => {
      if (generation !== this.generation) return;
      this.child = null;
      const detail = stderr.trim();
      onStatus({
        state: code === 0 || code === null ? "stopped" : "error",
        message: code && code !== 0 ? `LuaLS exited with code ${code}.${detail ? ` ${detail}` : ""}` : undefined,
      });
    });
  }

  send(message: JsonRpcMessage): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("The Lua language service is not running.");
    this.child.stdin.write(encodeLspMessage(message));
  }

  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.child = null;
    this.generation += 1;
    child.stdin.end();
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 2_000);
      child.once("exit", finish);
      child.once("error", finish);
      child.kill();
    });
  }
}
