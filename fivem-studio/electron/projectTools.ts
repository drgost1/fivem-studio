// Tools that let the agent read, search, and edit the code in the user's
// resources folder — handed to the model alongside the MCP server tools.
//
// SECURITY: every path here is relative to the active profile's resources
// folder, and `resolveInsideRoot` is the boundary that keeps it that way.
// Without it, "read a project file" is really "read any file on this machine",
// which is not something a model driving itself should be handed.

import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "./configStore";
import { createTextFile, listDir, readTextFile, readTextFileSnapshot, writeTextFile, resolveProfile } from "./fsTree";
import { ensureParentInsideRoot, resolveInsideRoot } from "./pathSafety";
import type { McpToolDefinition } from "./mcpClient";

/** Far smaller than the editor's 2MB limit: a file that's merely slow to open
 *  in an editor will blow out a model's context window. */
const MAX_READ_BYTES = 100 * 1024;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCHABLE_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".vscode", "cache"]);

/** The resources folder of the profile currently selected in Settings. */
function projectRoot(): string | null {
  const config = loadConfig();
  if (!config.txDataPath || !config.selectedProfile) return null;
  return resolveProfile(config.txDataPath, config.selectedProfile).resourcesPath;
}

// --- editor context, pushed from the renderer as the user moves around ---

export interface EditorContext {
  path: string | null;
  selectedText: string;
  startLine: number;
  endLine: number;
}

let editorContext: EditorContext = { path: null, selectedText: "", startLine: 0, endLine: 0 };

export function setEditorContext(context: EditorContext): void {
  // Renderer state is untrusted. Context is useful, but it must never become
  // a side channel for reading arbitrary local files through the model tool.
  if (!context || (context.path !== null && typeof context.path !== "string") || typeof context.selectedText !== "string") {
    editorContext = { path: null, selectedText: "", startLine: 0, endLine: 0 };
    return;
  }
  const root = projectRoot();
  if (context.path && root) {
    try {
      resolveInsideRoot(root, path.relative(root, context.path));
    } catch {
      editorContext = { path: null, selectedText: "", startLine: 0, endLine: 0 };
      return;
    }
  } else if (context.path) {
    editorContext = { path: null, selectedText: "", startLine: 0, endLine: 0 };
    return;
  }
  editorContext = {
    path: context.path,
    selectedText: context.selectedText.slice(0, MAX_READ_BYTES),
    startLine: Number.isSafeInteger(context.startLine) && context.startLine >= 0 ? context.startLine : 0,
    endLine: Number.isSafeInteger(context.endLine) && context.endLine >= 0 ? context.endLine : 0,
  };
}

export function getEditorContext(): EditorContext {
  return editorContext;
}

/** Called after the agent writes, so the renderer can refresh a stale open buffer. */
let onFileWritten: ((absolutePath: string) => void) | null = null;

export function setOnFileWritten(callback: (absolutePath: string) => void): void {
  onFileWritten = callback;
}

export const PROJECT_TOOL_NAMES = new Set([
  "list_project_files",
  "read_project_file",
  "write_project_file",
  "search_project",
  "get_editor_context",
]);

export function projectToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "list_project_files",
      description:
        "List files and folders inside the active Cfx.re resources folder. Use this to explore what resources exist and what's in them. Paths are relative to the resources folder — pass an empty string for the top level.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path, e.g. '' or 'qb-inventory' or 'qb-inventory/client'." },
        },
      },
    },
    {
      name: "read_project_file",
      description: "Read a file and its revision from the resources folder. Pass that revision back when writing so concurrent edits are never overwritten.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "e.g. 'qb-inventory/fxmanifest.lua'" } },
        required: ["path"],
      },
    },
    {
      name: "write_project_file",
      description:
        "Atomically create or replace a small text file in the resources folder. For an existing file, first read it and pass its exact revision. For a new file, pass expected_revision='new'.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file." },
          content: { type: "string", maxLength: MAX_READ_BYTES, description: "The complete new file content." },
          expected_revision: {
            type: "string",
            description: "The 64-character revision returned by read_project_file, or 'new' only when creating a file that must not exist.",
          },
        },
        required: ["path", "content", "expected_revision"],
      },
    },
    {
      name: "search_project",
      description:
        "Search the resources folder for a string and return matching lines with their file and line number. Use this to find which resource defines something.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for (case-insensitive)." },
          path: { type: "string", description: "Optional relative folder to limit the search to." },
        },
        required: ["query"],
      },
    },
    {
      name: "get_editor_context",
      description:
        "Get the file the user currently has open in the editor, and the text they have selected (highlighted), if any.",
      input_schema: { type: "object", properties: {} },
    },
  ];
}

export async function runProjectTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === "get_editor_context") {
    const ctx = getEditorContext();
    if (!ctx.path) return "No file is currently open in the editor.";
    const root = projectRoot();
    if (!root) return "No project folder is set — the user needs to pick a txData folder and profile in Settings first.";
    let safePath: string;
    try {
      safePath = resolveInsideRoot(root, path.relative(root, ctx.path));
    } catch {
      return "The open editor file is outside the active resources folder and is not shared with the agent.";
    }
    const shown = path.relative(root, safePath);
    if (ctx.selectedText) {
      return `Open file: ${shown}\nSelected lines ${ctx.startLine}-${ctx.endLine}:\n\n${ctx.selectedText}`;
    }
    // No selection — hand back the whole file, which is what "look at what I have open" means.
    try {
      return `Open file: ${shown} (nothing selected)\n\n${truncate(readTextFile(safePath))}`;
    } catch {
      return `Open file: ${shown} (nothing selected, and the file could not be read).`;
    }
  }

  const root = projectRoot();
  if (!root) {
    return "No project folder is set — the user needs to pick a txData folder and profile in Settings first.";
  }

  switch (name) {
    case "list_project_files": {
      const target = resolveInsideRoot(root, String(input.path ?? ""));
      const entries = listDir(target);
      if (entries.length === 0) return "(empty folder)";
      return entries.map((e) => `${e.isDirectory ? "[dir] " : "      "}${path.relative(root, e.path)}`).join("\n");
    }

    case "read_project_file": {
      const target = resolveInsideRoot(root, String(input.path ?? ""));
      const stat = fs.statSync(target);
      if (stat.size > MAX_READ_BYTES) {
        return `File is ${stat.size} bytes, above the agent edit limit of ${MAX_READ_BYTES}; use the editor instead.`;
      }
      const snapshot = readTextFileSnapshot(target);
      return `Revision: ${snapshot.revision}\n\n${snapshot.content}`;
    }

    case "write_project_file": {
      const target = resolveInsideRoot(root, String(input.path ?? ""));
      const content = String(input.content ?? "");
      if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
        throw new Error(`Agent file writes are limited to ${MAX_READ_BYTES} bytes.`);
      }
      const expectedRevision = String(input.expected_revision ?? "");
      if (expectedRevision !== "new" && !REVISION_PATTERN.test(expectedRevision)) {
        throw new Error("expected_revision must be the revision from read_project_file, or 'new' for a new file.");
      }
      ensureParentInsideRoot(root, target);
      if (expectedRevision !== "new" && fs.statSync(target).size > MAX_READ_BYTES) {
        throw new Error(`Agent file writes are limited to existing files of ${MAX_READ_BYTES} bytes or less.`);
      }
      const revision = expectedRevision === "new"
        ? createTextFile(target, content)
        : writeTextFile(target, content, expectedRevision);
      onFileWritten?.(target);
      return `Wrote ${content.length} characters to ${path.relative(root, target)}. New revision: ${revision}`;
    }

    case "search_project": {
      const scope = resolveInsideRoot(root, String(input.path ?? ""));
      const query = String(input.query ?? "");
      if (!query) return "No search query given.";
      const matches = searchTree(scope, query, root);
      if (matches.length === 0) return `No matches for "${query}".`;
      const capped = matches.slice(0, MAX_SEARCH_MATCHES);
      const note =
        matches.length > MAX_SEARCH_MATCHES ? `\n\n(showing first ${MAX_SEARCH_MATCHES} of ${matches.length})` : "";
      return capped.join("\n") + note;
    }

    default:
      return `Unknown project tool "${name}".`;
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_READ_BYTES) return text;
  return `${text.slice(0, MAX_READ_BYTES)}\n\n[truncated — file is ${text.length} characters, showing the first ${MAX_READ_BYTES}]`;
}

function searchTree(dir: string, query: string, root: string): string[] {
  const needle = query.toLowerCase();
  const results: string[] = [];

  const walk = (current: string) => {
    if (results.length >= MAX_SEARCH_MATCHES * 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        resolveInsideRoot(root, path.relative(root, full));
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      try {
        if (fs.statSync(full).size > MAX_SEARCHABLE_FILE_BYTES) continue;
        const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(needle)) {
            results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      } catch {
        // unreadable or binary — skip
      }
    }
  };

  walk(dir);
  return results;
}
