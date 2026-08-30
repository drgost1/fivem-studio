import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createTextFile } from "./fsTree";
import { assertSafeBasename, contains, ensureParentInsideRoot, resolveInsideRoot } from "./pathSafety";
import { isCredentialBearingFile } from "./revertStore";
import { resourceManifestPath } from "./resourceContext";

export interface ResourceImportResult {
  name: string;
  rootPath: string;
  manifestPath: string;
  fileCount: number;
  skippedDirectories: string[];
}

const SKIP_DIRECTORIES = new Set([".git", ".vscode", "node_modules", "cache", "logs", "crashes"]);
const MAX_DEPTH = 24;
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function removeOwnedStaging(resourcesRoot: string, staging: string): void {
  const resolvedRoot = path.resolve(resourcesRoot);
  const resolvedStaging = path.resolve(staging);
  if (!contains(resolvedRoot, resolvedStaging) || path.dirname(resolvedStaging) !== resolvedRoot || !path.basename(resolvedStaging).startsWith(".qb-studio-import-")) {
    throw new Error("Refusing to clean an unverified import staging directory.");
  }
  fs.rmSync(resolvedStaging, { recursive: true, force: true });
}

export function importResourceFolder(resourcesRootValue: string, sourceDirectoryValue: string): ResourceImportResult {
  const resourcesRoot = resolveInsideRoot(resourcesRootValue, ".");
  if (!path.isAbsolute(sourceDirectoryValue)) throw new Error("Drop a real folder from Windows Explorer.");
  const sourceStat = fs.lstatSync(sourceDirectoryValue);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Drop an ordinary resource folder, not a file, shortcut, or linked directory.");
  const sourceRoot = fs.realpathSync.native(sourceDirectoryValue);
  const manifest = resourceManifestPath(sourceRoot);
  if (!manifest) throw new Error("That folder is not a Cfx resource; fxmanifest.lua or __resource.lua is required at its root.");
  const name = assertSafeBasename(path.basename(sourceRoot));
  const destination = resolveInsideRoot(resourcesRoot, name);
  if (fs.existsSync(destination)) throw new Error(`A resource named ${name} already exists in this workspace.`);
  const staging = resolveInsideRoot(resourcesRoot, `.qb-studio-import-${randomUUID()}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  let fileCount = 0;
  let totalBytes = 0;
  const skippedDirectories = new Set<string>();

  try {
    const walk = (sourceDir: string, destinationDir: string, depth: number): void => {
      if (depth > MAX_DEPTH) throw new Error(`Resource import exceeded ${MAX_DEPTH} nested directories.`);
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const stat = fs.lstatSync(sourcePath);
        if (stat.isSymbolicLink() || entry.isSymbolicLink()) {
          throw new Error(`Resource contains a symbolic link or junction (${path.relative(sourceRoot, sourcePath)}); import was cancelled.`);
        }
        if (!contains(sourceRoot, fs.realpathSync.native(sourcePath))) throw new Error("A resource entry resolves outside the dropped folder.");
        if (stat.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
            skippedDirectories.add(entry.name);
            continue;
          }
          const nextDestination = path.join(destinationDir, entry.name);
          ensureParentInsideRoot(staging, path.join(nextDestination, ".directory"));
          if (!fs.existsSync(nextDestination)) fs.mkdirSync(nextDestination);
          walk(sourcePath, nextDestination, depth + 1);
          continue;
        }
        if (!stat.isFile()) throw new Error(`Resource contains an unsupported filesystem entry (${entry.name}); import was cancelled.`);
        if (++fileCount > MAX_FILES) throw new Error(`Resource import is limited to ${MAX_FILES} files.`);
        const bytes = fs.readFileSync(sourcePath);
        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Resource import is limited to 256 MB.");
        const text = bytes.length <= 2 * 1024 * 1024 && !bytes.subarray(0, 8_192).includes(0) ? bytes.toString("utf8") : undefined;
        if (isCredentialBearingFile(sourcePath, text)) {
          throw new Error(`Credential-bearing file ${path.relative(sourceRoot, sourcePath)} was found; import was cancelled.`);
        }
        const target = path.join(destinationDir, entry.name);
        ensureParentInsideRoot(staging, target);
        createTextFile(target, bytes);
      }
    };
    walk(sourceRoot, staging, 0);
    const stagedManifest = path.join(staging, path.basename(manifest));
    if (!fs.existsSync(stagedManifest)) throw new Error("The staged resource is missing its manifest.");
    fs.renameSync(staging, destination);
    return {
      name,
      rootPath: destination,
      manifestPath: path.join(destination, path.basename(manifest)),
      fileCount,
      skippedDirectories: [...skippedDirectories].sort(),
    };
  } catch (error) {
    removeOwnedStaging(resourcesRoot, staging);
    throw error;
  }
}
