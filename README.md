# Ghz Workbench

Ghz Workbench is a Windows desktop workspace for coding resources against your
own localhost Cfx.re server. It puts the editor, resource tree, console, GitHub
imports, AI coding assistant, and an optional passive local-client preview in
one app.

It is a development tool—not a server administration or gameplay tool. It
refuses non-loopback server endpoints and does not expose player actions, raw
RCON, arbitrary Lua execution, spawning, teleporting, or screenshots.

## Highlights

- Monaco code editor with safe, conflict-aware saves
- txData workspace browser and minimal local-workspace creator
- Read-only console plus approved resource refresh controls for coding loops
- GitHub resource imports without a separate file browser
- AI assistant scoped to project files and coding-oriented runtime tools
- Bundled private runtime: no separate Node or MCP server to launch

GitHub imports require [Git for Windows](https://git-scm.com/download/win).

## Install

Download the latest Windows installer from
[Releases](https://github.com/GhzGarage/GhzWorkbench/releases), run it, then
choose your `txData` root and local server-data workspace in Settings.

Ghz Workbench creates the editable `*.base` workspace only. txAdmin continues
to own its separate control profile and attaches the workspace through its
normal setup flow.

Early releases are unsigned, so Windows may show an “Unknown publisher” or
SmartScreen warning. Download only from the `GhzGarage/GhzWorkbench` release
page, compare the published SHA-256 checksum, and verify the GitHub build
attestation with `gh attestation verify <installer> -R GhzGarage/GhzWorkbench`.
Authenticode signing is on the pre-public-launch roadmap.

## Build from source

Requires Node.js 22 and Windows:

```powershell
npm ci
npm test
npm run dist
```

Conventional commits on `main` are automatically versioned by semantic-release
and published as GitHub Releases.

## License and trademarks

MIT licensed. Ghz Workbench is an independent, unofficial project and is not
approved, sponsored, or endorsed by Cfx.re, Rockstar Games, or Take-Two
Interactive. Product names are used only to describe compatibility.
