import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveInsideRoot } from "./pathSafety";
import { isCredentialBearingFile } from "./revertStore";
import { resourceAtDirectory } from "./resourceContext";

export interface ResourceComparisonFile {
  relativePath: string;
  kind: "added" | "removed" | "modified";
  originalContent: string;
  modifiedContent: string;
  previewUnavailable: boolean;
}

export interface ResourceComparison {
  leftName: string;
  rightName: string;
  files: ResourceComparisonFile[];
  totalChanged: number;
  scannedFiles: number;
  skippedCredentialFiles: number;
  truncated: boolean;
}

interface FileDescription {
  digest: string;
  content: string;
  previewUnavailable: boolean;
  credential: boolean;
}

const SKIP_DIRECTORIES = new Set([".git", ".vscode", "node_modules", "cache", "logs", "crashes"]);
const MAX_DEPTH = 24;
const MAX_SCANNED_FILES = 10_000;
const MAX_CHANGED_FILES = 1_000;
const MAX_PREVIEW_BYTES = 1024 * 1024;

function forwardSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function describeFile(filePath: string): FileDescription {
  if (isCredentialBearingFile(filePath)) {
    return { digest: "", content: "", previewUnavailable: true, credential: true };
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Resource comparison only reads ordinary files.");
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      if (total + read <= MAX_PREVIEW_BYTES) chunks.push(Buffer.from(chunk));
      total += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  const preview = total <= MAX_PREVIEW_BYTES ? Buffer.concat(chunks) : null;
  const binary = !preview || preview.subarray(0, 8_192).includes(0);
  const content = binary ? "" : preview.toString("utf8");
  return {
    digest: hash.digest("hex"),
    content,
    previewUnavailable: binary,
    credential: !binary && isCredentialBearingFile(filePath, content),
  };
}

function collectFiles(resourcesRoot: string, resourceRoot: string): { files: Map<string, FileDescription>; scannedFiles: number } {
  const files = new Map<string, FileDescription>();
  let scannedFiles = 0;
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error(`Resource comparison exceeded ${MAX_DEPTH} nested directories.`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, path.join(directory, entry.name)));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scannedFiles += 1;
      if (scannedFiles > MAX_SCANNED_FILES) throw new Error(`Resource comparison is limited to ${MAX_SCANNED_FILES} files per resource.`);
      files.set(forwardSlashes(path.relative(resourceRoot, target)), describeFile(target));
    }
  };
  walk(resourceRoot, 0);
  return { files, scannedFiles };
}

function validatedResource(resourcesRootValue: string, directoryValue: string) {
  const resourcesRoot = resolveInsideRoot(resourcesRootValue, ".");
  const directory = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, directoryValue));
  const resource = resourceAtDirectory(resourcesRoot, directory);
  if (!resource || resource.rootPath !== directory) throw new Error("Choose an existing resource folder from this workspace.");
  return { resourcesRoot, resource };
}

export function compareResources(resourcesRootValue: string, leftDirectory: string, rightDirectory: string): ResourceComparison {
  const left = validatedResource(resourcesRootValue, leftDirectory);
  const right = validatedResource(resourcesRootValue, rightDirectory);
  if (left.resource.rootPath === right.resource.rootPath) throw new Error("Choose two different resources to compare.");
  const leftFiles = collectFiles(left.resourcesRoot, left.resource.rootPath);
  const rightFiles = collectFiles(right.resourcesRoot, right.resource.rootPath);
  const paths = [...new Set([...leftFiles.files.keys(), ...rightFiles.files.keys()])]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const files: ResourceComparisonFile[] = [];
  let totalChanged = 0;
  let skippedCredentialFiles = 0;
  for (const relativePath of paths) {
    const original = leftFiles.files.get(relativePath);
    const modified = rightFiles.files.get(relativePath);
    if (original?.credential || modified?.credential) {
      skippedCredentialFiles += 1;
      continue;
    }
    if (original?.digest === modified?.digest) continue;
    totalChanged += 1;
    if (files.length >= MAX_CHANGED_FILES) continue;
    files.push({
      relativePath,
      kind: !original ? "added" : !modified ? "removed" : "modified",
      originalContent: original?.content ?? "",
      modifiedContent: modified?.content ?? "",
      previewUnavailable: Boolean(original?.previewUnavailable || modified?.previewUnavailable),
    });
  }
  return {
    leftName: left.resource.name,
    rightName: right.resource.name,
    files,
    totalChanged,
    scannedFiles: leftFiles.scannedFiles + rightFiles.scannedFiles,
    skippedCredentialFiles,
    truncated: totalChanged > files.length,
  };
}
