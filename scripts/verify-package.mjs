import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const installer = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).find((name) => /^Ghz-Workbench-Setup-.*\.exe$/i.test(name))
  : undefined;
if (!installer) throw new Error("No Ghz Workbench installer was produced.");
if (fs.statSync(path.join(releaseDir, installer)).size < 10 * 1024 * 1024) {
  throw new Error("The installer is unexpectedly small.");
}

const runtime = path.join(releaseDir, "win-unpacked", "resources", "runtime", "runtime.cjs");
if (!fs.existsSync(runtime) || fs.statSync(runtime).size < 100_000) {
  throw new Error("The packaged loopback runtime is missing or incomplete.");
}

const packagedExe = path.join(releaseDir, "win-unpacked", "Ghz Workbench.exe");
if (!fs.existsSync(packagedExe)) throw new Error("The unpacked Ghz Workbench executable is missing.");

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

    const client = new Client({ name: "ghz-workbench-package-verifier", version: "1.0.0" });
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

await verifyRuntimeContract();

console.log(`Verified ${installer} and packaged loopback runtime identity contract v3.`);
