import fs from "node:fs";
import path from "node:path";

const MAX_DIRECTORIES = 20_000;
const MAX_DEPTH = 24;
const MAX_INFO_BYTES = 2 * 1024 * 1024;
const INFO_TIMEOUT_MS = 2_000;

export type ResourceState = "started" | "stopped";

export interface ResourceStatus {
  name: string;
  state: ResourceState;
}

function hasManifest(directory: string): boolean {
  for (const name of ["fxmanifest.lua", "__resource.lua"]) {
    try {
      const stat = fs.lstatSync(path.join(directory, name));
      if (stat.isFile() && !stat.isSymbolicLink()) return true;
    } catch {
      // Missing/unreadable manifests simply mean this directory is not a resource.
    }
  }
  return false;
}

/**
 * Finds resource roots without reading resource contents or following links.
 * Category folders may be nested, so traversal stops at a manifest rather than
 * assuming categories always use one exact folder depth.
 */
export function findWorkspaceResources(workspacePath: string): string[] {
  const resourcesRoot = path.join(workspacePath, "resources");
  let root: fs.Stats;
  try {
    root = fs.lstatSync(resourcesRoot);
  } catch {
    return [];
  }
  if (!root.isDirectory() || root.isSymbolicLink()) return [];

  const found = new Set<string>();
  const pending: Array<{ directory: string; depth: number }> = [{ directory: resourcesRoot, depth: 0 }];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (++visited > MAX_DIRECTORIES) throw new Error(`Resource discovery exceeded ${MAX_DIRECTORIES} directories.`);
    if (current.depth > MAX_DEPTH) throw new Error(`Resource discovery exceeded ${MAX_DEPTH} nested directories.`);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(current.directory, entry.name);
      let childStat: fs.Stats;
      try {
        childStat = fs.lstatSync(child);
      } catch {
        continue;
      }
      if (!childStat.isDirectory() || childStat.isSymbolicLink()) continue;

      if (hasManifest(child)) {
        found.add(entry.name);
      } else {
        pending.push({ directory: child, depth: current.depth + 1 });
      }
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function serverInfoUrl(host: string, port: number): URL {
  const bracketedHost = host.includes(":") ? `[${host.replace(/^\[|\]$/g, "")}]` : host;
  return new URL(`http://${bracketedHost}:${port}/info.json`);
}

async function readLimitedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INFO_BYTES) {
    throw new Error("The local server info response is too large.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INFO_BYTES) throw new Error("The local server info response is too large.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** Reads only the loopback server endpoint already validated by config.ts. */
export async function fetchStartedResources(host: string, port: number): Promise<string[]> {
  const response = await fetch(serverInfoUrl(host, port), {
    redirect: "error",
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Local server info returned HTTP ${response.status}.`);
  const parsed = JSON.parse(await readLimitedBody(response)) as { resources?: unknown };
  if (!Array.isArray(parsed.resources) || parsed.resources.some((name) => typeof name !== "string")) {
    throw new Error("The local server info response did not contain a valid resource list.");
  }
  return [...new Set(parsed.resources as string[])];
}

export async function listResourceStatuses(
  workspacePath: string,
  host: string,
  port: number,
): Promise<{ resources: ResourceStatus[]; serverStateAvailable: boolean }> {
  const detected = findWorkspaceResources(workspacePath);
  let started: string[] = [];
  let serverStateAvailable = true;
  try {
    started = await fetchStartedResources(host, port);
  } catch {
    serverStateAvailable = false;
  }

  const names = new Map<string, string>();
  for (const name of [...detected, ...started]) names.set(name.toLowerCase(), name);
  const startedKeys = new Set(started.map((name) => name.toLowerCase()));
  const resources = [...names.entries()]
    .map(([key, name]) => ({ name, state: startedKeys.has(key) ? "started" as const : "stopped" as const }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return { resources, serverStateAvailable };
}

export function formatResourceStatuses(result: {
  resources: ResourceStatus[];
  serverStateAvailable: boolean;
}): string {
  if (result.resources.length === 0) {
    return result.serverStateAvailable
      ? "No resources were reported by the local server or found in this workspace."
      : "No resources were found in this workspace. The local server is not currently reporting started state.";
  }
  const lines = result.resources.map((resource) => `${resource.state.padEnd(7)} ${resource.name}`);
  if (!result.serverStateAvailable) {
    lines.unshift("Server state unavailable; workspace resources are shown as stopped.", "");
  }
  return lines.join("\n");
}
