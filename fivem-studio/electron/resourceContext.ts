import fs from "node:fs";
import path from "node:path";

import { resolveInsideRoot } from "./pathSafety";

const MANIFEST_NAMES = ["fxmanifest.lua", "__resource.lua"] as const;

export interface ResourceContext {
  name: string;
  rootPath: string;
  manifestPath: string;
}

/** Matches the runtime's manifest rule: regular manifest files only, no links. */
export function resourceManifestPath(directory: string): string | null {
  for (const name of MANIFEST_NAMES) {
    const candidate = path.join(directory, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {
      // Missing or unreadable files do not make a directory a resource.
    }
  }
  return null;
}

export function resourceAtDirectory(resourcesRoot: string, directory: string): ResourceContext | null {
  const contained = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, directory));
  const manifestPath = resourceManifestPath(contained);
  return manifestPath ? { name: path.basename(contained), rootPath: contained, manifestPath } : null;
}

/** Resolves the nearest owning resource for a contained file or directory. */
export function resolveResourceContext(resourcesRoot: string, targetPath: string): ResourceContext | null {
  const contained = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, targetPath));
  let current = contained;
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  const root = path.resolve(resourcesRoot);
  while (current !== root) {
    const context = resourceAtDirectory(root, current);
    if (context) return context;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
