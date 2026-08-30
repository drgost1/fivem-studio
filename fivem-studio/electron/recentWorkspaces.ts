import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CfxTarget, StudioConfig } from "./configStore";
import { assertSafeBasename, resolveInsideRoot } from "./pathSafety";

interface RecentWorkspaceRecord {
  id: string;
  txDataPath: string;
  profile: string;
  target: CfxTarget;
  lastUsedAt: string;
}

export interface RecentWorkspaceSummary {
  id: string;
  label: string;
  target: CfxTarget;
  lastUsedAt: string;
}

const MAX_RECENTS = 8;

function workspaceId(txDataPath: string, profile: string): string {
  return createHash("sha256").update(`${path.resolve(txDataPath)}\0${profile}`).digest("hex").slice(0, 24);
}

function validRecord(value: unknown): RecentWorkspaceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.txDataPath !== "string" || !path.isAbsolute(raw.txDataPath) || typeof raw.profile !== "string") return null;
  let profile: string;
  try { profile = assertSafeBasename(raw.profile); } catch { return null; }
  const target = raw.target === "enhanced" || raw.target === "redm" ? raw.target : raw.target === "legacy" ? "legacy" : null;
  if (!target || typeof raw.lastUsedAt !== "string") return null;
  const id = workspaceId(raw.txDataPath, profile);
  if (raw.id !== id) return null;
  return { id, txDataPath: path.resolve(raw.txDataPath), profile, target, lastUsedAt: raw.lastUsedAt };
}

function readRecords(filePath: string): RecentWorkspaceRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(validRecord).filter((record): record is RecentWorkspaceRecord => record !== null).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function workspaceStillExists(record: RecentWorkspaceRecord): boolean {
  try {
    const root = fs.lstatSync(record.txDataPath);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    const profileRoot = resolveInsideRoot(record.txDataPath, record.profile);
    const profile = fs.lstatSync(profileRoot);
    return profile.isDirectory() && !profile.isSymbolicLink();
  } catch {
    return false;
  }
}

function writeRecords(filePath: string, records: RecentWorkspaceRecord[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(records.slice(0, MAX_RECENTS), null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

export function recordRecentWorkspace(filePath: string, config: StudioConfig): void {
  if (!config.txDataPath || !config.selectedProfile) return;
  const profile = assertSafeBasename(config.selectedProfile);
  const txDataPath = path.resolve(config.txDataPath);
  const next: RecentWorkspaceRecord = {
    id: workspaceId(txDataPath, profile),
    txDataPath,
    profile,
    target: config.activeCfxTarget,
    lastUsedAt: new Date().toISOString(),
  };
  writeRecords(filePath, [next, ...readRecords(filePath).filter((record) => record.id !== next.id)]);
}

export function listRecentWorkspaces(filePath: string): RecentWorkspaceSummary[] {
  return readRecords(filePath)
    .filter(workspaceStillExists)
    .map((record) => ({ id: record.id, label: record.profile, target: record.target, lastUsedAt: record.lastUsedAt }));
}

export function resolveRecentWorkspace(filePath: string, id: string): Pick<RecentWorkspaceRecord, "txDataPath" | "profile" | "target"> {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Recent workspace id is invalid.");
  const record = readRecords(filePath).find((candidate) => candidate.id === id);
  if (!record || !workspaceStillExists(record)) throw new Error("That recent workspace is no longer available.");
  return { txDataPath: record.txDataPath, profile: record.profile, target: record.target };
}
