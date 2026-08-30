# Dependency policy

Last reviewed: August 29, 2026

QB Studio targets current stable releases that support its Windows x64,
Electron, and Node.js 22 runtime. The committed `package-lock.json` is the
source of truth for reproducible installs. A newer version is not adopted when
it drops a required platform, is prerelease-only, or fails the repository's
security, behavior, packaging, or performance checks.

## Automated update proposals

Dependabot checks npm packages and GitHub Actions every week. Compatible minor
and patch npm updates are grouped to keep review noise manageable; major
updates remain separate so migrations and resource impact are visible. Updates
are never auto-merged.

Every dependency change must pass on Windows:

```powershell
npm ci
npm audit signatures
npm run prepare:luals
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
npm run dist
npm run verify:package
```

The packaged-runtime check verifies the renderer manifest, private loopback
runtime, QBCore/Cfx Lua definitions, and bundled Lua language-server executable
from the unpacked release—not only the source tree.

## Bundled Lua language server

LuaLS is an executable dependency rather than an npm package, so it is pinned
to an exact version and SHA-256 in `scripts/luals-release.json`. The preparation
script only downloads the official LuaLS Windows x64 release, rejects a
checksum mismatch, applies bounded path and extraction limits, and requires the
upstream license before installing the bundle. The MIT license and source
marker are shipped with the application.

A weekly GitHub Actions check compares that manifest with the latest stable
upstream release. It maintains one repository issue when the pin is stale and
closes the reminder after the reviewed pin catches up; it never changes the pin,
downloads a new executable into the repository, or opens an automatic update PR.

Updating LuaLS requires reviewing its release notes and license, changing both
the version and checksum, running the end-to-end CfxLua completion test, and
rebuilding the installer. This deliberate pin prevents a release build from
silently acquiring a different native executable.

## Resource-impact review

Updates to Electron, Monaco, LuaLS, model SDKs, or native modules require a
production renderer build and installer-size comparison. Editor services must
remain demand-driven: per-tab Monaco models are disposed when closed, the diff
editor loads only for a requested review, and Balanced Lua intelligence stops
when no Lua file is open.
