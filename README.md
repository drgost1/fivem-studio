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
[Releases](https://github.com/GhzGarage/GhzWorkbench/releases) and run it once.
Ghz Workbench does not install or start FXServer/txAdmin for you, and it does
not require any resource to be added to your server.

## First run

You need an existing local FXServer installation with txAdmin, its `txData`
folder, and a Cfx.re server license key.

### Use an existing local workspace

1. Confirm the editable server-data folder is a direct child of `txData`,
   normally `txData\YourServer.base`, and contains `server.cfg` and
   `resources\`.
2. Make its FXServer endpoints numeric loopback addresses. Ghz Workbench
   deliberately rejects `localhost`, `0.0.0.0`, LAN addresses, and public
   addresses:

   ```cfg
   endpoint_add_tcp "127.0.0.1:30120"
   endpoint_add_udp "127.0.0.1:30120"
   sv_master1 ""
   ```

3. Set a non-empty `rcon_password` in `server.cfg` or a workspace-local file
   loaded with `exec`. There is no RCON field in the app; Workbench reads the
   active configuration directly.
4. In txAdmin, make sure one control profile points its `server.dataPath` to
   that exact server-data folder, then start FXServer.
5. Open Workbench Settings, choose the `txData` root and the server-data
   workspace—not the txAdmin control-profile folder—and select **Save**.

### Create a new local workspace

1. In Workbench Settings, choose the `txData` root, enter a workspace name and
   port under **Local workspace**, select **Create**, then **Save**.
2. In the new `YourName.base` folder, copy `secrets.cfg.example` to
   `secrets.cfg` and add your own values:

   ```cfg
   sv_licenseKey "YOUR_OWN_LICENSE_KEY"
   rcon_password "CHOOSE_A_LOCAL_DEVELOPMENT_PASSWORD"
   ```

3. In its `server.cfg`, change `# exec secrets.cfg` to `exec secrets.cfg`.
   `secrets.cfg` is already excluded from Git.
4. In txAdmin setup choose **Existing Server Data**, point it at the new
   `.base` folder and its `server.cfg`, then select **Save & Start Server**.
   The [official txAdmin setup guide](https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/)
   covers installing and opening txAdmin.
5. Return to Workbench and select **Save** in Settings again—or restart the
   app—so it rescans the updated configuration and txAdmin attachment.

## How the local connection works

| Feature | Requirement |
| --- | --- |
| Editor, files, and GitHub import | Selected server-data workspace only |
| Resource list/start/stop/restart | Running FXServer plus matching `rcon_password` |
| Read-only console | Exactly one txAdmin control profile attached to the workspace, with an `fxserver*.log` file |
| AI assistant | Optional configured model provider; no server resource required |

The private MCP runtime is bundled with the desktop app and starts on an
ephemeral loopback port. “Coding runtime ready” means the workspace connection
is ready; it does not mean FXServer itself is running.

If resource controls are unavailable, verify the RCON password, restart
FXServer after configuration changes, then save Settings again. If the console
is unavailable, verify the control profile's `server.dataPath` matches the
selected workspace exactly and that txAdmin has started the server at least
once.

Early releases are unsigned, so Windows may show an “Unknown publisher” or
SmartScreen warning. Download only from the `GhzGarage/GhzWorkbench` release
page, compare the published SHA-256 checksum, and verify the GitHub build
attestation:

```powershell
gh attestation verify <installer> -R GhzGarage/GhzWorkbench --signer-workflow GhzGarage/GhzWorkbench/.github/workflows/release.yml
```

Authenticode signing is on the pre-public-launch roadmap.

## Build from source

Requires Node.js 22 and Windows:

```powershell
npm ci
npm test
npm run dist
```

For development without installing the app, run:

```powershell
npm run dev -w ghz-workbench
```

Conventional commits on `main` are automatically versioned by semantic-release
and published as GitHub Releases.

## License and trademarks

MIT licensed. Ghz Workbench is an independent, unofficial project and is not
approved, sponsored, or endorsed by Cfx.re, Rockstar Games, or Take-Two
Interactive. Product names are used only to describe compatibility.
