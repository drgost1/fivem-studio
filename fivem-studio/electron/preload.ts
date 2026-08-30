import { contextBridge, ipcRenderer } from "electron";

// Everything the renderer is allowed to do lives here, explicitly, rather
// than exposing ipcRenderer wholesale — the renderer never gets direct
// access to Node or Electron internals.
const api = {
  config: {
    get: () => ipcRenderer.invoke("config:get"),
    set: (config: unknown) => ipcRenderer.invoke("config:set", config),
  },
  theme: {
    system: () => ipcRenderer.invoke("theme:system"),
    onSystemChanged: (callback: (theme: "dark" | "light") => void) => {
      const listener = (_e: unknown, theme: "dark" | "light") => callback(theme);
      ipcRenderer.on("theme:systemChanged", listener);
      return () => ipcRenderer.removeListener("theme:systemChanged", listener);
    },
  },
  installs: {
    detectClients: () => ipcRenderer.invoke("installs:detectClients"),
  },
  setup: {
    diagnostics: (
      txDataPath: string | null,
      profile: string | null,
      target: "legacy" | "enhanced" | "redm",
      clientPath: string | null,
      serverPath: string | null,
    ) => ipcRenderer.invoke("setup:diagnostics", txDataPath, profile, target, clientPath, serverPath),
  },
  revert: {
    list: () => ipcRenderer.invoke("revert:list"),
    apply: (batchId: string, mode: "all" | "safe") => ipcRenderer.invoke("revert:apply", batchId, mode),
  },
  search: {
    run: (request: unknown) => ipcRenderer.invoke("search:run", request),
    previewReplace: (searchId: string, selectedIds: string[], replacement: string) =>
      ipcRenderer.invoke("search:previewReplace", searchId, selectedIds, replacement),
    applyReplace: (searchId: string, selectedIds: string[], replacement: string) =>
      ipcRenderer.invoke("search:applyReplace", searchId, selectedIds, replacement),
  },
  fs: {
    listDir: (dirPath: string) => ipcRenderer.invoke("fs:listDir", dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke("fs:readFile", filePath),
    writeFile: (filePath: string, content: string, expectedRevision: string) =>
      ipcRenderer.invoke("fs:writeFile", filePath, content, expectedRevision),
    rename: (oldPath: string, newName: string) => ipcRenderer.invoke("fs:rename", oldPath, newName),
    delete: (targetPath: string) => ipcRenderer.invoke("fs:delete", targetPath),
    watchRoot: (dirPath: string | null) => ipcRenderer.invoke("fs:watchRoot", dirPath),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("fs:changed", listener);
      return () => ipcRenderer.removeListener("fs:changed", listener);
    },
  },
  txdata: {
    listProfiles: (txDataPath: string) => ipcRenderer.invoke("txdata:listProfiles", txDataPath),
    resolveProfile: (txDataPath: string, profile: string) => ipcRenderer.invoke("txdata:resolveProfile", txDataPath, profile),
    createLocalWorkspace: (txDataPath: string, name: string, port: number, target: "legacy" | "enhanced" | "redm") =>
      ipcRenderer.invoke("txdata:createLocalWorkspace", txDataPath, name, port, target),
    previewDevelopmentRcon: (txDataPath: string, profile: string) =>
      ipcRenderer.invoke("txdata:previewDevelopmentRcon", txDataPath, profile),
    applyDevelopmentRcon: (txDataPath: string, profile: string, allowOverwrite: boolean) =>
      ipcRenderer.invoke("txdata:applyDevelopmentRcon", txDataPath, profile, allowOverwrite),
  },
  windowEmbed: {
    listCandidates: () => ipcRenderer.invoke("windowEmbed:listCandidates"),
    attach: (candidateId: string) => ipcRenderer.invoke("windowEmbed:attach", candidateId),
    detach: () => ipcRenderer.invoke("windowEmbed:detach"),
    setRect: (x: number, y: number, width: number, height: number, visible: boolean) =>
      ipcRenderer.invoke("windowEmbed:setRect", x, y, width, height, visible),
  },
  dialog: {
    chooseFolder: () => ipcRenderer.invoke("dialog:chooseFolder"),
    chooseExe: (target: "legacy" | "enhanced" | "redm") => ipcRenderer.invoke("dialog:chooseExe", target),
    chooseFxServerExe: (target: "legacy" | "enhanced" | "redm") => ipcRenderer.invoke("dialog:chooseFxServerExe", target),
  },
  mcp: {
    connect: () => ipcRenderer.invoke("mcp:connect"),
    disconnect: () => ipcRenderer.invoke("mcp:disconnect"),
    status: () => ipcRenderer.invoke("mcp:status"),
    callTool: (name: string, args: Record<string, unknown>) => ipcRenderer.invoke("mcp:callTool", name, args),
    onDropped: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("mcp:dropped", listener);
      return () => ipcRenderer.removeListener("mcp:dropped", listener);
    },
  },
  resources: {
    listStatuses: () => ipcRenderer.invoke("resources:listStatuses"),
    context: (filePath: string) => ipcRenderer.invoke("resources:context", filePath),
  },
  github: {
    fetchRepoInfo: (input: string) => ipcRenderer.invoke("github:fetchRepoInfo", input),
    searchRepos: (input: string) => ipcRenderer.invoke("github:searchRepos", input),
    listOrgRepos: (input: string) => ipcRenderer.invoke("github:listOrgRepos", input),
    cloneRepo: (repoUrl: string, projectRoot: string) => ipcRenderer.invoke("github:cloneRepo", repoUrl, projectRoot),
  },
  cfx: {
    launch: (target: "legacy" | "enhanced" | "redm") => ipcRenderer.invoke("cfx:launch", target),
  },
  server: {
    status: () => ipcRenderer.invoke("server:status"),
    launch: () => ipcRenderer.invoke("server:launch"),
    stop: (target: "legacy" | "enhanced" | "redm") => ipcRenderer.invoke("server:stop", target),
    crashReport: () => ipcRenderer.invoke("server:crashReport"),
    notifyUnexpectedExit: (target: "legacy" | "enhanced" | "redm") => ipcRenderer.invoke("server:notifyUnexpectedExit", target),
  },
  artifacts: {
    check: (target: "legacy" | "enhanced" | "redm", track: "recommended" | "latest") => ipcRenderer.invoke("artifacts:check", target, track),
    update: (target: "legacy" | "enhanced" | "redm", track: "recommended" | "latest") => ipcRenderer.invoke("artifacts:update", target, track),
    recoveryNotice: () => ipcRenderer.invoke("artifacts:recoveryNotice"),
  },
  app: {
    setDirtyCount: (count: number) => ipcRenderer.invoke("app:setDirtyCount", count),
    checkForUpdate: () => ipcRenderer.invoke("app:checkForUpdate"),
  },
  lua: {
    start: () => ipcRenderer.invoke("lua:start"),
    stop: () => ipcRenderer.invoke("lua:stop"),
    send: (message: unknown) => ipcRenderer.send("lua:send", message),
    onMessage: (callback: (message: unknown) => void) => {
      const listener = (_e: unknown, message: unknown) => callback(message);
      ipcRenderer.on("lua:message", listener);
      return () => ipcRenderer.removeListener("lua:message", listener);
    },
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_e: unknown, status: unknown) => callback(status);
      ipcRenderer.on("lua:status", listener);
      return () => ipcRenderer.removeListener("lua:status", listener);
    },
  },
  agent: {
    setApiKey: (key: string) => ipcRenderer.invoke("agent:setApiKey", key),
    hasApiKey: () => ipcRenderer.invoke("agent:hasApiKey"),
    setProviderKey: (baseUrl: string, key: string) => ipcRenderer.invoke("agent:setProviderKey", baseUrl, key),
    hasProviderKey: (baseUrl: string) => ipcRenderer.invoke("agent:hasProviderKey", baseUrl),
    listModels: (baseUrl: string, keyOverride?: string) => ipcRenderer.invoke("agent:listModels", baseUrl, keyOverride),
    send: (message: string) => ipcRenderer.invoke("agent:send", message),
    cancel: () => ipcRenderer.invoke("agent:cancel"),
    respondToApproval: (approvalId: string, approved: boolean) =>
      ipcRenderer.invoke("agent:respondToApproval", approvalId, approved),
    setEditorContext: (context: { path: string | null; selectedText: string; startLine: number; endLine: number }) =>
      ipcRenderer.invoke("agent:setEditorContext", context),
    onFileWritten: (callback: (absolutePath: string) => void) => {
      const listener = (_e: unknown, absolutePath: string) => callback(absolutePath);
      ipcRenderer.on("project:fileWritten", listener);
      return () => ipcRenderer.removeListener("project:fileWritten", listener);
    },
    reset: () => ipcRenderer.invoke("agent:reset"),
    onEvent: (callback: (event: unknown) => void) => {
      const listener = (_e: unknown, event: unknown) => callback(event);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
    showItemInFolder: (targetPath: string) => ipcRenderer.invoke("shell:showItemInFolder", targetPath),
  },
  clipboard: {
    writeText: (value: string) => ipcRenderer.invoke("clipboard:writeText", value),
  },
};

contextBridge.exposeInMainWorld("api", api);

export type StudioApi = typeof api;
