import fs from "node:fs";
import path from "node:path";

import type { CfxTarget } from "./configStore";
import { resolveInsideRoot } from "./pathSafety";

export type DetectedClientInstalls = Record<CfxTarget, string | null>;

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
