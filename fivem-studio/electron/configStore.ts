// Tiny JSON config store — where Ghz Workbench remembers the user's local
// workspace and client path between launches.
// Deliberately not using a dependency for this; it's ~20 lines of fs code.

import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { providerUrlOr } from "./localUrl";

export interface StudioConfig {
  txDataPath: string | null; // path to the txAdmin txData folder (holds one subfolder per server profile)
  selectedProfile: string | null; // which txData/<profile> to browse/edit
  activeCfxEdition: CfxEdition;
  legacyFivemExePath: string | null;
  enhancedFivemExePath: string | null;
  legacyFxServerExePath: string | null;
  enhancedFxServerExePath: string | null;
  legacyArtifactTrack: "recommended" | "latest";
  // --- agent chat backend (no secrets here: this object is sent to the renderer) ---
  // "anthropic" uses the native Anthropic SDK; "openai" covers every
  // OpenAI-compatible endpoint — local runtimes and hosted providers alike.
  agentProvider: "anthropic" | "openai";
  openaiBaseUrl: string;
  openaiModel: string;
}

export type CfxEdition = "legacy" | "enhanced";

const DEFAULTS: StudioConfig = {
  txDataPath: null,
  selectedProfile: null,
  activeCfxEdition: "legacy",
  legacyFivemExePath: null,
  enhancedFivemExePath: null,
  legacyFxServerExePath: null,
  enhancedFxServerExePath: null,
  legacyArtifactTrack: "recommended",
  // Defaults to Google's free tier rather than a paid key or a local model the
  // user may not have installed — the least-friction way to a working agent.
  agentProvider: "openai",
  openaiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openaiModel: "gemini-3.7-flash",
};

function configPath(): string {
  return path.join(app.getPath("userData"), "ghz-workbench.config.json");
}

function legacyConfigPath(): string {
  return path.join(app.getPath("userData"), "fivem-studio.config.json");
}

export function loadConfig(): StudioConfig {
  try {
    const target = fs.existsSync(configPath()) ? configPath() : legacyConfigPath();
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

/** A narrow runtime schema — TypeScript types do not validate IPC or disk data. */
export function normalizeConfig(value: unknown): StudioConfig {
  const raw = isRecord(value) ? value : {};
  const provider = raw.agentProvider === "anthropic" || raw.agentProvider === "openai" ? raw.agentProvider : DEFAULTS.agentProvider;
  // Migrate the original single client/server slots. A cfx-server.exe selection
  // unambiguously identifies Enhanced; older FXServer.exe settings are Legacy.
  const oldServerPath = nullablePath(raw.fxServerExePath);
  const inferredEdition: CfxEdition = oldServerPath?.toLowerCase().endsWith("cfx-server.exe") ? "enhanced" : "legacy";
  const activeCfxEdition: CfxEdition =
    raw.activeCfxEdition === "legacy" || raw.activeCfxEdition === "enhanced" ? raw.activeCfxEdition : inferredEdition;
  const oldClientPath = nullablePath(raw.fivemExePath);
  return {
    txDataPath: nullablePath(raw.txDataPath),
    selectedProfile: safeProfile(raw.selectedProfile),
    activeCfxEdition,
    legacyFivemExePath:
      nullablePath(raw.legacyFivemExePath) ?? (inferredEdition === "legacy" ? oldClientPath : null),
    enhancedFivemExePath:
      nullablePath(raw.enhancedFivemExePath) ?? (inferredEdition === "enhanced" ? oldClientPath : null),
    legacyFxServerExePath:
      nullablePath(raw.legacyFxServerExePath) ?? (inferredEdition === "legacy" ? oldServerPath : null),
    enhancedFxServerExePath:
      nullablePath(raw.enhancedFxServerExePath) ?? (inferredEdition === "enhanced" ? oldServerPath : null),
    legacyArtifactTrack:
      raw.legacyArtifactTrack === "latest" || raw.artifactTrack === "latest" ? "latest" : "recommended",
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
    fs.rmSync(target, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure OS credential storage is unavailable; refusing to save this credential in plaintext.");
  }
  fs.writeFileSync(target, safeStorage.encryptString(key));
}

function loadCredential(name: string): string {
  try {
    const raw = fs.readFileSync(credentialPath(name));
    const asText = raw.toString("utf8");
    // Migrate credentials written by early development builds, which used a
    // marked plaintext fallback when no keyring was detected.
    if (asText.startsWith("plain:")) {
      if (!safeStorage.isEncryptionAvailable()) return "";
      const value = asText.slice("plain:".length);
      fs.writeFileSync(credentialPath(name), safeStorage.encryptString(value));
      return value;
    }
    return safeStorage.decryptString(raw);
  } catch {
    return "";
  }
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
