import fs from "node:fs";
import path from "node:path";

import { contains, resolveInsideRoot } from "./pathSafety";

const MAX_FILES = 512;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_REPORT_CHARS = 40_000;

export interface CrashReportSummary {
  relativePath: string;
  modifiedAt: string;
  excerpt: string;
  truncated: boolean;
}

function redactCredentials(value: string): string {
  return value
    .replace(/((?:set|setr|sets)?\s*(?:rcon_password|sv_licenseKey|steam_webApiKey|mysql_connection_string)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1\"<redacted>\"")
    .replace(/\b(?:sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/g, "<redacted-token>");
}

/** Return the newest ordinary text-like crash artifact below the active profile. */
export function newestCrashReport(profileRoot: string): CrashReportSummary | null {
  const crashesRoot = resolveInsideRoot(profileRoot, "crashes");
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(crashesRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;

  const stack = [crashesRoot];
  let visited = 0;
  let newest: { target: string; modifiedMs: number; size: number } | null = null;
  while (stack.length > 0 && visited < MAX_FILES) {
    const directory = stack.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (visited >= MAX_FILES) break;
      visited += 1;
      const target = path.join(directory, entry.name);
      if (!contains(crashesRoot, target)) continue;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        stack.push(target);
      } else if (stat.isFile() && stat.size <= MAX_REPORT_BYTES && (!newest || stat.mtimeMs > newest.modifiedMs)) {
        newest = { target, modifiedMs: stat.mtimeMs, size: stat.size };
      }
    }
  }
  if (!newest) return null;
  const absolute = resolveInsideRoot(profileRoot, path.relative(profileRoot, newest.target));
  const raw = fs.readFileSync(absolute, "utf8");
  if (raw.slice(0, 8_192).includes("\0")) return null;
  const excerpt = redactCredentials(raw.slice(-MAX_REPORT_CHARS));
  return {
    relativePath: path.relative(profileRoot, absolute),
    modifiedAt: new Date(newest.modifiedMs).toISOString(),
    excerpt,
    truncated: raw.length > MAX_REPORT_CHARS,
  };
}
