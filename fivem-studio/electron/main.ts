import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

import {
  loadConfig,
  saveConfig,
  saveApiKey,
  hasApiKey,
  saveProviderKey,
  hasProviderKey,
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
  setOnDropped,
} from "./mcpClient";
import { fetchRepoInfo, cloneRepo } from "./githubClient";
import * as windowEmbed from "./windowEmbed";
import { setEditorContext, setOnFileWritten, type EditorContext } from "./projectTools";
import { assertSafeBasename, resolveInsideRoot } from "./pathSafety";
import { resolveToolApproval } from "./toolApproval";
import { createLocalWorkspace } from "./workspaceCreator";
import { ensureManagedRuntime, stopManagedRuntime } from "./managedRuntime";
import { parseProviderUrl } from "./localUrl";

let mainWindow: BrowserWindow | null = null;

// How many editor tabs currently hold unsaved edits, pushed from the renderer —
// used to guard against quitting Studio and silently losing them.
let dirtyFileCount = 0;
let allowCloseWithUnsavedChanges = false;
// A folder becomes eligible for profile discovery only after the native picker
// returned it. This prevents the renderer from turning discovery into an
// arbitrary-directory listing API.
let pendingTxDataPath: string | null = null;
let pendingFivemExePath: string | null = null;

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

function scopedFiveMExe(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const requested = requireString(value, "FiveM executable");
  const current = loadConfig().fivemExePath;
  if (requested !== current && requested !== pendingFivemExePath) {
    throw new Error("Choose the FiveM executable using Browse before saving it.");
  }
  return requested;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "Ghz Workbench",
    backgroundColor: "#1e1e1e",
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
      detail: "Closing Ghz Workbench now will discard them.",
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

app.whenReady().then(() => {
  // The default File/Edit/View/Window/Help menu is generic Electron boilerplate —
  // Studio has its own branded toolbar (TopBar) providing the equivalent actions,
  // so the native menu bar is just redundant chrome sitting above it.
  Menu.setApplicationMenu(null);

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
  if (process.platform !== "darwin") app.quit();
});

function registerIpcHandlers() {
  // --- config ---
  ipcMain.handle("config:get", () => loadConfig());
  ipcMain.handle("config:set", async (_e, config: unknown) => {
    if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("Configuration must be an object.");
    const candidate = config as Record<string, unknown>;
    const previous = loadConfig();
    const switchingProfile =
      candidate.txDataPath !== previous.txDataPath || candidate.selectedProfile !== previous.selectedProfile;
    if (switchingProfile) {
      agent.resetConversation();
      await mcpDisconnect();
      stopManagedRuntime();
    }
    if (candidate.txDataPath !== null && candidate.txDataPath !== undefined) scopedTxDataPath(candidate.txDataPath);
    if (typeof candidate.openaiBaseUrl === "string") parseProviderUrl(candidate.openaiBaseUrl);
    scopedFiveMExe(candidate.fivemExePath);
    return saveConfig(config);
  });

  // --- filesystem / resource tree ---
  ipcMain.handle("fs:listDir", (_e, dirPath: unknown) => listDir(scopedProfilePath(dirPath)));
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
  ipcMain.handle("txdata:createLocalWorkspace", (_e, txDataPath: unknown, name: unknown, port: unknown) =>
    createLocalWorkspace(
      scopedTxDataPath(txDataPath),
      requireString(name, "Workspace name", 255),
      requireFiniteNumber(port, "Local server port"),
    ),
  );

  ipcMain.handle("dialog:chooseFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled) return null;
    pendingTxDataPath = result.filePaths[0];
    return pendingTxDataPath;
  });

  ipcMain.handle("dialog:chooseExe", async () => {
    const filters =
      process.platform === "win32" ? [{ name: "Executable", extensions: ["exe"] }] : [{ name: "All files", extensions: ["*"] }];
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
    if (result.canceled) return null;
    pendingFivemExePath = result.filePaths[0];
    return pendingFivemExePath;
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
    if (!RENDERER_MCP_TOOLS.has(toolName)) throw new Error(`The Ghz Workbench UI is not allowed to invoke ${toolName}.`);
    return mcpCallTool(toolName, args as Record<string, unknown>);
  });

  // --- GitHub import ---
  ipcMain.handle("github:fetchRepoInfo", (_e, input: unknown) => fetchRepoInfo(requireString(input, "GitHub repository", 2048)));
  ipcMain.handle("github:cloneRepo", (_e, repoUrl: unknown, _projectRoot: unknown) =>
    cloneRepo(requireString(repoUrl, "GitHub repository", 2048), activeResourcesRoot()),
  );

  // --- launch the real FiveM client, in its own window ---
  ipcMain.handle("fivem:launch", (_e, exePath: unknown) => {
    const configured = loadConfig().fivemExePath;
    const requested = requireString(exePath, "FiveM executable");
    if (!configured || path.resolve(requested) !== path.resolve(configured)) {
      throw new Error("Only the FiveM executable selected in Settings may be launched.");
    }
    if (process.platform === "win32" && path.extname(configured).toLowerCase() !== ".exe") throw new Error("FiveM executable must be an .exe file.");
    spawn(configured, [], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  });

  ipcMain.handle("app:setDirtyCount", (_e, count: unknown) => {
    const valid = requireFiniteNumber(count, "Dirty file count");
    dirtyFileCount = Math.max(0, Math.min(10000, Math.floor(valid)));
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
