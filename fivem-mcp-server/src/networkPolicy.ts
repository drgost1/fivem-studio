/** Network exposure rules for the HTTP MCP transport. Kept pure for tests. */

/** Numeric IPv4/IPv6 loopback literals only. Hostnames are never resolved. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  );
}

export function assertLoopbackHost(host: string, label: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error(`${label} must be a numeric loopback address (127.x.x.x or ::1). This server is for local development only.`);
  }
}

export function isSafeProfileName(profile: string): boolean {
  return profile.length > 0 && profile.length <= 255 && profile !== "." && profile !== ".." && !/[\\/\u0000-\u001f]/.test(profile);
}

export function assertSafeMcpExposure(host: string): void {
  assertLoopbackHost(host, "MCP_HOST");
}
