import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface WhatsNewState {
  previousVersion: string;
  currentVersion: string;
}

function validVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
}

function writeVersion(filePath: string, version: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

/** Records the current packaged version and reports only genuine upgrades, not fresh installs. */
export function consumeWhatsNew(filePath: string, currentVersionValue: string, packaged: boolean): WhatsNewState | null {
  const currentVersion = validVersion(currentVersionValue);
  if (!packaged || !currentVersion) return null;
  let previousVersion: string | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    previousVersion = validVersion(parsed?.version);
  } catch {
    // A missing/invalid record is a fresh baseline, not an upgrade.
  }
  writeVersion(filePath, currentVersion);
  return previousVersion && previousVersion !== currentVersion ? { previousVersion, currentVersion } : null;
}
