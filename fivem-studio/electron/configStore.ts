// Tiny JSON config store — where QB Studio remembers the user's local
// workspace and client path between launches.
// Deliberately not using a dependency for this; it's ~20 lines of fs code.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { app, safeStorage } from "electron";
import { parseProviderUrl, providerUrlOr } from "./localUrl";

export interface StudioConfig {
  txDataPath: string | null; // path to the txAdmin txData folder (holds one subfolder per server profile)
  selectedProfile: string | null; // which txData/<profile> to browse/edit
  theme: ThemePreference;
  uiScale: number;
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
  notifyOnServerExit: boolean;
  discordPresenceEnabled: boolean;
  agentSpendWarningUsd: number;
  editor: EditorPreferences;
  // --- agent chat backend (no secrets here: this object is sent to the renderer) ---
  // "anthropic" uses the native Anthropic SDK; "openai" covers every
  // OpenAI-compatible endpoint — local runtimes and hosted providers alike.
  agentProvider: "anthropic" | "openai";
  openaiBaseUrl: string;
  openaiModel: string;
}

export interface EditorPreferences {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  formatOnSave: boolean;
  restartResourceOnSave: boolean;
  luaIntelligence: "off" | "balanced" | "full";
}

export type CfxTarget = "legacy" | "enhanced" | "redm";
export type BuiltInThemePreference = "system" | "dark" | "light" | "high-contrast";
export type ThemePreference = BuiltInThemePreference | `custom:${string}`;

export const CFX_TARGETS: readonly CfxTarget[] = ["legacy", "enhanced", "redm"];

const DEFAULTS: StudioConfig = {
  txDataPath: null,
  selectedProfile: null,
  theme: "system",
  uiScale: 1,
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
  notifyOnServerExit: true,
  discordPresenceEnabled: false,
  agentSpendWarningUsd: 5,
  editor: {
    fontSize: 13,
    wordWrap: false,
    minimap: false,
    stickyScroll: true,
    formatOnSave: false,
    restartResourceOnSave: false,
    luaIntelligence: "balanced",
  },
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
  const previous = loadConfig();
  if (
    providerCredentialStorageNames(previous.openaiBaseUrl).current !==
    providerCredentialStorageNames(normalized.openaiBaseUrl).current
  ) {
    // Attribute and consume any old slug while the previous persisted URL is
    // still authoritative. Once the config switches, a colliding new endpoint
    // must not be able to claim that legacy credential as its own.
    loadProviderKey(previous.openaiBaseUrl);
  }
  const target = configPath();
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), "utf8");
    const handle = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function themePreferenceOrDefault(value: unknown): ThemePreference {
  if (value === "system" || value === "dark" || value === "light" || value === "high-contrast") return value;
  if (typeof value === "string" && /^custom:[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value)) return value as ThemePreference;
  return DEFAULTS.theme;
}

const UI_SCALES = new Set([0.8, 0.9, 1, 1.1, 1.25, 1.5]);
const SPEND_WARNING_USD = new Set([0, 1, 2, 5, 10, 20]);

function uiScaleOrDefault(value: unknown): number {
  return typeof value === "number" && UI_SCALES.has(value) ? value : DEFAULTS.uiScale;
}

function spendWarningOrDefault(value: unknown): number {
  return typeof value === "number" && SPEND_WARNING_USD.has(value) ? value : DEFAULTS.agentSpendWarningUsd;
}

function editorPreferences(value: unknown): EditorPreferences {
  const raw = isRecord(value) ? value : {};
  const fontSize = typeof raw.fontSize === "number" && Number.isInteger(raw.fontSize) && raw.fontSize >= 11 && raw.fontSize <= 24
    ? raw.fontSize
    : DEFAULTS.editor.fontSize;
  return {
    fontSize,
    wordWrap: booleanOr(raw.wordWrap, DEFAULTS.editor.wordWrap),
    minimap: booleanOr(raw.minimap, DEFAULTS.editor.minimap),
    stickyScroll: booleanOr(raw.stickyScroll, DEFAULTS.editor.stickyScroll),
    formatOnSave: booleanOr(raw.formatOnSave, DEFAULTS.editor.formatOnSave),
    restartResourceOnSave: booleanOr(raw.restartResourceOnSave, DEFAULTS.editor.restartResourceOnSave),
    luaIntelligence:
      raw.luaIntelligence === "off" || raw.luaIntelligence === "full" ? raw.luaIntelligence : "balanced",
  };
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
    theme: themePreferenceOrDefault(raw.theme),
    uiScale: uiScaleOrDefault(raw.uiScale),
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
    notifyOnServerExit: booleanOr(raw.notifyOnServerExit, DEFAULTS.notifyOnServerExit),
    discordPresenceEnabled: booleanOr(raw.discordPresenceEnabled, DEFAULTS.discordPresenceEnabled),
    agentSpendWarningUsd: spendWarningOrDefault(raw.agentSpendWarningUsd),
    editor: editorPreferences(raw.editor),
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

function credentialCandidates(name: string, legacyNames: string[] = []): string[] {
  const directories = [app.getPath("userData"), ...previousProductUserDataPaths()];
  return [...new Set([
    ...directories.map((directory) => path.join(directory, `${name}-key.bin`)),
    ...legacyNames.flatMap((legacyName) => directories.map((directory) => path.join(directory, `${legacyName}-key.bin`))),
  ])];
}

/**
 * Keys are stored per endpoint, not one shared "the OpenAI key". Switching
 * provider (say Gemini -> Groq) would otherwise silently send the previous
 * provider's key and fail auth for no visible reason.
 */
function legacyEndpointSlug(baseUrl: string): string {
  const cleaned = baseUrl.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
  return `provider-${cleaned.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80) || "unset"}`;
}

/** Stable, collision-resistant credential identity. URL parsing canonicalizes
 * scheme/host casing, default ports and dot segments before the complete URL
 * (including its path) is hashed. */
export function providerCredentialStorageNames(baseUrl: string): { current: string; legacy: string } {
  const canonical = parseProviderUrl(baseUrl).toString();
  return {
    current: `provider-${createHash("sha256").update(canonical).digest("hex")}`,
    legacy: legacyEndpointSlug(canonical),
  };
}

/** The old truncated slug contains no endpoint identity, so it is only safe to
 * attribute to the endpoint currently persisted in Studio's config. Settings
 * drafts must never inherit or delete a colliding endpoint's legacy key. */
export function providerCredentialStorageAccess(
  requestedBaseUrl: string,
  persistedBaseUrl: string,
): { current: string; legacy: string | null } {
  const requested = providerCredentialStorageNames(requestedBaseUrl);
  const persisted = providerCredentialStorageNames(persistedBaseUrl);
  return {
    current: requested.current,
    legacy: requested.current === persisted.current ? requested.legacy : null,
  };
}

function currentProviderCredentialStorageAccess(baseUrl: string): { current: string; legacy: string | null } {
  return providerCredentialStorageAccess(baseUrl, loadConfig().openaiBaseUrl);
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

function loadCredential(name: string, legacyNames: string[] = []): string {
  const current = credentialPath(name);
  for (const candidate of credentialCandidates(name, legacyNames)) {
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
  const names = currentProviderCredentialStorageAccess(baseUrl);
  saveCredential(names.current, key);
  if (!key && names.legacy) {
    // Older builds would have cleared this slug. Preserve that behavior so a
    // deleted current-endpoint key cannot be resurrected by the compatibility
    // fallback. A draft endpoint is deliberately not allowed to remove it.
    saveCredential(names.legacy, "");
  }
}

export function loadProviderKey(baseUrl: string): string {
  const names = currentProviderCredentialStorageAccess(baseUrl);
  // Copy the legacy value only when the persisted endpoint establishes its
  // ownership. A Settings draft that happens to share the truncated slug must
  // require key re-entry instead of receiving another provider's credential.
  const value = loadCredential(names.current, names.legacy ? [names.legacy] : []);
  if (value && names.legacy) {
    // Migration is deliberately one-shot. Retaining an identity-free slug
    // would let a different endpoint claim it after a later config switch.
    saveCredential(names.legacy, "");
  }
  return value;
}

export function hasProviderKey(baseUrl: string): boolean {
  return loadProviderKey(baseUrl).length > 0;
}
