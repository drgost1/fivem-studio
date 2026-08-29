export interface DiscoveredWindowCandidate {
  id: string;
  hwndId: string;
  pid: number;
  processName: string;
  expiresAt: number;
}

export interface CurrentWindowIdentity {
  pid: number;
  processName: string;
}

/** Only Cfx client/bootstrap and game-render processes may enter the renderer-visible candidate list. */
export function isCfxClientProcessName(processName: string): boolean {
  return /^(fivem|gta5|redm|rdr2)/i.test(processName.trim());
}

/** Candidate IDs are renderer-safe handles; the HWND itself remains main-process-only. */
export function getFreshCandidate(
  candidates: ReadonlyMap<string, DiscoveredWindowCandidate>,
  id: string,
  now = Date.now(),
): DiscoveredWindowCandidate | null {
  const candidate = candidates.get(id);
  return candidate && candidate.expiresAt >= now ? candidate : null;
}

/** A window handle can be reused after a process exits, so PID alone is not enough. */
export function matchesDiscoveredWindow(
  candidate: DiscoveredWindowCandidate,
  current: CurrentWindowIdentity,
): boolean {
  return (
    current.pid === candidate.pid &&
    current.processName.trim().toLowerCase() === candidate.processName.trim().toLowerCase()
  );
}
