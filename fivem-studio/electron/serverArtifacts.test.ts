import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";

import {
  buildServerLaunchArgs,
  extractValidatedZip,
  parseArtifactDownloadPage,
  parseProcessIds,
  recoverInterruptedArtifactUpdate,
  resolveArtifactTarget,
  validateArchiveEntryName,
} from "./serverArtifacts";

function artifactPage(overrides: Record<string, unknown> = {}): string {
  const page = {
    props: {
      pageProps: {
        enhanced: {
          windows: [
            {
              displayName: "cfx-server_win_x64.zip",
              subtitle: "build 129",
              downloadURL: "https://downloads.cfx-services.net/prod/01a01f0e-7471-722b-a8ec-9a1827a4fdee/cfx-server_win_x64.zip",
            },
          ],
        },
        legacy: {
          recommended: {
            windows: [
              {
                displayName: "server.7z",
                subtitle: "build 35245",
                downloadURL:
                  "https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/35245-6efb47dff473c0e2a12fb50b08d74c0eb24a50d5/server.7z",
              },
            ],
          },
          latest: {
            windows: [
              {
                displayName: "server.7z",
                subtitle: "build 35574",
                downloadURL:
                  "https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/35574-5c8481b36c2dc65ee7c8e9f5d9bf283f03e2f36e/server.7z",
              },
            ],
          },
        },
        ...overrides,
      },
    },
  };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(page)}</script></html>`;
}

function createZip(zipPath: string, entries: Array<{ name: string; contents: string; mode?: number }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.contents), entry.name, { mode: entry.mode, compress: false });
    }
    const output = fs.createWriteStream(zipPath, { flags: "wx" });
    output.once("error", reject);
    output.once("close", resolve);
    zip.outputStream.once("error", reject);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

test("artifact metadata selects the requested official Windows build and normalizes legacy downloads to ZIP", () => {
  const recommended = parseArtifactDownloadPage(artifactPage(), "legacy", "recommended");
  const latest = parseArtifactDownloadPage(artifactPage(), "legacy", "latest");
  const enhanced = parseArtifactDownloadPage(artifactPage(), "enhanced", "latest");

  assert.equal(recommended.build, 35245);
  assert.match(recommended.downloadUrl, /\/35245-[0-9a-f]{40}\/server\.zip$/);
  assert.equal(latest.build, 35574);
  assert.equal(enhanced.build, 129);
  assert.equal(enhanced.track, "recommended");
});

test("artifact metadata rejects an unapproved host and mismatched build", () => {
  const malicious = artifactPage({
    legacy: {
      recommended: {
        windows: [{ displayName: "server.7z", subtitle: "build 35245", downloadURL: "https://example.com/server.7z" }],
      },
    },
  });
  assert.throws(() => parseArtifactDownloadPage(malicious, "legacy", "recommended"), /not hosted|unexpected/i);

  const mismatch = artifactPage({
    legacy: {
      recommended: {
        windows: [
          {
            displayName: "server.7z",
            subtitle: "build 2",
            downloadURL:
              "https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/server.7z",
          },
        ],
      },
    },
  });
  assert.throws(() => parseArtifactDownloadPage(mismatch, "legacy", "recommended"), /does not match/i);
});

test("artifact target is a dedicated ordinary Cfx server folder and never overlaps txData", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghz-artifact-target-"));
  try {
    const artifactRoot = path.join(root, "server");
    const txDataRoot = path.join(root, "txData");
    fs.mkdirSync(artifactRoot);
    fs.mkdirSync(txDataRoot);
    fs.mkdirSync(path.join(artifactRoot, "citizen", "system_resources"), { recursive: true });
    const executable = path.join(artifactRoot, "FXServer.exe");
    fs.writeFileSync(executable, "test");

    const target = resolveArtifactTarget(executable, txDataRoot);
    assert.equal(target.flavor, "legacy");
    assert.equal(target.root, fs.realpathSync.native(artifactRoot));
    assert.throws(() => resolveArtifactTarget(executable, artifactRoot), /must be separate/i);

    const wrongName = path.join(artifactRoot, "not-the-server.exe");
    fs.writeFileSync(wrongName, "test");
    assert.throws(() => resolveArtifactTarget(wrongName, txDataRoot), /FXServer\.exe or cfx-server\.exe/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("server launch arguments select txData/profile without direct config execution", () => {
  const args = buildServerLaunchArgs("C:\\Local Dev\\txData", "default");
  assert.deepEqual(args, ["+set", "txDataPath", path.resolve("C:\\Local Dev\\txData"), "+set", "serverProfile", "default"]);
  assert.equal(args.includes("+exec"), false);
  assert.deepEqual(buildServerLaunchArgs("C:\\txData", null), ["+set", "txDataPath", path.resolve("C:\\txData")]);
});

test("archive path and process-output validation are narrow", () => {
  assert.equal(validateArchiveEntryName("citizen/system_resources/chat/fxmanifest.lua"), path.join("citizen", "system_resources", "chat", "fxmanifest.lua"));
  for (const unsafe of [
    "../escape",
    "/absolute",
    "C:/absolute",
    "one//two",
    "one\\two",
    "one/./two",
    "\0bad",
    "citizen/file:stream",
    "citizen/CON.txt",
    "citizen/trailing.",
    "citizen/trailing ",
  ]) {
    assert.throws(() => validateArchiveEntryName(unsafe));
  }
  assert.deepEqual(parseProcessIds("123\r\nnot-a-pid\r\n456\r\n0"), [123, 456]);
});

test("an interrupted directory swap restores the backup, and a completed swap finalizes its record", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghz-artifact-recovery-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const artifactRoot = path.join(tempRoot, "server");
  const configuredExe = path.join(artifactRoot, "FXServer.exe");
  const statePath = path.join(tempRoot, "metadata", "artifact.json");
  const journalPath = `${statePath}.transaction.json`;
  const archivePath = path.join(tempRoot, `server.ghz-download-${id}.zip`);
  const stagePath = path.join(tempRoot, `server.ghz-stage-${id}`);
  const backupPath = path.join(tempRoot, `server.ghz-backup-${id}`);

  const createLayout = (root: string, marker: string) => {
    fs.mkdirSync(path.join(root, "citizen", "system_resources"), { recursive: true });
    fs.writeFileSync(path.join(root, "FXServer.exe"), marker);
  };
  const record = {
    schemaVersion: 1,
    artifactRoot,
    executableName: "FXServer.exe",
    flavor: "legacy",
    build: 35245,
    track: "recommended",
    downloadUrl:
      "https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/35245-6efb47dff473c0e2a12fb50b08d74c0eb24a50d5/server.zip",
    sha256: "a".repeat(64),
    installedAt: "2026-08-28T00:00:00.000Z",
    backupPath,
  };

  try {
    // Simulate a crash after the old root moved aside but before the staged root moved into place.
    createLayout(backupPath, "old");
    createLayout(stagePath, "new");
    fs.writeFileSync(archivePath, "archive");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        schemaVersion: 1,
        phase: "prepared",
        executablePath: configuredExe,
        artifactRoot,
        archivePath,
        stagePath,
        backupPath,
        record,
      }),
    );
    assert.match(recoverInterruptedArtifactUpdate(configuredExe, statePath) ?? "", /previous server artifacts/i);
    assert.equal(fs.readFileSync(configuredExe, "utf8"), "old");
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(stagePath), false);
    assert.equal(fs.existsSync(archivePath), false);
    assert.equal(fs.existsSync(journalPath), false);

    // Simulate a crash after the new root landed but before its install record committed.
    fs.renameSync(artifactRoot, backupPath);
    createLayout(artifactRoot, "new");
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        schemaVersion: 1,
        phase: "backup-created",
        executablePath: configuredExe,
        artifactRoot,
        archivePath,
        stagePath,
        backupPath,
        record,
      }),
    );
    assert.match(recoverInterruptedArtifactUpdate(configuredExe, statePath) ?? "", /completed Cfx\.re build 35245/i);
    assert.equal(fs.readFileSync(configuredExe, "utf8"), "new");
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).build, 35245);
    assert.equal(fs.existsSync(backupPath), true);
    assert.equal(fs.existsSync(journalPath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ZIP extraction validates entry CRC and rejects link entries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghz-artifact-zip-"));
  try {
    const validZip = path.join(root, "valid.zip");
    const validStage = path.join(root, "valid-stage");
    fs.mkdirSync(validStage);
    await createZip(validZip, [
      { name: "FXServer.exe", contents: "VALID-EXECUTABLE" },
      { name: "citizen/system_resources/test.txt", contents: "VALID-RESOURCE" },
    ]);
    await extractValidatedZip(validZip, validStage);
    assert.equal(fs.readFileSync(path.join(validStage, "citizen", "system_resources", "test.txt"), "utf8"), "VALID-RESOURCE");

    const corruptZip = path.join(root, "corrupt.zip");
    const corruptStage = path.join(root, "corrupt-stage");
    fs.mkdirSync(corruptStage);
    await createZip(corruptZip, [{ name: "test.txt", contents: "UNIQUE-CONTENT-FOR-CRC" }]);
    const bytes = fs.readFileSync(corruptZip);
    const offset = bytes.indexOf(Buffer.from("UNIQUE-CONTENT-FOR-CRC"));
    assert.notEqual(offset, -1);
    bytes[offset] ^= 0xff;
    fs.writeFileSync(corruptZip, bytes);
    await assert.rejects(() => extractValidatedZip(corruptZip, corruptStage), /integrity|invalid|error/i);

    const linkZip = path.join(root, "link.zip");
    const linkStage = path.join(root, "link-stage");
    fs.mkdirSync(linkStage);
    await createZip(linkZip, [{ name: "linked-file", contents: "target", mode: 0o120777 }]);
    await assert.rejects(() => extractValidatedZip(linkZip, linkStage), /link or reparse point/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
