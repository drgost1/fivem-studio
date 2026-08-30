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

function requireFile(label, candidates) {
  const resolved = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (resolved) return resolved;
  throw new Error(`Could not locate ${label}. Checked: ${candidates.join(", ")}`);
}

// Run JavaScript entry points with this already-pinned Node executable. This
// avoids .cmd wrappers on Windows and never delegates release arguments to a
// command shell (including one selected through process environment data).
const nodeDir = path.dirname(fs.realpathSync(process.execPath));
const npmCli = requireFile("npm CLI", [
  path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  path.resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
]);

function runNodeCli(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw new Error(`Could not run ${scriptPath}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${path.basename(scriptPath)} ${args.join(" ")} failed with exit code ${result.status}`);
}

runNodeCli(npmCli, ["run", "dist"]);
// Verify the exact versioned package built by semantic-release. CI's earlier
// package check covers a different build and cannot protect the release asset.
runNodeCli(npmCli, ["run", "verify:package"]);
const cyclonedx = requireFile("CycloneDX npm CLI", [
  path.join(root, "node_modules", "@cyclonedx", "cyclonedx-npm", "bin", "cyclonedx-npm-cli.js"),
]);
// The renderer bundle contains libraries that are intentionally development
// classified because electron-builder must not copy their source packages.
// Include the complete reviewed graph so the SBOM does not omit shipped code.
runNodeCli(cyclonedx, ["--output-file", "release/bom.cdx.json"]);
