import fs from "node:fs";
import path from "node:path";

import { readTextFileSnapshot } from "./fsTree";
import { parseManifestForm } from "./manifestModel";
import { resolveInsideRoot } from "./pathSafety";
import { resourceManifestPath } from "./resourceContext";

export interface ResourceDependencyNode {
  name: string;
  rootPath: string;
  manifestPath: string;
  dependencies: string[];
  dependents: string[];
  missingDependencies: string[];
  manifestWarning?: string;
}

export interface ResourceDependencyGraph {
  nodes: ResourceDependencyNode[];
}

const MAX_DIRECTORIES = 20_000;
const MAX_DEPTH = 24;

function fallbackDependencies(source: string): string[] {
  const dependencies: string[] = [];
  const directive = /^\s*(?:dependency|dependencies)\b([^\r\n]*(?:\r?\n\s*[^}]*)?)/gim;
  for (const match of source.matchAll(directive)) {
    for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/g)) dependencies.push(quoted[1]);
  }
  return dependencies;
}

function transitiveDependents(name: string, direct: Map<string, Set<string>>): string[] {
  const found = new Map<string, string>();
  const pending = [...(direct.get(name.toLowerCase()) ?? [])];
  while (pending.length > 0) {
    const dependent = pending.shift()!;
    const key = dependent.toLowerCase();
    if (key === name.toLowerCase() || found.has(key)) continue;
    found.set(key, dependent);
    pending.push(...(direct.get(key) ?? []));
  }
  return [...found.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function buildResourceDependencyGraph(resourcesRootValue: string): ResourceDependencyGraph {
  const resourcesRoot = resolveInsideRoot(resourcesRootValue, ".");
  const rootStat = fs.lstatSync(resourcesRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Resources root must be an ordinary directory.");
  const pending: Array<{ directory: string; depth: number }> = [{ directory: resourcesRoot, depth: 0 }];
  const discovered: Array<Omit<ResourceDependencyNode, "dependents" | "missingDependencies">> = [];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (++visited > MAX_DIRECTORIES) throw new Error(`Resource discovery exceeded ${MAX_DIRECTORIES} directories.`);
    if (current.depth > MAX_DEPTH) throw new Error(`Resource discovery exceeded ${MAX_DEPTH} nested directories.`);
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, path.join(current.directory, entry.name)));
      const stat = fs.lstatSync(child);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const manifestPath = resourceManifestPath(child);
      if (!manifestPath) {
        pending.push({ directory: child, depth: current.depth + 1 });
        continue;
      }
      const source = readTextFileSnapshot(manifestPath).content;
      const parsed = parseManifestForm(source);
      const dependencies = parsed.ok ? parsed.values.dependencies : fallbackDependencies(source);
      discovered.push({
        name: entry.name,
        rootPath: child,
        manifestPath,
        dependencies: [...new Map(dependencies.map((dependency) => [dependency.toLowerCase(), dependency])).values()],
        manifestWarning: parsed.ok ? undefined : parsed.reason,
      });
    }
  }

  const known = new Map(discovered.map((node) => [node.name.toLowerCase(), node.name]));
  const directDependents = new Map<string, Set<string>>();
  for (const node of discovered) {
    for (const dependency of node.dependencies) {
      const key = dependency.toLowerCase();
      const values = directDependents.get(key) ?? new Set<string>();
      values.add(node.name);
      directDependents.set(key, values);
    }
  }
  return {
    nodes: discovered.map((node) => ({
      ...node,
      dependents: transitiveDependents(node.name, directDependents),
      missingDependencies: node.dependencies.filter((dependency) => !dependency.startsWith("/") && !known.has(dependency.toLowerCase())),
    })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  };
}
