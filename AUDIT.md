# Ghz Workbench audit and improvement plan

## Product boundary

Ghz Workbench is a single-user, localhost-only coding environment. Its live
runtime surface is intentionally limited to console reading and named resource
lifecycle actions. The embedded local-client preview is passive: it does not
add player or gameplay controls.

## Fixed in this stabilization pass

- Enforced numeric loopback-only MCP and RCON destinations without DNS
  resolution. Standard Cfx.re wildcard bind directives are normalized to
  loopback for RCON; explicit LAN/public targets remain rejected. Workbench's
  generated local profile binds to `127.0.0.1` and disables advertisement.
- Removed all player, entity, teleport, spawn, screenshot, arbitrary-eval, and
  raw-RCON tools from the UI, agent allowlists, and bundled runtime.
- Added bounded requests/sessions, strict tool schemas, resource-name checks,
  workspace/runtime identity matching, and explicit approval for mutations.
- Scoped renderer file access to the selected workspace with traversal and
  symlink defenses, atomic writes, revision conflicts, trash deletion, and
  unsaved-change guards.
- Corrected the txAdmin model: a `*.base` server-data workspace is distinct
  from txAdmin's version-owned control profile. Creation is atomic and writes
  only `server.cfg`, `resources/[local]`, `.gitignore`, and a secrets example.
- Removed the obsolete in-server bridge entirely. First-run documentation and
  Settings now show the exact `set rcon_password`/secrets include, txAdmin
  attachment, server start, and rescan steps; no server resource is required.
- Discover txAdmin attachment through the control profile's `server.dataPath`;
  fresh workspaces no longer masquerade as control profiles, and console
  capability stays off until an unambiguous attachment exists.
- Bundled the coding runtime inside the Windows app. Each launch uses an
  ephemeral loopback port and fresh in-memory bearer token.
- Recursively validate bounded `exec` includes before accepting a profile as
  localhost-only, and isolate runtime launch generations so stale child events
  cannot terminate a newer workspace runtime.
- Use short-lived opaque IDs for local-client preview candidates and revalidate
  window ownership before native reparenting operations.
- Added an NSIS installer, CI, semantic versioning, a single installer release
  asset, signed GitHub build and SBOM attestations, an MIT license, and
  neutral Ghz Workbench branding.

## Next priorities

### P0 — before promoting beyond an early preview

1. Run an end-to-end matrix against a fresh generated workspace: txAdmin
   attachment, FXServer start, console tail, resource list, each lifecycle
   action, reconnect, app restart, and clean uninstall.
2. Add Authenticode signing and verify the installer/update trust chain before
   enabling automatic updates.
3. Add a release smoke test that installs into a clean Windows VM and launches
   the packaged app, not just the unpacked build.

### P1 — highest-value product improvements

1. Finish the Git workflow needed to replace GitHub Desktop: status, diff,
   stage, conventional commit, branch, pull, and push with clear confirmations.
2. Stream and filter console output instead of requiring manual refresh, with
   backpressure and a fixed memory cap.
3. Add a diagnostics page for txAdmin attachment, missing license/RCON config,
   port collisions, FXServer state, and actionable fixes.
4. Add first-class resource creation templates and manifest validation.
5. Add workspace search/replace and source-control-aware rename previews.

### P2 — polish

1. Add a distinctive signed app icon and a small onboarding walkthrough.
2. Add opt-in local crash diagnostics with automatic secret/path redaction.
3. Add Lua language-server integration and configurable formatting/linting.

## Known constraints

- The AI provider may receive prompts and selected project content; a local
  OpenAI-compatible provider is available for developers who require offline
  inference.
- txAdmin owns its control-profile schema. Ghz Workbench creates a safe
  server-data workspace, then the developer attaches it through txAdmin's
  supported setup/deployer flow.
- Initial installers are unsigned and will accumulate reputation slowly until
  code signing is added.
