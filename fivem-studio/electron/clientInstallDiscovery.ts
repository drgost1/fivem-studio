import fs from "node:fs";
import path from "node:path";

import type { CfxTarget } from "./configStore";
import { resolveInsideRoot } from "./pathSafety";

export type DetectedClientInstalls = Record<CfxTarget, string | null>;
export type DetectedServerInstalls = Record<CfxTarget, string | null>;
export interface DetectedExecutableInstalls {
  clients: DetectedClientInstalls;
  servers: DetectedServerInstalls;
}

export interface ExecutableDiscoveryRoots {
  localAppData?: string | null;
  userProfile?: string | null;
  txDataPath?: string | null;
  artifactStatePaths?: Partial<Record<CfxTarget, string>>;
}

const CONVENTIONAL_CLIENT_PATHS: Record<CfxTarget, readonly string[]> = {
  legacy: [path.join("FiveM", "FiveM.exe")],
  enhanced: [
    path.join("FiveM Enhanced", "FiveM.exe"),
    path.join("FiveM for GTAV Enhanced", "FiveM.exe"),
    path.join("FiveM_GTA5_Enhanced", "FiveM.exe"),
    path.join("Cfx.re", "FiveM Enhanced", "FiveM.exe"),
  ],
  redm: [path.join("RedM", "RedM.exe")],
};

/** Probe only documented/conventional LocalAppData children. Custom locations
 * deliberately fall back to the native picker so discovery cannot become a
 * renderer-controlled filesystem probe. */
export function detectConventionalClientInstalls(localAppData: string): DetectedClientInstalls {
  const output: DetectedClientInstalls = { legacy: null, enhanced: null, redm: null };
  if (!localAppData || !path.isAbsolute(localAppData)) return output;
  let root: string;
  try {
    root = fs.realpathSync(localAppData);
    if (!fs.statSync(root).isDirectory()) return output;
  } catch {
    return output;
  }

  for (const target of ["legacy", "enhanced", "redm"] as const) {
    for (const relative of CONVENTIONAL_CLIENT_PATHS[target]) {
      try {
        const candidate = resolveInsideRoot(root, relative);
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const expectedName = target === "redm" ? "redm.exe" : "fivem.exe";
        if (path.basename(candidate).toLowerCase() !== expectedName) continue;
        output[target] = candidate;
        break;
      } catch {
        // Missing, linked, or inaccessible conventional candidate: Browse remains available.
      }
    }
  }
  return output;
}

const CONVENTIONAL_SERVER_FOLDERS: Record<CfxTarget, readonly string[]> = {
  legacy: ["FXServer", "FiveMServer", "FiveM Server", "fivem-server", "fivemserverlegacy", "FiveMServerLegacy"],
  enhanced: ["FiveMServerEnhanced", "fivemserverenhanced", "FiveM Server Enhanced", "cfx-server", "CfxServerEnhanced"],
  redm: ["RedMServer", "redmserver", "RedM Server", "redm-server"],
};

function ordinaryNamedFile(candidate: string, expectedName: string): string | null {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || path.basename(candidate).toLowerCase() !== expectedName.toLowerCase()) return null;
    const parent = fs.lstatSync(path.dirname(candidate));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return null;
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function ordinaryServerExecutable(candidate: string, expectedName: string): string | null {
  const executable = ordinaryNamedFile(candidate, expectedName);
  if (!executable) return null;
  const resources = expectedName.toLowerCase() === "cfx-server.exe"
    ? path.join(path.dirname(executable), "system_resources")
    : path.join(path.dirname(executable), "citizen", "system_resources");
  try {
    const stat = fs.lstatSync(resources);
    return stat.isDirectory() && !stat.isSymbolicLink() ? executable : null;
  } catch {
    return null;
  }
}

function serverFromArtifactState(statePath: string | undefined, target: CfxTarget): string | null {
  if (!statePath || !path.isAbsolute(statePath)) return null;
  try {
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    const executableName = target === "enhanced" ? "cfx-server.exe" : "FXServer.exe";
    if (raw.schemaVersion !== 1 || typeof raw.artifactRoot !== "string" || !path.isAbsolute(raw.artifactRoot) || raw.executableName !== executableName) return null;
    return ordinaryServerExecutable(path.join(raw.artifactRoot, executableName), executableName);
  } catch {
    return null;
  }
}

function safeRoot(value: string | null | undefined): string | null {
  if (!value || !path.isAbsolute(value)) return null;
  try {
    const root = fs.realpathSync.native(value);
    const stat = fs.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink() ? root : null;
  } catch {
    return null;
  }
}

/** Probe a fixed, small list of conventional folders plus QB Studio's own
 * artifact records. It intentionally never enumerates a drive or recursively
 * searches user-controlled roots. */
export function detectConventionalExecutables(roots: ExecutableDiscoveryRoots): DetectedExecutableInstalls {
  const clients = roots.localAppData ? detectConventionalClientInstalls(roots.localAppData) : { legacy: null, enhanced: null, redm: null };
  const servers: DetectedServerInstalls = { legacy: null, enhanced: null, redm: null };
  const candidates = new Set<string>();
  const userProfile = safeRoot(roots.userProfile);
  const localAppData = safeRoot(roots.localAppData);
  const txDataParent = roots.txDataPath && path.isAbsolute(roots.txDataPath) ? safeRoot(path.dirname(roots.txDataPath)) : null;
  for (const root of [userProfile, userProfile && path.join(userProfile, "Documents"), localAppData, txDataParent]) {
    const safe = safeRoot(root);
    if (safe) candidates.add(safe);
  }

  for (const target of ["legacy", "enhanced", "redm"] as const) {
    servers[target] = serverFromArtifactState(roots.artifactStatePaths?.[target], target);
    if (servers[target]) continue;
    const executableName = target === "enhanced" ? "cfx-server.exe" : "FXServer.exe";
    for (const root of candidates) {
      for (const folder of CONVENTIONAL_SERVER_FOLDERS[target]) {
        const found = ordinaryServerExecutable(path.join(root, folder, executableName), executableName);
        if (found) {
          servers[target] = found;
          break;
        }
      }
      if (servers[target]) break;
    }
  }
  return { clients, servers };
}
