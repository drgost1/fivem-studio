import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "scripts", "luals-release.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const MAX_RESPONSE_BYTES = 256 * 1024;

function parseVersion(value) {
  if (typeof value !== "string" || !STABLE_VERSION.test(value)) {
    throw new Error(`Invalid stable LuaLS version: ${String(value)}`);
  }
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`LuaLS version is outside the safe integer range: ${value}`);
  return parts;
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

const pinned = manifest.version;
parseVersion(pinned);
if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
  throw new Error("The LuaLS release manifest has an invalid SHA-256 digest.");
}

const response = await fetch("https://api.github.com/repos/LuaLS/lua-language-server/releases/latest", {
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "QB-Studio-Dependency-Check",
  },
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`LuaLS release check failed with HTTP ${response.status}.`);
const declaredLength = Number(response.headers.get("content-length"));
if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
  throw new Error("The LuaLS release response is too large.");
}
const text = await response.text();
if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("The LuaLS release response is too large.");
const release = JSON.parse(text);
if (!release || typeof release !== "object" || release.draft === true || release.prerelease === true) {
  throw new Error("GitHub did not return a stable LuaLS release.");
}
const latest = release.tag_name;
parseVersion(latest);
const expectedPage = `https://github.com/LuaLS/lua-language-server/releases/tag/${latest}`;
if (release.html_url !== expectedPage) throw new Error("GitHub returned an unexpected LuaLS release page.");

const outdated = compareVersions(pinned, latest) < 0;
writeOutput("pinned", pinned);
writeOutput("latest", latest);
writeOutput("release_url", expectedPage);
writeOutput("outdated", String(outdated));
console.log(outdated ? `LuaLS ${pinned} is behind ${latest}.` : `LuaLS ${pinned} is current (latest: ${latest}).`);
