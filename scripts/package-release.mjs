import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("package-release.mjs requires a semantic version argument.");
}

const packageFiles = ["package.json", "fivem-studio/package.json", "fivem-mcp-server/package.json"];
for (const relative of packageFiles) {
  const target = path.join(root, relative);
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  parsed.version = version;
  fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

// Keep the release metadata internally consistent without asking npm to
// re-resolve dependency ranges after CI has reviewed and tested the lockfile.
const lockPath = path.join(root, "package-lock.json");
const packageLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
packageLock.version = version;
for (const workspace of ["", "fivem-studio", "fivem-mcp-server"]) {
  const lockedPackage = packageLock.packages?.[workspace];
  if (!lockedPackage) throw new Error(`package-lock.json is missing workspace metadata for ${workspace || "the root"}.`);
  lockedPackage.version = version;
}
fs.writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");

function run(executable, args) {
  const isWindowsCommandShim = process.platform === "win32" && /\.cmd$/i.test(executable);
  const command = isWindowsCommandShim ? (process.env.ComSpec || "cmd.exe") : executable;
  const commandArgs = isWindowsCommandShim ? ["/d", "/s", "/c", executable, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw new Error(`Could not run ${executable}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed with exit code ${result.status}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
run(npm, ["run", "dist"]);
// Verify the exact versioned package built by semantic-release. CI's earlier
// package check covers a different build and cannot protect the release asset.
run(npm, ["run", "verify:package"]);
const cyclonedx = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "cyclonedx-npm.cmd" : "cyclonedx-npm");
// The renderer bundle contains libraries that are intentionally development
// classified because electron-builder must not copy their source packages.
// Include the complete reviewed graph so the SBOM does not omit shipped code.
run(cyclonedx, ["--output-file", "release/bom.cdx.json"]);
