import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import {
  loadConfig,
  saveConfig,
  saveApiKey,
  hasApiKey,
  saveProviderKey,
  hasProviderKey,
  CFX_TARGETS,
  type CfxTarget,
  type StudioConfig,
  type ThemePreference,
} from "./configStore";
import * as agent from "./agent";
import { listDir, readTextFileSnapshot, writeTextFile, renamePath, listProfiles, resolveProfile } from "./fsTree";
import { watchPath, stopWatching } from "./fsWatch";
import {
  mcpConnect,
  mcpDisconnect,
  mcpCallTool,
  mcpIsConnected,
  mcpConnectedUrl,
  mcpRuntimeIdentity,
  mcpRuntimeWorkspaceMatch,
  mcpListResourceStatuses,
  setOnDropped,
} from "./mcpClient";
import { fetchRepoInfo, searchGithubRepos, listGithubOrganizationRepos, cloneRepo } from "./githubClient";
import * as windowEmbed from "./windowEmbed";
import { setEditorContext, setOnFileWritten, setProjectRevertStore, type EditorContext } from "./projectTools";
import { assertSafeBasename, contains, resolveInsideRoot } from "./pathSafety";
import { resolveToolApproval } from "./toolApproval";
import {
  applyDevelopmentRcon,
  createLocalWorkspace,
  previewDevelopmentRcon,
} from "./workspaceCreator";
import {
  discoverTxAdminControlProfile,
  ensureManagedRuntime,
  loadLocalServerConfig,
  parseLocalServerConfig,
  stopManagedRuntime,
} from "./managedRuntime";
import { parseProviderUrl } from "./localUrl";
import { OperationLock } from "./operationLock";
import { LuaLanguageServerProcess, type JsonRpcMessage } from "./luaLanguageServer";
import {
  checkArtifactUpdate,
  findRunningServerPids,
  installArtifactUpdate,
  launchLocalServer,
  recoverInterruptedArtifactUpdate,
  resolveArtifactTarget,
  stopLocalServer,
  type ArtifactTrack,
} from "./serverArtifacts";
import { checkForAppUpdate } from "./appUpdate";
import { resourceAtDirectory, resolveResourceContext } from "./resourceContext";
import { RevertStore, type RevertMode } from "./revertStore";
import { detectConventionalClientInstalls } from "./clientInstallDiscovery";

let mainWindow: BrowserWindow | null = null;
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

// How many editor tabs currently hold unsaved edits, pushed from the renderer —
// used to guard against quitting Studio and silently losing them.
let dirtyFileCount = 0;
let allowCloseWithUnsavedChanges = false;
// A folder becomes eligible for profile discovery only after the native picker
// returned it. This prevents the renderer from turning discovery into an
// arbitrary-directory listing API.
let pendingTxDataPath: string | null = null;
const pendingClientExePaths: Record<CfxTarget, string | null> = { legacy: null, enhanced: null, redm: null };
const pendingFxServerExePaths: Record<CfxTarget, string | null> = { legacy: null, enhanced: null, redm: null };
let artifactRecoveryNotice: string | null = null;
const serverOperation = new OperationLock();
const luaLanguageServer = new LuaLanguageServerProcess();
let revertStore: RevertStore | null = null;

// The renderer only receives the coding-oriented runtime controls it renders.
// Gameplay/admin tooling is deliberately not exposed through this generic bridge.
const RENDERER_MCP_TOOLS = new Set([
  "get_console_output",
  "list_resources",
  "start_resource",
  "stop_resource",
  "restart_resource",
]);

function requireString(value: unknown, label: string, maxLength = 32767): string {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${label} must be a string up to ${maxLength} characters.`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function requireRevertStore(): RevertStore {
  if (!revertStore) throw new Error("Undo history is not ready yet.");
  return revertStore;
}

function requireRevertMode(value: unknown): RevertMode {
  if (value !== "all" && value !== "safe") throw new Error("Undo mode must be 'all' or 'safe'.");
  return value;
}

function isRegularUnlinkedFile(filePath: string | null): boolean {
  if (!filePath) return false;
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function selectedProfileRoot(txDataValue: unknown, profileValue: unknown): { txDataPath: string; profileRoot: string } {
  const txDataPath = scopedTxDataPath(txDataValue);
  const profile = assertSafeBasename(requireString(profileValue, "Profile", 255));
  const profileRoot = resolveInsideRoot(txDataPath, profile);
  const stat = fs.lstatSync(profileRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The selected workspace must be a real directory.");
  return { txDataPath, profileRoot };
}

function workspaceHasRconPassword(profileRoot: string): boolean {
  try {
    return Boolean(parseLocalServerConfig(loadLocalServerConfig(profileRoot)).rconPassword);
  } catch {
    // A missing include or endpoint should not hide a direct credential when
    // deciding whether rotation needs explicit confirmation.
    let visible = "";
    for (const name of ["server.cfg", "secrets.cfg"]) {
      try { visible += `\n${fs.readFileSync(resolveInsideRoot(profileRoot, name), "utf8")}`; } catch { /* absent/inaccessible */ }
    }
    return /^\s*(?:set\s+)?rcon_password\s+.+$/im.test(visible);
  }
}

function requireJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LuaLS message must be an object.");
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") throw new Error("LuaLS message must use JSON-RPC 2.0.");
  if (typeof message.method === "string" && message.method.length > 256) throw new Error("LuaLS method name is too long.");
  if (Buffer.byteLength(JSON.stringify(message)) > 8 * 1024 * 1024) throw new Error("LuaLS message is too large.");
  return message;
}

function activeProfileRoot(): string {
  const config = loadConfig();
  if (!config.txDataPath || !config.selectedProfile) throw new Error("Choose a txData folder and server profile first.");
  const profile = assertSafeBasename(config.selectedProfile);
  const root = resolveInsideRoot(config.txDataPath, profile);
  if (!fs.existsSync(root)) throw new Error("The selected server profile no longer exists.");
  return root;
}

function activeResourcesRoot(): string {
  const config = loadConfig();
  const root = activeProfileRoot();
  const resources = resolveProfile(config.txDataPath!, config.selectedProfile!).resourcesPath;
  if (!resources) throw new Error("The selected profile has no resources folder.");
  return resources;
}

function scopedProfilePath(value: unknown): string {
  const root = activeProfileRoot();
  const requested = requireString(value, "Path");
  return resolveInsideRoot(root, path.relative(root, requested));
}

function listProfileDirectory(value: unknown) {
  const target = scopedProfilePath(value);
  const entries = listDir(target);
  let resourcesRoot: string;
  try {
    resourcesRoot = activeResourcesRoot();
  } catch {
    return entries;
  }
  return entries.map((entry) => {
    if (!entry.isDirectory || !contains(resourcesRoot, entry.path)) return entry;
    const context = resourceAtDirectory(resourcesRoot, entry.path);
    return context ? { ...entry, resourceName: context.name } : entry;
  });
}

function activeResourceContext(value: unknown) {
  const target = scopedProfilePath(value);
  const resourcesRoot = activeResourcesRoot();
  return contains(resourcesRoot, target) ? resolveResourceContext(resourcesRoot, target) : null;
}

function allowedExternalUrl(value: unknown): string {
  const raw = requireString(value, "URL", 4096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid external URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) external URLs are allowed.");
  return url.toString();
}

function scopedTxDataPath(value: unknown): string {
  const requested = requireString(value, "txData path");
  const current = loadConfig().txDataPath;
  if (requested !== current && requested !== pendingTxDataPath) {
    throw new Error("Choose the txData folder using Browse before accessing it.");
  }
  return requested;
}

function requireCfxTarget(value: unknown): CfxTarget {
  if (value !== "legacy" && value !== "enhanced" && value !== "redm") {
    throw new Error("Cfx.re target must be FiveM Legacy, FiveM Enhanced, or RedM.");
  }
  return value;
}

function cfxTargetLabel(target: CfxTarget): string {
  if (target === "legacy") return "FiveM Legacy";
  if (target === "enhanced") return "FiveM Enhanced";
  return "RedM";
}

function clientExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFivemExePath;
  if (target === "enhanced") return config.enhancedFivemExePath;
  return config.redmClientExePath;
}

function serverExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFxServerExePath;
  if (target === "enhanced") return config.enhancedFxServerExePath;
  return config.redmFxServerExePath;
}

function scopedClientExe(value: unknown, target: CfxTarget): string | null {
  if (value === null || value === undefined || value === "") return null;
  const requested = requireString(value, `${cfxTargetLabel(target)} executable`);
  const current = clientExeFor(loadConfig(), target);
  if (requested !== current && requested !== pendingClientExePaths[target]) {
    throw new Error(`Choose the ${cfxTargetLabel(target)} client executable using Browse before saving it.`);
  }
  return requested;
}

function scopedFxServerExe(value: unknown, target: CfxTarget, txDataPath?: string | null): string | null {
  if (value === null || value === undefined || value === "") return null;
  const requested = requireString(value, "Local server executable");
  const current = serverExeFor(loadConfig(), target);
  if (requested !== current && requested !== pendingFxServerExePaths[target]) {
    throw new Error(`Choose the ${cfxTargetLabel(target)} local server executable using Browse before saving it.`);
  }
  const artifact = resolveArtifactTarget(requested, txDataPath);
  const expectedFlavor = target === "enhanced" ? "enhanced" : "legacy";
  if (artifact.flavor !== expectedFlavor) {
    throw new Error(
      target === "enhanced"
        ? "The FiveM Enhanced server path must point to cfx-server.exe."
        : `The ${cfxTargetLabel(target)} server path must point to FXServer.exe.`,
    );
  }
  return requested;
}

function requireArtifactTrack(value: unknown): ArtifactTrack {
  if (value !== "recommended" && value !== "latest") throw new Error("Artifact track must be recommended or latest.");
  return value;
}

function artifactStatePath(target: CfxTarget): string {
  return path.join(app.getPath("userData"), `artifact-install-${target}.json`);
}

function resolvedSystemTheme(): "dark" | "light" {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function applyNativeTheme(theme: ThemePreference): void {
  nativeTheme.themeSource = theme === "system" ? "system" : theme === "light" ? "light" : "dark";
  const resolved = theme === "system" ? resolvedSystemTheme() : theme;
  mainWindow?.setBackgroundColor(resolved === "light" ? "#F7F5F2" : "#101317");
}

function createWindow() {
  const configuredTheme = loadConfig().theme;
  const windowTheme = configuredTheme === "system" ? resolvedSystemTheme() : configuredTheme;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "QB Studio",
    backgroundColor: windowTheme === "light" ? "#F7F5F2" : "#101317",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  const allowedNavigation = (target: string) => {
    if (devUrl) {
      try {
        return new URL(target).origin === new URL(devUrl).origin;
      } catch {
        return false;
      }
    }
    return target === mainWindow?.webContents.getURL();
  };
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Only pop the DevTools window open when explicitly asked for (OPEN_DEVTOOLS=1) -
  // running via `npm run dev` / start.bat should look like a normal app, not a
  // developer build. Ctrl+Shift+I still works on demand (bound below) since removing
  // the default menu below takes that binding away otherwise.
  if (process.env.OPEN_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.control && input.shift && input.key.toUpperCase() === "I") {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // Re-focus the embedded FiveM window whenever Studio itself regains OS focus (e.g. alt-tabbing
  // back from another app) — GTA5 pauses/blanks its rendering while unfocused, and a plain window
  // activation like this doesn't otherwise reach a reparented child window belonging to another process.
  mainWindow.on("focus", () => windowEmbed.onHostFocusGained());

  mainWindow.on("close", (event) => {
    if (allowCloseWithUnsavedChanges || dirtyFileCount === 0 || !mainWindow) return;
    event.preventDefault();
    const plural = dirtyFileCount === 1 ? "file has" : "files have";
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["Discard changes and close", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: `${dirtyFileCount} ${plural} unsaved changes.`,
      detail: "Closing QB Studio now will discard them.",
    });
    if (choice === 0) {
      allowCloseWithUnsavedChanges = true;
      mainWindow.close();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Tell the renderer when the MCP transport drops on its own, so the status pill
// doesn't sit on a stale "Connected" until the next tool call fails.
setOnDropped(() => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mcp:dropped");
});

// When the agent edits a file, tell the renderer so an open editor buffer doesn't
// go stale — otherwise the user's next Ctrl+S silently reverts the agent's work.
setOnFileWritten((absolutePath) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("project:fileWritten", absolutePath);
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  // The default File/Edit/View/Window/Help menu is generic Electron boilerplate —
  // Studio has its own branded toolbar (TopBar) providing the equivalent actions,
  // so the native menu bar is just redundant chrome sitting above it.
  Menu.setApplicationMenu(null);

  const startupConfig = loadConfig();
  applyNativeTheme(startupConfig.theme);
  nativeTheme.on("updated", () => {
    const systemTheme = resolvedSystemTheme();
    if (loadConfig().theme === "system") mainWindow?.setBackgroundColor(systemTheme === "light" ? "#F7F5F2" : "#101317");
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("theme:systemChanged", systemTheme);
  });
  const recoveryNotices: string[] = [];
  for (const target of CFX_TARGETS) {
    const executable = serverExeFor(startupConfig, target);
    if (!executable) continue;
    try {
      const notice = recoverInterruptedArtifactUpdate(executable, artifactStatePath(target));
      if (notice) recoveryNotices.push(`${cfxTargetLabel(target)}: ${notice}`);
    } catch (error) {
      recoveryNotices.push(`${cfxTargetLabel(target)} artifact recovery needs attention: ${(error as Error).message}`);
    }
  }
  artifactRecoveryNotice = recoveryNotices.length > 0 ? recoveryNotices.join(" ") : null;

  revertStore = new RevertStore(path.join(app.getPath("userData"), "revert-store"));
  setProjectRevertStore(revertStore);

  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  agent.cancelTurn();
  mcpDisconnect();
  stopWatching();
  windowEmbed.detach();
  stopManagedRuntime();
  luaLanguageServer.stop();
  if (process.platform !== "darwin") app.quit();
});

function registerIpcHandlers() {
  // --- config ---
  ipcMain.handle("config:get", () => loadConfig());
  ipcMain.handle("config:set", (_e, config: unknown) =>
    serverOperation.run("the Settings change", async () => {
      if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("Configuration must be an object.");
      const candidate = config as Record<string, unknown>;
      const previous = loadConfig();
      const switchingProfile =
        candidate.txDataPath !== previous.txDataPath || candidate.selectedProfile !== previous.selectedProfile;
      if (switchingProfile) {
        agent.resetConversation();
        await mcpDisconnect();
        stopManagedRuntime();
        luaLanguageServer.stop();
      }
      if (candidate.txDataPath !== null && candidate.txDataPath !== undefined) scopedTxDataPath(candidate.txDataPath);
      if (typeof candidate.openaiBaseUrl === "string") parseProviderUrl(candidate.openaiBaseUrl);
      requireCfxTarget(candidate.activeCfxTarget);
      scopedClientExe(candidate.legacyFivemExePath, "legacy");
      scopedClientExe(candidate.enhancedFivemExePath, "enhanced");
      scopedClientExe(candidate.redmClientExePath, "redm");
      const txDataPath = typeof candidate.txDataPath === "string" ? candidate.txDataPath : null;
      scopedFxServerExe(candidate.legacyFxServerExePath, "legacy", txDataPath);
      scopedFxServerExe(candidate.enhancedFxServerExePath, "enhanced", txDataPath);
      scopedFxServerExe(candidate.redmFxServerExePath, "redm", txDataPath);
      const saved = saveConfig(config);
      applyNativeTheme(saved.theme);
      return saved;
    }),
  );
  ipcMain.handle("theme:system", () => resolvedSystemTheme());

  // --- conventional local client discovery and setup diagnostics ---
  ipcMain.handle("installs:detectClients", () => {
    const localAppData = process.env.LOCALAPPDATA;
    const detected = localAppData && path.isAbsolute(localAppData)
      ? detectConventionalClientInstalls(localAppData)
      : { legacy: null, enhanced: null, redm: null };
    for (const target of CFX_TARGETS) {
      if (detected[target]) pendingClientExePaths[target] = detected[target];
    }
    return detected;
  });

  ipcMain.handle(
    "setup:diagnostics",
    (_e, txDataValue: unknown, profileValue: unknown, targetValue: unknown, clientValue: unknown, serverValue: unknown) => {
      const target = requireCfxTarget(targetValue);
      let txDataRoot = false;
      let workspace = false;
      let txAdminAttachment = false;
      let rconCapability = false;
      let txDataPath: string | null = null;
      let profileRoot: string | null = null;
      try {
        if (txDataValue) {
          txDataPath = scopedTxDataPath(txDataValue);
          const stat = fs.lstatSync(txDataPath);
          txDataRoot = stat.isDirectory() && !stat.isSymbolicLink();
        }
        if (txDataRoot && profileValue) {
          ({ profileRoot } = selectedProfileRoot(txDataPath, profileValue));
          const resolved = resolveProfile(txDataPath!, path.basename(profileRoot));
          workspace = Boolean(resolved.serverCfgPath && resolved.resourcesPath);
        }
        if (workspace && txDataPath && profileRoot) {
          txAdminAttachment = discoverTxAdminControlProfile(txDataPath, profileRoot) !== null;
          const parsed = parseLocalServerConfig(loadLocalServerConfig(profileRoot));
          rconCapability = Boolean(parsed.rconPassword);
        }
      } catch {
        // Individual false checks below are actionable; setup remains usable.
      }

      let clientExecutable = false;
      let serverExecutable = false;
      try { clientExecutable = isRegularUnlinkedFile(scopedClientExe(clientValue, target)); } catch { /* untrusted/stale draft */ }
      try { serverExecutable = isRegularUnlinkedFile(scopedFxServerExe(serverValue, target, txDataPath)); } catch { /* untrusted/stale draft */ }
      const git = (() => {
        try {
          const result = spawnSync("git", ["--version"], { shell: false, windowsHide: true, encoding: "utf8", timeout: 2_000 });
          return result.status === 0 && /^git version\s+/i.test(result.stdout.trim());
        } catch {
          return false;
        }
      })();

      return { txDataRoot, workspace, serverExecutable, clientExecutable, txAdminAttachment, rconCapability, git };
    },
  );

  // --- bounded programmatic-write undo history ---
  ipcMain.handle("revert:list", () => requireRevertStore().listBatches(activeResourcesRoot()));
  ipcMain.handle("revert:apply", (_e, batchId: unknown, mode: unknown) => {
    const result = requireRevertStore().revertBatch(
      activeResourcesRoot(),
      requireString(batchId, "Undo batch id", 128),
      requireRevertMode(mode),
    );
    for (const relativePath of result.reverted) {
      const absolutePath = resolveInsideRoot(activeResourcesRoot(), relativePath);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("project:fileWritten", absolutePath);
    }
    return result;
  });

  // --- filesystem / resource tree ---
  ipcMain.handle("fs:listDir", (_e, dirPath: unknown) => listProfileDirectory(dirPath));
  ipcMain.handle("fs:readFile", (_e, filePath: unknown) => readTextFileSnapshot(scopedProfilePath(filePath)));
  ipcMain.handle("fs:writeFile", (_e, filePath: unknown, content: unknown, expectedRevision: unknown) =>
    writeTextFile(
      scopedProfilePath(filePath),
      requireString(content, "File content", 8 * 1024 * 1024),
      requireString(expectedRevision, "Expected file revision", 128),
    ),
  );
  ipcMain.handle("fs:rename", (_e, oldPath: unknown, newName: unknown) => {
    const oldTarget = scopedProfilePath(oldPath);
    const name = assertSafeBasename(requireString(newName, "New name", 255));
    const newTarget = resolveInsideRoot(path.dirname(oldTarget), name);
    // Parent remains in the active profile root; resolve again to catch links.
    resolveInsideRoot(activeProfileRoot(), path.relative(activeProfileRoot(), newTarget));
    return renamePath(oldTarget, name);
  });
  ipcMain.handle("fs:delete", async (_e, targetPath: unknown) => {
    const target = scopedProfilePath(targetPath);
    await shell.trashItem(target);
  });
  ipcMain.handle("fs:watchRoot", (_e, _dirPath: unknown) => {
    if (!mainWindow) return;
    try {
      watchPath(activeProfileRoot(), mainWindow);
    } catch {
      stopWatching();
    }
  });

  // --- txData / server profile discovery ---
  ipcMain.handle("txdata:listProfiles", (_e, txDataPath: unknown) => listProfiles(scopedTxDataPath(txDataPath)));
  ipcMain.handle("txdata:resolveProfile", (_e, txDataPath: unknown, profile: unknown) =>
    resolveProfile(scopedTxDataPath(txDataPath), assertSafeBasename(requireString(profile, "Profile", 255))),
  );
  ipcMain.handle("txdata:createLocalWorkspace", (_e, txDataPath: unknown, name: unknown, port: unknown, target: unknown) =>
    createLocalWorkspace(
      scopedTxDataPath(txDataPath),
      requireString(name, "Workspace name", 255),
      requireFiniteNumber(port, "Local server port"),
      requireCfxTarget(target),
    ),
  );
  ipcMain.handle("txdata:previewDevelopmentRcon", (_e, txDataPath: unknown, profile: unknown) => {
    const selected = selectedProfileRoot(txDataPath, profile);
    return previewDevelopmentRcon(selected.profileRoot, workspaceHasRconPassword(selected.profileRoot));
  });
  ipcMain.handle("txdata:applyDevelopmentRcon", (_e, txDataPath: unknown, profile: unknown, allowOverwrite: unknown) =>
    serverOperation.run("local RCON setup", async () => {
      if (typeof allowOverwrite !== "boolean") throw new Error("RCON replacement confirmation must be a boolean.");
      const selected = selectedProfileRoot(txDataPath, profile);
      const hasExistingPassword = workspaceHasRconPassword(selected.profileRoot);
      const result = applyDevelopmentRcon(selected.profileRoot, hasExistingPassword, allowOverwrite);
      try { await mcpDisconnect(); } catch { /* the on-disk setup succeeded; a stale runtime is stopped below */ }
      stopManagedRuntime();
      return result;
    }),
  );

  ipcMain.handle("dialog:chooseFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled) return null;
    pendingTxDataPath = result.filePaths[0];
    return pendingTxDataPath;
  });

  ipcMain.handle("dialog:chooseExe", async (_e, targetValue: unknown) => {
    const target = requireCfxTarget(targetValue);
    const filters =
      process.platform === "win32" ? [{ name: "Executable", extensions: ["exe"] }] : [{ name: "All files", extensions: ["*"] }];
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    const expectedName = target === "redm" ? "redm.exe" : "fivem.exe";
    if (process.platform === "win32" && path.basename(selected).toLowerCase() !== expectedName) {
      throw new Error(`Choose ${target === "redm" ? "RedM.exe" : "FiveM.exe"} for ${cfxTargetLabel(target)}.`);
    }
    pendingClientExePaths[target] = selected;
    return pendingClientExePaths[target];
  });

  ipcMain.handle("dialog:chooseFxServerExe", async (_e, targetValue: unknown) => {
    const target = requireCfxTarget(targetValue);
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Cfx.re server executable", extensions: ["exe"] }],
    });
    if (result.canceled) return null;
    const artifactTarget = resolveArtifactTarget(result.filePaths[0], null);
    const expectedFlavor = target === "enhanced" ? "enhanced" : "legacy";
    if (artifactTarget.flavor !== expectedFlavor) {
      throw new Error(
        target === "enhanced"
          ? "Choose cfx-server.exe for the FiveM Enhanced server."
          : `Choose FXServer.exe for the ${cfxTargetLabel(target)} server.`,
      );
    }
    pendingFxServerExePaths[target] = result.filePaths[0];
    return pendingFxServerExePaths[target];
  });

  // --- bundled coding runtime ---
  ipcMain.handle("mcp:connect", async () => {
    const managed = await ensureManagedRuntime(loadConfig());
    return mcpConnect(managed.url, managed.token, managed.serverIdentity);
  });
  ipcMain.handle("mcp:disconnect", () => mcpDisconnect());
  ipcMain.handle("mcp:status", () => ({
    connected: mcpIsConnected(),
    url: mcpConnectedUrl(),
    runtimeIdentity: mcpRuntimeIdentity(),
    workspaceMatch: mcpRuntimeWorkspaceMatch(),
  }));
  ipcMain.handle("mcp:callTool", (_e, name: unknown, args: unknown) => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
    const toolName = requireString(name, "Tool name", 256);
    if (!RENDERER_MCP_TOOLS.has(toolName)) throw new Error(`The QB Studio UI is not allowed to invoke ${toolName}.`);
    return mcpCallTool(toolName, args as Record<string, unknown>);
  });
  ipcMain.handle("resources:listStatuses", () => mcpListResourceStatuses());
  ipcMain.handle("resources:context", (_e, filePath: unknown) => activeResourceContext(filePath));

  // --- GitHub import ---
  ipcMain.handle("github:fetchRepoInfo", (_e, input: unknown) => fetchRepoInfo(requireString(input, "GitHub repository", 2048)));
  ipcMain.handle("github:searchRepos", (_e, input: unknown) => searchGithubRepos(requireString(input, "GitHub search", 128)));
  ipcMain.handle("github:listOrgRepos", (_e, input: unknown) =>
    listGithubOrganizationRepos(requireString(input, "GitHub organization", 128)),
  );
  ipcMain.handle("github:cloneRepo", (_e, repoUrl: unknown, _projectRoot: unknown) =>
    cloneRepo(requireString(repoUrl, "GitHub repository", 2048), activeResourcesRoot()),
  );

  // --- launch the selected FiveM or RedM client, in its own window ---
  ipcMain.handle("cfx:launch", (_e, targetValue: unknown) => {
    const target = requireCfxTarget(targetValue);
    const configured = clientExeFor(loadConfig(), target);
    if (!configured) throw new Error(`Choose the ${cfxTargetLabel(target)} client executable in Settings first.`);
    if (process.platform === "win32" && path.extname(configured).toLowerCase() !== ".exe") {
      throw new Error("Cfx.re client executable must be an .exe file.");
    }
    spawn(configured, [], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, target };
  });

  // --- local Cfx.re server launch and artifact maintenance ---
  ipcMain.handle("server:status", async () => {
    const config = loadConfig();
    const ordered = [config.activeCfxTarget, ...CFX_TARGETS.filter((target) => target !== config.activeCfxTarget)];
    for (const target of ordered) {
      const executable = serverExeFor(config, target);
      if (!executable) continue;
      const artifact = resolveArtifactTarget(executable, config.txDataPath);
      const pids = await findRunningServerPids(artifact.executablePath);
      if (pids.length > 0) return { running: true, pids, target };
    }
    return { running: false, pids: [], target: config.activeCfxTarget };
  });

  ipcMain.handle("server:launch", () =>
    serverOperation.run("the local server start", async () => {
      const config = loadConfig();
      const target = config.activeCfxTarget;
      const executable = serverExeFor(config, target);
      if (!executable) throw new Error(`Choose the ${cfxTargetLabel(target)} server executable in Settings first.`);
      if (!config.txDataPath || !config.selectedProfile) throw new Error("Choose a txData workspace in Settings first.");
      for (const otherTargetName of CFX_TARGETS) {
        if (otherTargetName === target) continue;
        const otherExecutable = serverExeFor(config, otherTargetName);
        if (!otherExecutable || path.resolve(otherExecutable).toLowerCase() === path.resolve(executable).toLowerCase()) continue;
        const otherTarget = resolveArtifactTarget(otherExecutable, config.txDataPath);
        const otherPids = await findRunningServerPids(otherTarget.executablePath);
        if (otherPids.length > 0) {
          throw new Error(
            `Stop the ${cfxTargetLabel(otherTargetName)} server before starting the ${cfxTargetLabel(target)} server on this workspace.`,
          );
        }
      }
      const workspaceRoot = activeProfileRoot();
      const controlProfile = discoverTxAdminControlProfile(config.txDataPath, workspaceRoot);
      const recoveryNotice = recoverInterruptedArtifactUpdate(executable, artifactStatePath(target));
      const launched = await launchLocalServer(executable, config.txDataPath, controlProfile);
      return { ...launched, target, recoveryNotice: recoveryNotice ?? undefined };
    }),
  );

  ipcMain.handle("server:stop", (_e, targetValue: unknown) =>
    serverOperation.run("the local server stop", async () => {
      const target = requireCfxTarget(targetValue);
      const config = loadConfig();
      const executable = serverExeFor(config, target);
      if (!executable) throw new Error(`Choose the ${cfxTargetLabel(target)} server executable in Settings first.`);
      return { ...(await stopLocalServer(executable, config.txDataPath)), target };
    }),
  );

  ipcMain.handle("artifacts:check", (_e, targetValue: unknown, track: unknown) =>
    serverOperation.run("the server artifact check", async () => {
      const target = requireCfxTarget(targetValue);
      const config = loadConfig();
      const executable = serverExeFor(config, target);
      if (!executable) throw new Error(`Choose and save the ${cfxTargetLabel(target)} server executable first.`);
      const selectedTrack = target === "enhanced" ? "recommended" : requireArtifactTrack(track);
      return checkArtifactUpdate(executable, config.txDataPath, selectedTrack, artifactStatePath(target));
    }),
  );

  ipcMain.handle("artifacts:update", (_e, targetValue: unknown, track: unknown) =>
    serverOperation.run("the server artifact update", async () => {
      const target = requireCfxTarget(targetValue);
      const config = loadConfig();
      const executable = serverExeFor(config, target);
      if (!executable) throw new Error(`Choose and save the ${cfxTargetLabel(target)} server executable first.`);
      const selectedTrack = target === "enhanced" ? "recommended" : requireArtifactTrack(track);
      return installArtifactUpdate(executable, config.txDataPath, selectedTrack, artifactStatePath(target));
    }),
  );

  ipcMain.handle("artifacts:recoveryNotice", () => {
    const notice = artifactRecoveryNotice;
    artifactRecoveryNotice = null;
    return notice;
  });

  ipcMain.handle("app:setDirtyCount", (_e, count: unknown) => {
    const valid = requireFiniteNumber(count, "Dirty file count");
    dirtyFileCount = Math.max(0, Math.min(10000, Math.floor(valid)));
  });
  ipcMain.handle("app:checkForUpdate", () => checkForAppUpdate(app.getVersion()));

  // --- on-demand Lua language intelligence ---
  // The executable is part of the verified application bundle. The renderer
  // only exchanges JSON-RPC messages with this one child process and cannot
  // choose an executable, workspace, environment, or command-line argument.
  ipcMain.handle("lua:start", () => {
    const config = loadConfig();
    const mode = config.editor.luaIntelligence;
    if (mode === "off") {
      luaLanguageServer.stop();
      return { ok: false as const, mode, error: "Lua intelligence is disabled in Settings." };
    }
    const workspaceRoot = activeProfileRoot();
    const runtimeRoot = app.isPackaged
      ? path.join(process.resourcesPath, "lua-language-server")
      : path.join(app.getAppPath(), "..", "vendor", "lua-language-server");
    const libraryRoot = app.isPackaged
      ? path.join(process.resourcesPath, "lua-library")
      : path.join(app.getAppPath(), "resources", "lua-library");
    const executable = path.join(runtimeRoot, "bin", "lua-language-server.exe");
    if (!fs.existsSync(executable)) {
      return { ok: false as const, mode, error: "The bundled Lua language server is missing. Reinstall QB Studio." };
    }
    if (!fs.existsSync(libraryRoot)) {
      return { ok: false as const, mode, error: "The bundled QBCore/Cfx definitions are missing. Reinstall QB Studio." };
    }
    const logPath = path.join(app.getPath("logs"), "lua-language-server");
    fs.mkdirSync(logPath, { recursive: true });
    luaLanguageServer.start(
      executable,
      workspaceRoot,
      logPath,
      (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lua:message", message);
      },
      (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lua:status", status);
      },
    );
    return { ok: true as const, mode, workspaceRoot, libraryRoot, version: "3.19.1" };
  });
  ipcMain.handle("lua:stop", () => luaLanguageServer.stop());
  ipcMain.on("lua:send", (event, value: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    try {
      luaLanguageServer.send(requireJsonRpcMessage(value));
    } catch (error) {
      mainWindow.webContents.send("lua:status", { state: "error", message: (error as Error).message });
    }
  });

  // --- agent chat ---
  // The key is write-only from the renderer's side: it can set one or ask whether
  // one exists, but there is no handler that hands the value back out.
  ipcMain.handle("agent:setApiKey", (_e, key: unknown) => saveApiKey(requireString(key, "API key", 4096)));
  ipcMain.handle("agent:hasApiKey", () => hasApiKey());
  ipcMain.handle("agent:setProviderKey", (_e, baseUrl: unknown, key: unknown) =>
    saveProviderKey(parseProviderUrl(requireString(baseUrl, "Provider URL", 4096)).toString(), requireString(key, "API key", 4096)),
  );
  ipcMain.handle("agent:hasProviderKey", (_e, baseUrl: unknown) => hasProviderKey(requireString(baseUrl, "Provider URL", 4096)));
  ipcMain.handle("agent:listModels", (_e, baseUrl: unknown, keyOverride?: unknown) =>
    agent.listAvailableModels(
      parseProviderUrl(requireString(baseUrl, "Provider URL", 4096)).toString(),
      typeof keyOverride === "string" ? keyOverride : undefined,
    ),
  );
  ipcMain.handle("agent:send", (_e, message: unknown) => {
    if (mainWindow) return agent.sendMessage(mainWindow, requireString(message, "Message", 100000));
  });
  ipcMain.handle("agent:cancel", () => agent.cancelTurn());
  ipcMain.handle("agent:respondToApproval", (_e, approvalId: unknown, approved: unknown) => {
    const resolved = resolveToolApproval(requireString(approvalId, "Approval id", 128), approved === true);
    if (!resolved) throw new Error("That approval request is no longer pending.");
    return { ok: true };
  });
  ipcMain.handle("agent:setEditorContext", (_e, context: unknown) => {
    if (typeof context !== "object" || context === null) throw new Error("Editor context must be an object.");
    const value = context as EditorContext;
    setEditorContext(value);
  });
  ipcMain.handle("agent:reset", () => agent.resetConversation());

  ipcMain.handle("shell:openExternal", (_e, url: unknown) => shell.openExternal(allowedExternalUrl(url)));
  ipcMain.handle("shell:showItemInFolder", (_e, targetPath: unknown) => shell.showItemInFolder(scopedProfilePath(targetPath)));

  // --- embed the live FiveM game window into the Viewport tab (Windows only) ---
  ipcMain.handle("windowEmbed:listCandidates", () => windowEmbed.listCandidates());
  ipcMain.handle("windowEmbed:attach", (_e, candidateId: unknown) =>
    mainWindow ? windowEmbed.attach(requireString(candidateId, "Window candidate id", 128), mainWindow) : { ok: false, error: "No main window" },
  );
  ipcMain.handle("windowEmbed:detach", () => windowEmbed.detach());
  ipcMain.handle("windowEmbed:setRect", (_e, x: unknown, y: unknown, width: unknown, height: unknown, visible: unknown) =>
    windowEmbed.setRect(
      requireFiniteNumber(x, "x"),
      requireFiniteNumber(y, "y"),
      Math.max(0, requireFiniteNumber(width, "width")),
      Math.max(0, requireFiniteNumber(height, "height")),
      visible === true,
    ),
  );
}
