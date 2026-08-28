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

export class LogTailError extends Error {}

const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;

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

  const stat = fs.statSync(logFile);
  const bytesToRead = Math.min(stat.size, MAX_SCAN_BYTES);
  const start = stat.size - bytesToRead;
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const fd = fs.openSync(logFile, "r");
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, start);
  } finally {
    fs.closeSync(fd);
  }
  let raw = buffer.toString("utf8");
  if (start > 0) {
    const firstNewline = raw.indexOf("\n");
    raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
  }
  let lines = raw.split(/\r?\n/).filter((l) => l.length > 0);

  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }

  const n = opts.lines ?? 200;
  let output = lines.slice(-n).join("\n");
  if (output.length > MAX_OUTPUT_CHARS) {
    output = `[output limited to the final ${MAX_OUTPUT_CHARS} characters]\n${output.slice(-MAX_OUTPUT_CHARS)}`;
  } else if (start > 0 && opts.filter && lines.length < n) {
    output = `[filter scanned only the final ${MAX_SCAN_BYTES / 1024 / 1024} MiB of this large log]\n${output}`;
  }
  return output;
}
