/** Network policy shared by config persistence and the MCP client.
 * FiveM Studio is intentionally a localhost development tool. */

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  );
}

export function parseLoopbackHttpUrl(value: string, label = "URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(
      `${label} must use a numeric loopback address (127.x.x.x or ::1). FiveM Studio does not resolve hostnames for local control paths.`,
    );
  }
  if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials.`);
  return url;
}

export function loopbackHttpUrlOr(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 2048) return fallback;
  try {
    return parseLoopbackHttpUrl(value, "MCP URL").toString();
  } catch {
    return fallback;
  }
}

/** Hosted model traffic must be encrypted. Plain HTTP is allowed only for a
 * model server on this machine (for example Ollama or LM Studio). */
export function parseProviderUrl(value: string, label = "Model provider URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials.`);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  throw new Error(`${label} must use HTTPS, unless it points to a model server on a numeric loopback address.`);
}

export function providerUrlOr(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 2048) return fallback;
  try {
    return parseProviderUrl(value).toString();
  } catch {
    return fallback;
  }
}
