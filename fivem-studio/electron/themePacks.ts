import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ThemePreference } from "./configStore";

export type ThemeBase = "dark" | "light" | "high-contrast";

export const THEME_COLOR_KEYS = [
  "bg-0", "bg-1", "bg-2", "bg-3", "border", "border-strong",
  "text-0", "text-1", "text-2", "accent", "accent-hover", "accent-wash",
  "ok", "warn", "error", "warn-wash", "warn-border", "error-wash", "error-border",
  "diff-add", "diff-add-in", "diff-del", "diff-del-in", "scrollbar-hover",
  "modal-scrim", "text-on-solid",
] as const;

export const EDITOR_COLOR_KEYS = [
  "editor.background", "editor.foreground", "editorLineNumber.foreground",
  "editorLineNumber.activeForeground", "editor.lineHighlightBackground",
  "editor.selectionBackground", "editor.inactiveSelectionBackground",
  "editorCursor.foreground", "editorWhitespace.foreground",
  "editorIndentGuide.background1", "editorIndentGuide.activeBackground1",
  "editorWidget.background", "editorWidget.border",
  "editorSuggestWidget.selectedBackground", "diffEditor.insertedTextBackground",
  "diffEditor.removedTextBackground", "diffEditor.insertedLineBackground",
  "diffEditor.removedLineBackground",
] as const;

export const EDITOR_TOKEN_KEYS = [
  "comment", "keyword", "string", "number", "function", "global",
  "property", "variable", "operator",
] as const;

export type ThemeColorKey = typeof THEME_COLOR_KEYS[number];
export type EditorColorKey = typeof EDITOR_COLOR_KEYS[number];
export type EditorTokenKey = typeof EDITOR_TOKEN_KEYS[number];

export interface ThemePack {
  schemaVersion: 1;
  id: string;
  name: string;
  author: string | null;
  base: ThemeBase;
  colors: Partial<Record<ThemeColorKey, string>>;
  editor: {
    colors: Partial<Record<EditorColorKey, string>>;
    tokens: Partial<Record<EditorTokenKey, string>>;
  };
}

const MAX_THEME_FILE_BYTES = 64 * 1024;
const MAX_THEME_FILES = 64;
const THEME_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be plain text up to ${max} characters.`);
  }
  return value.trim();
}

function colorMap<K extends string>(value: unknown, allowed: readonly K[], label: string): Partial<Record<K, string>> {
  if (value === undefined) return {};
  const raw = record(value, label);
  const allowedSet = new Set<string>(allowed);
  const output: Partial<Record<K, string>> = {};
  for (const [key, color] of Object.entries(raw)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported key "${key}".`);
    if (typeof color !== "string" || !HEX_COLOR.test(color)) {
      throw new Error(`${label}.${key} must be a hexadecimal color such as #4c9ee8 or #4c9ee880.`);
    }
    output[key as K] = color.toLowerCase();
  }
  return output;
}

export function customThemePreference(id: string): ThemePreference {
  if (!THEME_ID.test(id)) throw new Error("Theme id must use lowercase letters, numbers, and hyphens.");
  return `custom:${id}`;
}

export function customThemeId(preference: ThemePreference): string | null {
  if (!preference.startsWith("custom:")) return null;
  const id = preference.slice("custom:".length);
  return THEME_ID.test(id) ? id : null;
}

export function parseThemePack(value: unknown): ThemePack {
  const raw = record(value, "Theme pack");
  if (raw.schemaVersion !== 1) throw new Error("Theme pack schemaVersion must be 1.");
  const id = boundedText(raw.id, "Theme id", 48);
  if (!THEME_ID.test(id)) throw new Error("Theme id must use lowercase letters, numbers, and hyphens.");
  const name = boundedText(raw.name, "Theme name", 64);
  const author = raw.author === undefined || raw.author === null ? null : boundedText(raw.author, "Theme author", 64);
  const base = raw.base;
  if (base !== "dark" && base !== "light" && base !== "high-contrast") {
    throw new Error("Theme base must be dark, light, or high-contrast.");
  }
  const editor = raw.editor === undefined ? {} : record(raw.editor, "Theme editor settings");
  return {
    schemaVersion: 1,
    id,
    name,
    author,
    base,
    colors: colorMap(raw.colors, THEME_COLOR_KEYS, "Theme colors"),
    editor: {
      colors: colorMap(editor.colors, EDITOR_COLOR_KEYS, "Theme editor colors"),
      tokens: colorMap(editor.tokens, EDITOR_TOKEN_KEYS, "Theme editor tokens"),
    },
  };
}

function readThemeFile(filePath: string): ThemePack {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Theme files must be ordinary JSON files, not links.");
  if (stat.size > MAX_THEME_FILE_BYTES) throw new Error("Theme files may not exceed 64 KB.");
  return parseThemePack(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export class ThemePackStore {
  constructor(private readonly root: string) {}

  directory(): string {
    return this.root;
  }

  list(): ThemePack[] {
    fs.mkdirSync(this.root, { recursive: true });
    const entries = fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .slice(0, MAX_THEME_FILES);
    const byId = new Map<string, ThemePack>();
    for (const entry of entries) {
      try {
        const pack = readThemeFile(path.join(this.root, entry.name));
        if (!byId.has(pack.id)) byId.set(pack.id, pack);
      } catch {
        // A broken third-party pack must not prevent valid themes or startup.
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  find(id: string): ThemePack | null {
    return this.list().find((pack) => pack.id === id) ?? null;
  }

  import(sourcePath: string): ThemePack {
    if (!path.isAbsolute(sourcePath)) throw new Error("Choose an absolute theme-pack path.");
    const pack = readThemeFile(sourcePath);
    fs.mkdirSync(this.root, { recursive: true });
    const destination = path.join(this.root, `${pack.id}.json`);
    const temporary = path.join(this.root, `.${pack.id}.${randomUUID()}.tmp`);
    const backup = path.join(this.root, `.${pack.id}.${randomUUID()}.bak`);
    let backupCreated = false;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(pack, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      if (fs.existsSync(destination)) {
        const existing = fs.lstatSync(destination);
        if (existing.isDirectory() && !existing.isSymbolicLink()) {
          throw new Error(`A directory conflicts with the theme id "${pack.id}".`);
        }
        fs.renameSync(destination, backup);
        backupCreated = true;
      }
      fs.renameSync(temporary, destination);
      fs.rmSync(backup, { force: true });
      backupCreated = false;
    } catch (error) {
      if (backupCreated && !fs.existsSync(destination)) fs.renameSync(backup, destination);
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(backup, { force: true });
    }
    return pack;
  }
}

export function themeBaseForPreference(preference: ThemePreference, store: ThemePackStore): ThemeBase | "system" {
  const id = customThemeId(preference);
  if (!id) {
    if (preference === "dark" || preference === "light" || preference === "high-contrast") return preference;
    return "system";
  }
  return store.find(id)?.base ?? "dark";
}
