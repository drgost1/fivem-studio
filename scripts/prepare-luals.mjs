import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import yauzl from "yauzl";

const VERSION = "3.19.1";
const ARCHIVE_SHA256 = "fdb9a59108cf62517813c97fa5549b0e16d1ef0688306bac728b08434db7e4cd";
const DOWNLOAD_URL = `https://github.com/LuaLS/lua-language-server/releases/download/${VERSION}/lua-language-server-${VERSION}-win32-x64.zip`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(root, "vendor");
const target = path.join(vendorRoot, "lua-language-server");
const marker = path.join(target, "QB_STUDIO_BUNDLE.json");
const executable = path.join(target, "bin", "lua-language-server.exe");

function cachedBundleIsCurrent() {
  try {
    const current = JSON.parse(fs.readFileSync(marker, "utf8"));
    return current.version === VERSION && current.sha256 === ARCHIVE_SHA256 && fs.statSync(executable).size > 500_000;
  } catch {
    return false;
  }
}

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe LuaLS archive path: ${child}`);
  }
}

function openZip(archive) {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Could not open the LuaLS archive."));
      else resolve(zip);
    });
  });
}

async function extractZip(archive, destination) {
  const zip = await openZip(archive);
  let entries = 0;
  let extractedBytes = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      entries += 1;
      extractedBytes += entry.uncompressedSize;
      if (entries > 20_000 || extractedBytes > 300 * 1024 * 1024) {
        fail(new Error("The LuaLS archive exceeds the extraction safety limits."));
        return;
      }
      const normalized = entry.fileName.replaceAll("\\", "/");
      if (normalized.startsWith("/") || normalized.split("/").includes("..") || /^[A-Za-z]:/.test(normalized)) {
        fail(new Error(`Unsafe path in LuaLS archive: ${entry.fileName}`));
        return;
      }
      const output = path.resolve(destination, ...normalized.split("/"));
      try {
        assertInside(destination, output);
      } catch (error) {
        fail(error);
        return;
      }
      if (normalized.endsWith("/")) {
        fs.mkdirSync(output, { recursive: true });
        zip.readEntry();
        return;
      }
      fs.mkdirSync(path.dirname(output), { recursive: true });
      zip.openReadStream(entry, async (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error(`Could not extract ${entry.fileName}.`));
          return;
        }
        try {
          await pipeline(stream, fs.createWriteStream(output, { flags: "wx" }));
          zip.readEntry();
        } catch (streamError) {
          fail(streamError);
        }
      });
    });
    zip.readEntry();
  });
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("QB Studio currently packages LuaLS for Windows x64 only.");
}

if (cachedBundleIsCurrent()) {
  console.log(`LuaLS ${VERSION} is already prepared.`);
  process.exit(0);
}

fs.mkdirSync(vendorRoot, { recursive: true });
const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
const tempRoot = path.join(os.tmpdir(), `qb-studio-luals-${nonce}`);
const archive = path.join(tempRoot, "lua-language-server.zip");
const staging = path.join(vendorRoot, `.lua-language-server-${nonce}`);
fs.mkdirSync(tempRoot, { recursive: true });
fs.mkdirSync(staging, { recursive: true });

try {
  console.log(`Downloading LuaLS ${VERSION} from the official GitHub release...`);
  const response = await fetch(DOWNLOAD_URL, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`LuaLS download failed with HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive, { flags: "wx" }));
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (digest !== ARCHIVE_SHA256) throw new Error(`LuaLS checksum mismatch: received ${digest}.`);

  await extractZip(archive, staging);
  const stagedExecutable = path.join(staging, "bin", "lua-language-server.exe");
  if (!fs.existsSync(stagedExecutable) || !fs.existsSync(path.join(staging, "LICENSE"))) {
    throw new Error("The verified LuaLS archive is missing required runtime or license files.");
  }
  fs.writeFileSync(
    path.join(staging, "QB_STUDIO_BUNDLE.json"),
    `${JSON.stringify({ version: VERSION, sha256: ARCHIVE_SHA256, source: DOWNLOAD_URL }, null, 2)}\n`,
    "utf8",
  );

  const resolvedTarget = path.resolve(target);
  assertInside(path.resolve(vendorRoot), resolvedTarget);
  if (fs.existsSync(resolvedTarget)) fs.rmSync(resolvedTarget, { recursive: true, force: true });
  fs.renameSync(staging, resolvedTarget);
  console.log(`Prepared LuaLS ${VERSION} with verified SHA-256 ${ARCHIVE_SHA256}.`);
} finally {
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
}
