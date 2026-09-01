/**
 * FXServer console log tailing.
 *
 * When FXServer is launched through txAdmin (as opposed to a raw run.cmd/
 * run.sh you control yourself), there's no stdout stream for this process to
 * attach to directly — txAdmin owns the child process. txAdmin does,
 * however, persist the full console (stdin/stdout/stderr) to disk under
 * `txData/<control-profile>/logs/`, rotated daily. We tail that file instead.
 *
 * See: https://github.com/tabarra/txAdmin/blob/master/docs/logs.md
 */

import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export class LogTailError extends Error {}

const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const MAX_CACHED_LINES = 50_000;

interface CachedLine {
  text: string;
  bytes: number;
}

interface TailState {
  logFile: string;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
  offset: number;
  decoder: StringDecoder;
  lines: CachedLine[];
  lineBytes: number;
  partial: string;
  truncated: boolean;
}

export interface ConsoleTailMetrics {
  bytesRead: number;
  readOperations: number;
  cacheRebuilds: number;
}

let tailState: TailState | null = null;
let metrics: ConsoleTailMetrics = { bytesRead: 0, readOperations: 0, cacheRebuilds: 0 };

/** Clears the bounded incremental cache when a runtime/profile is reconfigured. */
export function resetConsoleTailCache(): void {
  tailState = null;
  metrics = { bytesRead: 0, readOperations: 0, cacheRebuilds: 0 };
}

/** Exposes byte-level counters for diagnostics and regression tests, never log content. */
export function getConsoleTailMetrics(): ConsoleTailMetrics {
  return { ...metrics };
}

function findLogDir(dataDir: string, profile: string): string {
  const dir = path.join(dataDir, profile, "logs");
  if (!fs.existsSync(dir)) {
    throw new LogTailError(
      `txAdmin log directory not found: ${dir}. Check TXADMIN_DATA_DIR (path to txAdmin data) and TXADMIN_CONTROL_PROFILE.`,
    );
  }
  return dir;
}

/** Picks the most recently modified fxserver console log file in the log dir. */
function findLatestLogFile(logDir: string): string {
  const candidates = fs
    .readdirSync(logDir)
    .filter((f) => /fxserver.*\.log$/i.test(f))
    .map((f) => {
      const full = path.join(logDir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) {
    throw new LogTailError(
      `No fxserver*.log file found in ${logDir}. If you renamed or disabled the fxserver logger in the txAdmin control profile, get_console_output can't tail it.`,
    );
  }
  return candidates[0].full;
}

export interface TailOptions {
  dataDir: string;
  profile: string;
  /** Number of trailing lines to return. */
  lines?: number;
  /** Only return lines matching this substring/regex (case-insensitive substring by default). */
  filter?: string;
}

function readRange(logFile: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(logFile, "r");
  let total = 0;
  try {
    while (total < length) {
      const read = fs.readSync(fd, buffer, total, length - total, start + total);
      if (read === 0) break;
      total += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  metrics.bytesRead += total;
  metrics.readOperations += 1;
  return total === length ? buffer : buffer.subarray(0, total);
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function appendLine(state: TailState, value: string): void {
  if (!value) return;
  const text = utf8Tail(value, MAX_SCAN_BYTES);
  const bytes = Buffer.byteLength(text, "utf8") + 1;
  state.lines.push({ text, bytes });
  state.lineBytes += bytes;
  while (state.lineBytes > MAX_SCAN_BYTES || state.lines.length > MAX_CACHED_LINES) {
    const removed = state.lines.shift();
    if (!removed) break;
    state.lineBytes -= removed.bytes;
    state.truncated = true;
  }
}

function appendDecoded(state: TailState, decoded: string): void {
  const parts = `${state.partial}${decoded}`.split(/\r?\n/);
  state.partial = parts.pop() ?? "";
  for (const line of parts) appendLine(state, line);
  const boundedPartial = utf8Tail(state.partial, MAX_SCAN_BYTES);
  if (boundedPartial !== state.partial) state.truncated = true;
  state.partial = boundedPartial;
}

function buildTailState(logFile: string, stat: fs.Stats): TailState {
  const start = Math.max(0, stat.size - MAX_SCAN_BYTES);
  const bytes = readRange(logFile, start, stat.size - start);
  const decoder = new StringDecoder("utf8");
  let decoded = decoder.write(bytes);
  let truncated = start > 0;
  if (start > 0) {
    const firstNewline = decoded.indexOf("\n");
    decoded = firstNewline >= 0 ? decoded.slice(firstNewline + 1) : "";
  }
  const state: TailState = {
    logFile,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    mtimeMs: stat.mtimeMs,
    offset: start + bytes.length,
    decoder,
    lines: [],
    lineBytes: 0,
    partial: "",
    truncated,
  };
  appendDecoded(state, decoded);
  metrics.cacheRebuilds += 1;
  return state;
}

function currentTailState(logFile: string, stat: fs.Stats): TailState {
  const sameFile =
    tailState?.logFile === logFile &&
    tailState.ino === stat.ino &&
    tailState.birthtimeMs === stat.birthtimeMs;
  const rewrittenWithoutGrowth =
    sameFile && stat.size === tailState!.offset && stat.mtimeMs !== tailState!.mtimeMs;
  if (!sameFile || stat.size < tailState!.offset || rewrittenWithoutGrowth || stat.size - tailState!.offset > MAX_SCAN_BYTES) {
    tailState = buildTailState(logFile, stat);
    return tailState;
  }

  if (stat.size > tailState!.offset) {
    const bytes = readRange(logFile, tailState!.offset, stat.size - tailState!.offset);
    tailState!.offset += bytes.length;
    appendDecoded(tailState!, tailState!.decoder.write(bytes));
  }
  tailState!.mtimeMs = stat.mtimeMs;
  return tailState!;
}

export function tailConsoleLog(opts: TailOptions): string {
  if (!opts.dataDir) {
    throw new LogTailError(
      "TXADMIN_DATA_DIR is not set. Point it at txAdmin's data directory and set TXADMIN_CONTROL_PROFILE to enable get_console_output.",
    );
  }

  if (!opts.profile) {
    throw new LogTailError("TXADMIN_CONTROL_PROFILE is not set. Set it with TXADMIN_DATA_DIR to enable get_console_output.");
  }

  const logDir = findLogDir(opts.dataDir, opts.profile);
  const logFile = findLatestLogFile(logDir);

  const state = currentTailState(logFile, fs.statSync(logFile));
  let lines = state.lines.map((line) => line.text);
  if (state.partial) lines.push(state.partial);

  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }

  const n = Math.max(1, Math.min(5000, opts.lines ?? 200));
  let output = lines.slice(-n).join("\n");
  if (output.length > MAX_OUTPUT_CHARS) {
    output = `[output limited to the final ${MAX_OUTPUT_CHARS} characters]\n${output.slice(-MAX_OUTPUT_CHARS)}`;
  } else if (state.truncated && opts.filter && lines.length < n) {
    output = `[filter scanned only the bounded recent console history]\n${output}`;
  }
  return output;
}

/**
 * A byte position in the current console log, used to read exactly the lines
 * produced after a point in time. Deliberately independent of the tail cache
 * above: restart_and_verify must not perturb, or be perturbed by, whatever
 * get_console_output last read.
 */
export interface ConsoleCursor {
  logFile: string;
  size: number;
}

export function getConsoleCursor(dataDir: string, profile: string): ConsoleCursor {
  const logFile = findLatestLogFile(findLogDir(dataDir, profile));
  return { logFile, size: fs.statSync(logFile).size };
}

/**
 * Returns the console lines written since `cursor`. If the log rotated (or was
 * truncated) between the two calls, falls back to the tail of the current file
 * rather than reporting nothing.
 */
export function readConsoleSince(
  dataDir: string,
  profile: string,
  cursor: ConsoleCursor,
  maxBytes = 1024 * 1024,
): { lines: string[]; rotated: boolean } {
  const logFile = findLatestLogFile(findLogDir(dataDir, profile));
  const size = fs.statSync(logFile).size;
  const rotated = logFile !== cursor.logFile || size < cursor.size;
  const start = rotated ? Math.max(0, size - maxBytes) : cursor.size;
  const length = Math.min(size - start, maxBytes);
  if (length <= 0) return { lines: [], rotated };
  const decoded = new StringDecoder("utf8").write(readRange(logFile, start, length));
  const lines = decoded.split(/\r?\n/).filter((line) => line.length > 0);
  // A rotated read starts mid-line; drop that fragment.
  if (rotated && start > 0) lines.shift();
  return { lines, rotated };
}
