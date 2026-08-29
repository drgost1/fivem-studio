# QB Studio

QB Studio is QBCore Framework's Windows desktop workspace for coding resources
against your own localhost Cfx.re server. It puts the editor, resource tree,
console, GitHub imports, AI coding assistant, and an optional passive
local-client preview in one app.

It is a development tool—not a server administration or gameplay tool. Its
control traffic never leaves numeric loopback, and it does not expose player
actions, raw RCON, arbitrary Lua execution, spawning, teleporting, or
screenshots.

## Highlights

- Monaco code editor with safe, conflict-aware saves
- txData workspace browser and minimal local-workspace creator
- Separate one-click launchers and paths for FiveM Legacy, FiveM Enhanced, and RedM
- Recommended/Latest server-artifact updates with staging and rollback backup
- Read-only console plus approved resource refresh controls for coding loops
- GitHub repository and organization search with resource imports
- AI assistant scoped to project files and coding-oriented runtime tools
- Bundled private runtime: no separate Node or MCP server to launch

GitHub imports require [Git for Windows](https://git-scm.com/download/win).

## Install

Download the latest Windows installer from
[Releases](https://github.com/qbcore-framework/qb-studio/releases) and run it once.
Choose the `.exe`; GitHub automatically adds source-code ZIP and TAR archives,
but they are not installers.
QB Studio does not require any resource to be added to your server. Point
it at an existing Cfx.re Windows server artifact and it can start that local
server, launch the selected FiveM or RedM client separately, and update the artifact files.

## First run

You need an existing local FXServer installation with txAdmin, its `txData`
folder, and a Cfx.re server license key.

### Use an existing local workspace

1. Confirm the editable server-data folder is a direct child of `txData`,
   normally `txData\YourServer.base`, and contains `server.cfg` and
   `resources\`.
2. Leave the existing `endpoint_add_tcp` and `endpoint_add_udp` lines alone.
   QB Studio reads their port; the standard `0.0.0.0` or `[::]` bind is
   converted to a loopback RCON destination internally. Do not add duplicate
   endpoint lines. Explicit LAN/public addresses and hostnames are rejected.
3. Add a non-empty password. The simplest option is a line in `server.cfg`:

   ```cfg
   set rcon_password "CHOOSE_A_LOCAL_DEVELOPMENT_PASSWORD"
   ```

   If the standard config already has `#set rcon_password ""`, remove the
   leading `#` and replace the empty value.

   To keep it out of source control, instead create `secrets.cfg` beside
   `server.cfg`, put that line in it, and load it from `server.cfg`:

   ```cfg
   exec secrets.cfg
   ```

   There is intentionally no RCON field in Settings: FXServer and QB Studio
   both read the selected local configuration, so there is only one password
   to maintain. Exclude `secrets.cfg` from Git.

   A stock wildcard bind may still make FXServer reachable through other
   network interfaces depending on Windows Firewall/router settings. QB Studio
   only uses it to discover the port and still sends RCON to loopback. Use a
   local development profile that is never port-forwarded or publicly hosted.
4. In txAdmin, make sure one control profile points its `server.dataPath` to
   that exact server-data folder.
5. Open QB Studio Settings and choose:

   - the `txData` root;
   - the server-data workspace—not the txAdmin control-profile folder;
   - `FXServer.exe` or `cfx-server.exe` from the downloaded server artifact;
   - optionally, `FiveM.exe` or `RedM.exe` for the separate client launcher.

6. Select **Save & Connect**, then use **Start server** in the top bar. Legacy
   FXServer can select a matching named txAdmin profile automatically; current
   Enhanced artifacts use txAdmin's default profile and require a separate
   `txData` root per server. The server runs in the background so it does not
   leave another console window open. While that exact configured process is
   running, the button changes to **Stop server**; use it (or txAdmin) to stop
   the local server before closing QB Studio.

### Create a new local workspace

1. In QB Studio Settings, choose the `txData` root, enter a workspace name and
   port under **Local workspace**, select **Create**, then **Save**.
2. In the new `YourName.base` folder, copy `secrets.cfg.example` to
   `secrets.cfg` and add your own values:

   ```cfg
   sv_licenseKey "YOUR_OWN_LICENSE_KEY"
   set rcon_password "CHOOSE_A_LOCAL_DEVELOPMENT_PASSWORD"
   ```

3. In its `server.cfg`, change `# exec secrets.cfg` to `exec secrets.cfg`.
   `secrets.cfg` is already excluded from Git.
4. Choose `FXServer.exe` or `cfx-server.exe` in QB Studio Settings, save, then
   use **Start server**. In the txAdmin setup that opens, choose **Existing
   Server Data**, point it at the new `.base` folder and its `server.cfg`, then
   select **Save & Start Server**.
   The [official txAdmin setup guide](https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/)
   covers installing and opening txAdmin.
5. Return to QB Studio and select **Save** in Settings again—or restart the
   app—so it rescans the updated configuration and txAdmin attachment.

## How the local connection works

| Feature | Requirement |
| --- | --- |
| Editor, files, and GitHub import | Selected server-data workspace only |
| Start local server | Selected Cfx.re server executable, txData root, and workspace |
| Launch client | Selected `FiveM.exe` or `RedM.exe` |
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

## Server artifact updates

In Settings, save the server executable path and select **Check**. Recommended
is the safe default; Latest is an explicit preview-track choice for legacy
FXServer. Both legacy `FXServer.exe` and Enhanced `cfx-server.exe` artifacts
are supported.

Use **Stop server** (or stop it in txAdmin) before selecting **Install update**. QB Studio
downloads from the [official Cfx.re server page](https://docs.fivem.net/docs/server-download/),
checks the expected HTTPS host, size, archive paths, file count, extracted
size, and per-file CRC, then extracts to a sibling staging folder. Only after
that structural validation does it swap the artifact directory. A durable
recovery journal restores or completes the swap after an app/PC interruption.
The previous directory is kept as a sibling backup and is restored
automatically if the swap fails.
`txData`, resources, configs, secrets, and databases are never part of that
replacement.

Cfx.re does not currently publish a separate checksum or signature with these
Windows artifacts, so QB Studio does not claim publisher-signature
verification. It records its own SHA-256 after download for the local install
record.

Early releases are unsigned, so Windows may show an “Unknown publisher” or
SmartScreen warning. Download only from the `qbcore-framework/qb-studio` release
page and verify the GitHub build attestation:

```powershell
gh attestation verify <installer> -R qbcore-framework/qb-studio --signer-workflow qbcore-framework/qb-studio/.github/workflows/release.yml
```

The release workflow also records a CycloneDX SBOM attestation without adding
another user-facing download to the release.

## Code signing policy

QB Studio has applied to the SignPath Foundation open-source program for
Authenticode signing. Free code signing provided by SignPath.io, certificate by
SignPath Foundation.

The current `v1.0.0` installer predates approval and remains unsigned. After
onboarding, signed builds will be published as new releases rather than silently
replacing existing assets. See the full [code signing policy](CODE_SIGNING_POLICY.md)
for the controlled build and approval process, and review the
[privacy policy](PRIVACY.md) for local storage and optional third-party network
features.

## Build from source

Requires Node.js 22 and Windows:

```powershell
npm ci
npm test
npm run dist
```

For development without installing the app, run:

```powershell
npm run dev -w qb-studio
```

Conventional commits on `main` are automatically versioned by semantic-release
and published as GitHub Releases.

## License and trademarks

MIT licensed and maintained by QBCore Framework. QB Studio is not approved,
sponsored, or endorsed by Cfx.re, Rockstar Games, or Take-Two Interactive.
Those product names are used only to describe compatibility.
