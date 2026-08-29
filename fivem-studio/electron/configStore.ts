// Tiny JSON config store — where QB Studio remembers the user's local
// workspace and client path between launches.
// Deliberately not using a dependency for this; it's ~20 lines of fs code.

import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { providerUrlOr } from "./localUrl";

export interface StudioConfig {
  txDataPath: string | null; // path to the txAdmin txData folder (holds one subfolder per server profile)
  selectedProfile: string | null; // which txData/<profile> to browse/edit
  activeCfxTarget: CfxTarget;
  legacyFivemExePath: string | null;
  enhancedFivemExePath: string | null;
  redmClientExePath: string | null;
  legacyFxServerExePath: string | null;
  enhancedFxServerExePath: string | null;
  redmFxServerExePath: string | null;
  legacyArtifactTrack: "recommended" | "latest";
  redmArtifactTrack: "recommended" | "latest";
  consoleRefreshIntervalMs: number;
  // --- agent chat backend (no secrets here: this object is sent to the renderer) ---
  // "anthropic" uses the native Anthropic SDK; "openai" covers every
  // OpenAI-compatible endpoint — local runtimes and hosted providers alike.
  agentProvider: "anthropic" | "openai";
  openaiBaseUrl: string;
  openaiModel: string;
}

export type CfxTarget = "legacy" | "enhanced" | "redm";

export const CFX_TARGETS: readonly CfxTarget[] = ["legacy", "enhanced", "redm"];

const DEFAULTS: StudioConfig = {
  txDataPath: null,
  selectedProfile: null,
  activeCfxTarget: "legacy",
  legacyFivemExePath: null,
  enhancedFivemExePath: null,
  redmClientExePath: null,
  legacyFxServerExePath: null,
  enhancedFxServerExePath: null,
  redmFxServerExePath: null,
  legacyArtifactTrack: "recommended",
  redmArtifactTrack: "recommended",
  consoleRefreshIntervalMs: 2_000,
  // Defaults to Google's free tier rather than a paid key or a local model the
  // user may not have installed — the least-friction way to a working agent.
  agentProvider: "openai",
  openaiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openaiModel: "gemini-3.7-flash",
};

function configPath(): string {
  return path.join(app.getPath("userData"), "qb-studio.config.json");
}

function previousProductUserDataPaths(): string[] {
  return [
    path.join(app.getPath("appData"), "Ghz Workbench"),
    path.join(app.getPath("appData"), "ghz-workbench"),
  ];
}

function configCandidates(): string[] {
  return [...new Set([
    configPath(),
    path.join(app.getPath("userData"), "ghz-workbench.config.json"),
    path.join(app.getPath("userData"), "fivem-studio.config.json"),
    ...previousProductUserDataPaths().flatMap((directory) => [
      path.join(directory, "ghz-workbench.config.json"),
      path.join(directory, "fivem-studio.config.json"),
    ]),
  ])];
}

export function loadConfig(): StudioConfig {
  try {
    const target = configCandidates().find((candidate) => fs.existsSync(candidate));
    if (!target) return { ...DEFAULTS };
    const raw = fs.readFileSync(target, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

/** Validate untrusted renderer/config-file data and persist only public settings.
 * Credentials have a separate write-only store below. */
export function saveConfig(config: unknown): StudioConfig {
  const normalized = normalizeConfig(config);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(normalized, null, 2), "utf8");
  return loadConfig();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string, max = 2048): string {
  return typeof value === "string" && value.length <= max ? value : fallback;
}

function nullablePath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 32767 && path.isAbsolute(value) ? value : null;
}

function safeProfile(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 255 || value === "." || value === "..") return null;
  return path.basename(value) === value && !/[<>:"/\\|?*\u0000-\u001f]/.test(value) ? value : null;
}

const CONSOLE_REFRESH_INTERVALS = new Set([0, 1_000, 2_000, 5_000, 10_000, 30_000]);

function consoleRefreshIntervalOrDefault(value: unknown): number {
  return typeof value === "number" && CONSOLE_REFRESH_INTERVALS.has(value)
    ? value
    : DEFAULTS.consoleRefreshIntervalMs;
}

/** A narrow runtime schema — TypeScript types do not validate IPC or disk data. */
export function normalizeConfig(value: unknown): StudioConfig {
  const raw = isRecord(value) ? value : {};
  const provider = raw.agentProvider === "anthropic" || raw.agentProvider === "openai" ? raw.agentProvider : DEFAULTS.agentProvider;
  // Migrate the original single client/server slots. A cfx-server.exe selection
  // unambiguously identifies Enhanced; older FXServer.exe settings are Legacy.
  const oldServerPath = nullablePath(raw.fxServerExePath);
  const inferredTarget: CfxTarget = oldServerPath?.toLowerCase().endsWith("cfx-server.exe") ? "enhanced" : "legacy";
  // v1.1.5 stored only a Legacy/Enhanced edition. Preserve it while moving to
  // the wider target model that also includes RedM.
  const migratedEdition = raw.activeCfxEdition === "legacy" || raw.activeCfxEdition === "enhanced" ? raw.activeCfxEdition : null;
  const activeCfxTarget: CfxTarget =
    raw.activeCfxTarget === "legacy" || raw.activeCfxTarget === "enhanced" || raw.activeCfxTarget === "redm"
      ? raw.activeCfxTarget
      : (migratedEdition ?? inferredTarget);
  const oldClientPath = nullablePath(raw.fivemExePath);
  return {
    txDataPath: nullablePath(raw.txDataPath),
    selectedProfile: safeProfile(raw.selectedProfile),
    activeCfxTarget,
    legacyFivemExePath:
      nullablePath(raw.legacyFivemExePath) ?? (inferredTarget === "legacy" ? oldClientPath : null),
    enhancedFivemExePath:
      nullablePath(raw.enhancedFivemExePath) ?? (inferredTarget === "enhanced" ? oldClientPath : null),
    redmClientExePath: nullablePath(raw.redmClientExePath),
    legacyFxServerExePath:
      nullablePath(raw.legacyFxServerExePath) ?? (inferredTarget === "legacy" ? oldServerPath : null),
    enhancedFxServerExePath:
      nullablePath(raw.enhancedFxServerExePath) ?? (inferredTarget === "enhanced" ? oldServerPath : null),
    redmFxServerExePath: nullablePath(raw.redmFxServerExePath),
    legacyArtifactTrack:
      raw.legacyArtifactTrack === "latest" || raw.artifactTrack === "latest" ? "latest" : "recommended",
    redmArtifactTrack: raw.redmArtifactTrack === "latest" ? "latest" : "recommended",
    consoleRefreshIntervalMs: consoleRefreshIntervalOrDefault(raw.consoleRefreshIntervalMs),
    agentProvider: provider,
    openaiBaseUrl: providerUrlOr(raw.openaiBaseUrl, DEFAULTS.openaiBaseUrl),
    openaiModel: stringOr(raw.openaiModel, DEFAULTS.openaiModel, 256),
  };
}

// --- API keys ---
// Deliberately stored outside StudioConfig: that object is handed to the renderer
// on every config:get, and a credential has no business crossing into a browser
// context. These live main-process-only — the renderer can set one and ask whether
// it exists, but can never read it back.
//
// Encrypted at rest with Electron's safeStorage (DPAPI on Windows, Keychain on
// macOS, libsecret on Linux) rather than sitting in plaintext next to the config.

function credentialPath(name: string): string {
  return path.join(app.getPath("userData"), `${name}-key.bin`);
}

function credentialCandidates(name: string): string[] {
  return [...new Set([
    credentialPath(name),
    ...previousProductUserDataPaths().map((directory) => path.join(directory, `${name}-key.bin`)),
  ])];
}

/**
 * Keys are stored per endpoint, not one shared "the OpenAI key". Switching
 * provider (say Gemini -> Groq) would otherwise silently send the previous
 * provider's key and fail auth for no visible reason.
 */
function endpointSlug(baseUrl: string): string {
  const cleaned = baseUrl.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
  return `provider-${cleaned.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80) || "unset"}`;
}

function saveCredential(name: string, key: string): void {
  const target = credentialPath(name);
  if (!key) {
    for (const candidate of credentialCandidates(name)) fs.rmSync(candidate, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure OS credential storage is unavailable; refusing to save this credential in plaintext.");
  }
  fs.writeFileSync(target, safeStorage.encryptString(key));
}

function loadCredential(name: string): string {
  const current = credentialPath(name);
  for (const candidate of credentialCandidates(name)) {
    try {
      const raw = fs.readFileSync(candidate);
      const asText = raw.toString("utf8");
      // Migrate credentials written by early development builds, which used a
      // marked plaintext fallback when no keyring was detected.
      const value = asText.startsWith("plain:")
        ? (safeStorage.isEncryptionAvailable() ? asText.slice("plain:".length) : "")
        : safeStorage.decryptString(raw);
      if (!value) return "";
      if ((candidate !== current || asText.startsWith("plain:")) && safeStorage.isEncryptionAvailable()) {
        fs.mkdirSync(path.dirname(current), { recursive: true });
        fs.writeFileSync(current, safeStorage.encryptString(value));
      }
      return value;
    } catch {
      // Try the previous product directory before treating the key as absent.
    }
  }
  return "";
}

export function saveApiKey(key: string): void {
  saveCredential("anthropic", key);
}

export function loadApiKey(): string {
  return loadCredential("anthropic");
}

export function hasApiKey(): boolean {
  return loadApiKey().length > 0;
}

// Callers pass the endpoint explicitly so Settings can read/write the key for a
// provider the user has selected but not saved yet.
export function saveProviderKey(baseUrl: string, key: string): void {
  saveCredential(endpointSlug(baseUrl), key);
}

export function loadProviderKey(baseUrl: string): string {
  return loadCredential(endpointSlug(baseUrl));
}

export function hasProviderKey(baseUrl: string): boolean {
  return loadProviderKey(baseUrl).length > 0;
}
