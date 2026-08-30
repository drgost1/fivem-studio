import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { extractFile, listPackage } from "@electron/asar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const desktopPackage = JSON.parse(fs.readFileSync(path.join(root, "fivem-studio", "package.json"), "utf8"));
const installers = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).filter((name) => /^QB-Studio-Setup-.*\.exe$/i.test(name))
  : [];
if (installers.length !== 1) throw new Error(`Expected exactly one QB Studio installer, found ${installers.length}.`);
const [installer] = installers;
const expectedInstaller = `QB-Studio-Setup-${desktopPackage.version}-x64.exe`;
if (installer !== expectedInstaller) {
  throw new Error(`Expected installer ${expectedInstaller}, found ${installer}.`);
}
if (fs.statSync(path.join(releaseDir, installer)).size < 10 * 1024 * 1024) {
  throw new Error("The installer is unexpectedly small.");
}

const runtime = path.join(releaseDir, "win-unpacked", "resources", "runtime", "runtime.cjs");
if (!fs.existsSync(runtime) || fs.statSync(runtime).size < 100_000) {
  throw new Error("The packaged loopback runtime is missing or incomplete.");
}

const luaLanguageServer = path.join(
  releaseDir,
  "win-unpacked",
  "resources",
  "lua-language-server",
  "bin",
  "lua-language-server.exe",
);
if (!fs.existsSync(luaLanguageServer) || fs.statSync(luaLanguageServer).size < 500_000) {
  throw new Error("The packaged Lua language server is missing or incomplete.");
}
const luaLanguageServerRoot = path.join(releaseDir, "win-unpacked", "resources", "lua-language-server");
const luaLicense = path.join(luaLanguageServerRoot, "LICENSE");
if (!fs.existsSync(luaLicense) || fs.statSync(luaLicense).size < 1_000) {
  throw new Error("The packaged Lua language server license is missing or incomplete.");
}
const expectedLuaRelease = JSON.parse(fs.readFileSync(path.join(root, "scripts", "luals-release.json"), "utf8"));
const packagedLuaRelease = JSON.parse(
  fs.readFileSync(path.join(luaLanguageServerRoot, "QB_STUDIO_BUNDLE.json"), "utf8"),
);
if (
  packagedLuaRelease.version !== expectedLuaRelease.version ||
  packagedLuaRelease.sha256 !== expectedLuaRelease.sha256
) {
  throw new Error("The packaged Lua language server does not match the reviewed release manifest.");
}
const luaLibrary = path.join(releaseDir, "win-unpacked", "resources", "lua-library", "qb-studio-cfx.lua");
if (!fs.existsSync(luaLibrary) || fs.statSync(luaLibrary).size < 1_000) {
  throw new Error("The packaged QBCore/Cfx Lua definitions are missing or incomplete.");
}

const packagedExe = path.join(releaseDir, "win-unpacked", "QB Studio.exe");
if (!fs.existsSync(packagedExe)) throw new Error("The unpacked QB Studio executable is missing.");

const appArchive = path.join(releaseDir, "win-unpacked", "resources", "app.asar");
if (!fs.existsSync(appArchive)) throw new Error("The packaged Electron app archive is missing.");
const koffiNative = path.join(
  releaseDir,
  "win-unpacked",
  "resources",
  "app.asar.unpacked",
  "node_modules",
  "@koromix",
  "koffi-win32-x64",
  "win32_x64",
  "koffi.node",
);
if (!fs.existsSync(koffiNative) || fs.statSync(koffiNative).size < 100_000) {
  throw new Error("The packaged native window-integration module is missing or incomplete.");
}

function verifyPackagedRenderer() {
  const entries = new Set(
    listPackage(appArchive).map((entry) => entry.replace(/^[/\\]+/, "").replaceAll("\\", "/")),
  );
  const required = ["dist/index.html", "dist/manifest.json", "dist-electron/main.js", "dist-electron/preload.js"];
  for (const entry of required) {
    if (!entries.has(entry)) throw new Error(`Required packaged app entry is missing: ${entry}`);
  }

  for (const entry of entries) {
    if (/^dist-electron\/.*(?:\.test\.js|\.map)$/i.test(entry)) {
      throw new Error(`Development-only Electron output was packaged: ${entry}`);
    }
    if (/(^|\/)(?:\.env(?:\..*)?|agent_bridge|[^/]*\.config\.local\.json)(?:\/|$)/i.test(entry)) {
      throw new Error(`Forbidden app archive content found: ${entry}`);
    }
  }

  const packagedMetadata = JSON.parse(extractFile(appArchive, "package.json").toString("utf8"));
  if (
    packagedMetadata.name !== desktopPackage.name ||
    packagedMetadata.version !== desktopPackage.version ||
    packagedMetadata.private !== true
  ) {
    throw new Error("The packaged application metadata does not match the release source.");
  }

  const html = extractFile(appArchive, "dist/index.html").toString("utf8");
  if (!html.includes('<div id="root"></div>')) {
    throw new Error("The packaged renderer HTML is missing its React root.");
  }

  const references = [...html.matchAll(/(?:src|href)=["']\.\/([^"'?#]+)(?:[?#][^"']*)?["']/g)].map(
    (match) => `dist/${match[1]}`,
  );
  if (!references.some((entry) => entry.endsWith(".js"))) {
    throw new Error("The packaged renderer HTML does not reference a JavaScript bundle.");
  }
  for (const entry of references) {
    if (!entries.has(entry)) throw new Error(`The packaged renderer references a missing asset: ${entry}`);
  }

  const manifest = JSON.parse(extractFile(appArchive, "dist/manifest.json").toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The packaged Vite manifest is invalid.");
  }
  const indexEntry = manifest["index.html"];
  if (!indexEntry || indexEntry.isEntry !== true || typeof indexEntry.file !== "string") {
    throw new Error("The packaged Vite manifest has no renderer entry point.");
  }

  const manifestEntries = new Set(Object.keys(manifest));
  for (const [source, value] of Object.entries(manifest)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`The packaged Vite manifest entry is invalid: ${source}`);
    }
    const record = value;
    const emittedFiles = [record.file, ...(record.css ?? []), ...(record.assets ?? [])];
    for (const emitted of emittedFiles) {
      if (typeof emitted !== "string" || !entries.has(`dist/${emitted}`)) {
        throw new Error(`The packaged Vite manifest references a missing asset: ${String(emitted)}`);
      }
    }
    for (const imported of [...(record.imports ?? []), ...(record.dynamicImports ?? [])]) {
      if (typeof imported !== "string" || !manifestEntries.has(imported)) {
        throw new Error(`The packaged Vite manifest references an unknown bundle: ${String(imported)}`);
      }
    }
  }
}

const forbidden = [".env", "agent_bridge"];
for (const entry of forbidden) {
  if (fs.existsSync(path.join(releaseDir, "win-unpacked", "resources", entry))) {
    throw new Error(`Forbidden release content found: ${entry}`);
  }
}

function narrowSystemEnvironment() {
  const names = ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"];
  return Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

async function verifyRuntimeContract() {
  if (process.platform !== "win32") throw new Error("Packaged runtime verification must run on Windows.");
  const token = randomBytes(32).toString("base64url");
  const workspacePath = path.join(root, ".package-verification-workspace");
  const serverConfigPath = path.join(workspacePath, "server.cfg");
  let stderr = "";
  const child = spawn(packagedExe, [runtime], {
    cwd: root,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...narrowSystemEnvironment(),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      MCP_TRANSPORT: "http",
      MCP_HOST: "127.0.0.1",
      MCP_PORT: "0",
      MCP_TOKEN: token,
      RCON_HOST: "127.0.0.1",
      RCON_PORT: "30120",
      RCON_PASSWORD: "",
      SERVER_DATA_WORKSPACE: workspacePath,
      SERVER_CONFIG_PATH: serverConfigPath,
      TXADMIN_DATA_DIR: "",
      TXADMIN_CONTROL_PROFILE: "",
    },
  });

  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
  });

  try {
    const port = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(
        () => finish(new Error(`Packaged runtime did not become ready within 10 seconds.${stderr ? ` ${stderr.trim()}` : ""}`)),
        10_000,
      );
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(new Error(`Packaged runtime exited with code ${code ?? "unknown"}.${stderr ? ` ${stderr.trim()}` : ""}`)));
      child.on("message", (message) => {
        const ready = message && typeof message === "object" ? message : {};
        if (ready.type === "ready" && ready.protocolVersion === 1 && Number.isInteger(ready.port)) finish(null, ready.port);
      });
    });

    const client = new Client({ name: "qb-studio-package-verifier", version: "1.0.0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      const result = await client.callTool({ name: "get_runtime_identity", arguments: {} });
      const block = result.content?.find((item) => item.type === "text");
      const identity = JSON.parse(block?.text ?? "null");
      if (result.isError || identity?.contractVersion !== "3") {
        throw new Error("The packaged runtime did not report identity contract v3.");
      }
      if (path.resolve(identity.runtime?.serverData?.workspacePath ?? "") !== path.resolve(workspacePath)) {
        throw new Error("The packaged runtime reported the wrong server-data workspace identity.");
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  }
}

verifyPackagedRenderer();
await verifyRuntimeContract();

console.log(`Verified ${installer}, packaged renderer assets, and loopback runtime identity contract v3.`);
