import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createTextFile } from "./fsTree";
import { assertSafeBasename, contains, ensureParentInsideRoot, resolveInsideRoot } from "./pathSafety";
import { isCredentialBearingFile } from "./revertStore";
import { resourceAtDirectory } from "./resourceContext";

export interface ResourceDuplicateResult {
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

function updatedManifest(bytes: Buffer, sourceName: string, destinationName: string): Buffer {
  if (bytes.subarray(0, 8_192).includes(0)) return bytes;
  const source = bytes.toString("utf8");
  const directive = /^(\s*name\s+)(['"])([^'"\r\n]+)\2/gim;
  let changed = false;
  const updated = source.replace(directive, (whole, prefix: string, quote: string, value: string) => {
    if (value.toLowerCase() !== sourceName.toLowerCase()) return whole;
    changed = true;
    return `${prefix}${quote}${destinationName}${quote}`;
  });
  return changed ? Buffer.from(updated, "utf8") : bytes;
}

function removeOwnedStaging(parent: string, staging: string): void {
  const resolvedParent = path.resolve(parent);
  const resolvedStaging = path.resolve(staging);
  if (!contains(resolvedParent, resolvedStaging) || path.dirname(resolvedStaging) !== resolvedParent || !path.basename(resolvedStaging).startsWith(".qb-studio-duplicate-")) {
    throw new Error("Refusing to clean an unverified staging directory.");
  }
  fs.rmSync(resolvedStaging, { recursive: true, force: true });
}

export function duplicateResource(resourcesRootValue: string, sourceDirectoryValue: string, newNameValue: string): ResourceDuplicateResult {
  const resourcesRoot = resolveInsideRoot(resourcesRootValue, ".");
  const sourceDirectory = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, sourceDirectoryValue));
  const source = resourceAtDirectory(resourcesRoot, sourceDirectory);
  if (!source || source.rootPath !== sourceDirectory) throw new Error("Choose an existing resource folder from this workspace.");
  const name = assertSafeBasename(newNameValue);
  const parent = path.dirname(source.rootPath);
  const destination = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, path.join(parent, name)));
  if (fs.existsSync(destination)) throw new Error(`A resource named ${name} already exists in this category.`);
  const staging = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, path.join(parent, `.qb-studio-duplicate-${randomUUID()}`)));
  fs.mkdirSync(staging, { mode: 0o700 });
  let fileCount = 0;
  let totalBytes = 0;
  const skippedDirectories = new Set<string>();

  try {
    const walk = (sourceDir: string, destinationDir: string, depth: number): void => {
      if (depth > MAX_DEPTH) throw new Error(`Resource duplication exceeded ${MAX_DEPTH} nested directories.`);
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = resolveInsideRoot(source.rootPath, path.relative(source.rootPath, path.join(sourceDir, entry.name)));
        if (entry.isSymbolicLink()) throw new Error(`Resource contains a symbolic link or junction (${path.relative(source.rootPath, sourcePath)}); duplication was cancelled.`);
        if (entry.isDirectory()) {
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
        if (!entry.isFile()) throw new Error(`Resource contains an unsupported filesystem entry (${entry.name}); duplication was cancelled.`);
        if (++fileCount > MAX_FILES) throw new Error(`Resource duplication is limited to ${MAX_FILES} files.`);
        const bytes = fs.readFileSync(sourcePath);
        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Resource duplication is limited to 256 MB.");
        const text = bytes.length <= 2 * 1024 * 1024 && !bytes.subarray(0, 8_192).includes(0) ? bytes.toString("utf8") : undefined;
        if (isCredentialBearingFile(sourcePath, text)) {
          throw new Error(`Credential-bearing file ${path.relative(source.rootPath, sourcePath)} was found; duplication was cancelled.`);
        }
        const target = path.join(destinationDir, entry.name);
        ensureParentInsideRoot(staging, target);
        const content = sourcePath === source.manifestPath ? updatedManifest(bytes, source.name, name) : bytes;
        createTextFile(target, content);
      }
    };
    walk(source.rootPath, staging, 0);
    if (!fs.existsSync(path.join(staging, path.basename(source.manifestPath)))) {
      throw new Error("The duplicated resource is missing its manifest.");
    }
    fs.renameSync(staging, destination);
    return {
      name,
      rootPath: destination,
      manifestPath: path.join(destination, path.basename(source.manifestPath)),
      fileCount,
      skippedDirectories: [...skippedDirectories].sort(),
    };
  } catch (error) {
    removeOwnedStaging(parent, staging);
    throw error;
  }
}
