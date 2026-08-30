import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StoredWindowState extends WindowBounds {
  maximized: boolean;
}

function defaultState(workAreas: WindowBounds[]): StoredWindowState {
  const area = workAreas[0];
  return {
    x: (area?.x ?? 0) + 80,
    y: (area?.y ?? 0) + 80,
    width: 1440,
    height: 900,
    maximized: false,
  };
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function visibleOnDisplay(bounds: WindowBounds, workAreas: WindowBounds[]): boolean {
  return workAreas.some((area) => {
    const horizontal = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
    const vertical = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
    return horizontal >= 64 && vertical >= 64;
  });
}

export function normalizeWindowState(value: unknown, workAreas: WindowBounds[]): StoredWindowState {
  const fallback = defaultState(workAreas);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const raw = value as Record<string, unknown>;
  const x = finiteInteger(raw.x);
  const y = finiteInteger(raw.y);
  const width = finiteInteger(raw.width);
  const height = finiteInteger(raw.height);
  if (x === null || y === null || width === null || height === null || width < 1024 || height < 640 || width > 10_000 || height > 10_000) {
    return fallback;
  }
  const candidate = { x, y, width, height };
  if (workAreas.length > 0 && !visibleOnDisplay(candidate, workAreas)) return fallback;
  return { ...candidate, maximized: raw.maximized === true };
}

export function loadWindowState(filePath: string, workAreas: WindowBounds[]): StoredWindowState {
  try {
    return normalizeWindowState(JSON.parse(fs.readFileSync(filePath, "utf8")), workAreas);
  } catch {
    return defaultState(workAreas);
  }
}

export function saveWindowState(filePath: string, state: StoredWindowState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}
