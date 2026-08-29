import { contextBridge, ipcRenderer } from "electron";

// Everything the renderer is allowed to do lives here, explicitly, rather
// than exposing ipcRenderer wholesale — the renderer never gets direct
// access to Node or Electron internals.
const api = {
  config: {
    get: () => ipcRenderer.invoke("config:get"),
    set: (config: unknown) => ipcRenderer.invoke("config:set", config),
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
    createLocalWorkspace: (txDataPath: string, name: string, port: number) =>
      ipcRenderer.invoke("txdata:createLocalWorkspace", txDataPath, name, port),
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
    chooseExe: (edition: "legacy" | "enhanced") => ipcRenderer.invoke("dialog:chooseExe", edition),
    chooseFxServerExe: (edition: "legacy" | "enhanced") => ipcRenderer.invoke("dialog:chooseFxServerExe", edition),
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
  github: {
    fetchRepoInfo: (input: string) => ipcRenderer.invoke("github:fetchRepoInfo", input),
    searchRepos: (input: string) => ipcRenderer.invoke("github:searchRepos", input),
    listOrgRepos: (input: string) => ipcRenderer.invoke("github:listOrgRepos", input),
    cloneRepo: (repoUrl: string, projectRoot: string) => ipcRenderer.invoke("github:cloneRepo", repoUrl, projectRoot),
  },
  fivem: {
    launch: (edition: "legacy" | "enhanced") => ipcRenderer.invoke("fivem:launch", edition),
  },
  server: {
    status: () => ipcRenderer.invoke("server:status"),
    launch: () => ipcRenderer.invoke("server:launch"),
    stop: (edition: "legacy" | "enhanced") => ipcRenderer.invoke("server:stop", edition),
  },
  artifacts: {
    check: (edition: "legacy" | "enhanced", track: "recommended" | "latest") => ipcRenderer.invoke("artifacts:check", edition, track),
    update: (edition: "legacy" | "enhanced", track: "recommended" | "latest") => ipcRenderer.invoke("artifacts:update", edition, track),
    recoveryNotice: () => ipcRenderer.invoke("artifacts:recoveryNotice"),
  },
  app: {
    setDirtyCount: (count: number) => ipcRenderer.invoke("app:setDirtyCount", count),
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
};

contextBridge.exposeInMainWorld("api", api);

export type StudioApi = typeof api;
