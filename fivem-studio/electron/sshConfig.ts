/**
 * Reads host aliases out of an OpenSSH client config so a remote host can be
 * picked from a list instead of typed.
 *
 * This only ever reads. It does not parse keys, does not read identity files,
 * and returns nothing but alias names — the SSH client still resolves every
 * connection detail itself.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Depth cap for Include, which OpenSSH allows to nest. */
const MAX_INCLUDE_DEPTH = 3;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_HOSTS = 500;

export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), ".ssh", "config");
}

/** A pattern, negation, or the catch-all cannot be connected to by name. */
function isConnectableAlias(alias: string): boolean {
  if (!alias || alias.length > 255) return false;
  if (alias.startsWith("!")) return false;
  if (alias.includes("*") || alias.includes("?")) return false;
  // Same conservative shape the remote settings validator accepts.
  return /^[A-Za-z0-9._@-]+$/.test(alias);
}

function readIfSmallEnough(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Expands one Include argument, which may be relative to ~/.ssh and may glob. */
function resolveIncludes(argument: string, baseDirectory: string): string[] {
  const expanded = argument.startsWith("~/")
    ? path.join(os.homedir(), argument.slice(2))
    : path.isAbsolute(argument)
      ? argument
      : path.join(baseDirectory, argument);

  const directory = path.dirname(expanded);
  const pattern = path.basename(expanded);
  if (!pattern.includes("*") && !pattern.includes("?")) return [expanded];

  // Translate the glob rather than pulling in a dependency for it.
  const asRegex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
  );
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && asRegex.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function collect(filePath: string, depth: number, seen: Set<string>, out: Set<string>): void {
  const resolved = path.resolve(filePath);
  if (depth > MAX_INCLUDE_DEPTH || seen.has(resolved)) return;
  seen.add(resolved);

  const contents = readIfSmallEnough(resolved);
  if (contents === null) return;

  const baseDirectory = path.dirname(resolved);
  for (const rawLine of contents.split(/\r?\n/)) {
    if (out.size >= MAX_HOSTS) return;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // OpenSSH accepts "Key value" and "Key=value", case-insensitively.
    const match = /^([A-Za-z]+)[\s=]+(.+)$/.exec(line);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();

    if (keyword === "include") {
      for (const included of value.split(/\s+/).flatMap((argument) => resolveIncludes(argument, baseDirectory))) {
        collect(included, depth + 1, seen, out);
      }
      continue;
    }
    if (keyword !== "host") continue;

    for (const alias of value.split(/\s+/)) {
      if (isConnectableAlias(alias)) out.add(alias);
      if (out.size >= MAX_HOSTS) return;
    }
  }
}

/** Host aliases from an SSH config, sorted. Missing or unreadable file → []. */
export function listSshHosts(configPath: string): string[] {
  const out = new Set<string>();
  collect(configPath, 0, new Set<string>(), out);
  return [...out].sort((a, b) => a.localeCompare(b));
}
