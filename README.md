<p align="center">
  <img src="fivem-studio/build/icon.png" width="130" alt="Tufan Studio kitsune logo" />
</p>

<h1 align="center">FiveM Studio</h1>

<p align="center"><strong>by <a href="https://www.tufanstudio.net">Tufan Studio</a></strong></p>

A Windows workbench for Cfx.re server development. Edit resources, tail the console,
restart scripts, and see the live game — against a server on **this PC** or on a
**VPS over SSH** — in one window, with an AI-ready MCP runtime underneath.

Built on [QB Studio](https://github.com/qbcore-framework/qb-studio) by the QBCore
Framework (MIT), extended by Tufan Studio with remote-host support, multi-framework
Lua intelligence, and a working game viewport.

---

## What it does

| Area | What you get |
|---|---|
| **Remote host over SSH** | Point the app at an `~/.ssh/config` alias, browse the host's `txData` in a folder picker, edit and save files on the VPS, tail the txAdmin console, and start/stop/restart resources — while RCON never leaves the host's loopback. |
| **Game viewport** | The real, running FiveM client docks into the app (owner-overlay — the game window is never reparented, so it keeps rendering). Fit modes: **Native** (game keeps its own resolution, centered and cropped) or **Stretch** (fills the stage). Aspect presets: Free, 16:9, 16:10, 4:3, 21:9. |
| **Editor + Lua intelligence** | Monaco with LuaLS, FiveM/RedM natives, and a **selectable framework pack**: QBCore, Qbox (`qbx_core` exports, numeric grades), ESX Legacy (`xPlayer`, accounts), or platform-only. |
| **MCP runtime** | The coding runtime is a Model Context Protocol server. The built-in Agent Chat uses it — and so can Claude Code or any MCP client (see below). |
| **Console + resources** | Read the FXServer console from txAdmin's log, see started/stopped state per resource, restart one resource in seconds. |

### Security posture

- RCON is **loopback-only, always** — remote mode runs the runtime *on* the host so
  the plaintext UDP RCON never crosses a network; SSH carries an authenticated
  tunnel instead.
- **The default MCP surface is eight tools** — no file access, no arbitrary command
  execution, no raw RCON, no player/entity control. That is what a fresh clone and
  a stock deployment expose.
- Anything beyond those eight is an **explicit operator opt-in** via an environment
  flag, and stays absent from `tools/list` until you set it. See
  [Optional capabilities](#optional-capabilities-off-unless-you-enable-them) for
  what each flag adds and how paths are jailed.
- Secrets stay out of `argv` and out of the renderer; `rcon_password` is read from
  `server.cfg` *on the host* and never transmitted.

---

## Quick start

Requirements: **Windows**, **Node 24.20.0 + npm 11.19.0**, Git. A FiveM server —
local (txAdmin + `txData`) or reachable via an SSH alias with key auth.

```bash
git clone https://github.com/drgost1/fivem-studio.git
cd fivem-studio
npm install
npm run dev
```

### Local server

Settings → **Local host**: pick your `txData` root and server-data workspace, follow
the readiness checklist (it can write a protected RCON credential for you), attach
the workspace in txAdmin, start FXServer.

### Remote server (VPS)

1. Install Node 24 on the host (any path — `~/.qb-studio/node` works fine).
2. Settings → **Remote host** → On.
3. **SSH host**: pick your alias from the dropdown (read from `~/.ssh/config` —
   only host names are read, never keys).
4. **Workspace**: click *Browse…* and walk to the folder that contains `server.cfg`
   (usually `.../txDataN/server-data`). Folders that already hold a `server.cfg`
   are badged.
5. **RCON port**: the game port from that server's `endpoint_add_udp`.
6. **Detect Node** fills the interpreter path; the runtime uploads itself on connect.
7. Save & Connect.

The console needs txAdmin's on-disk log; the app finds the control profile
automatically from the workspace.

### Docking the game

Launch FiveM (windowed or borderless), open **Viewport → Scan**, click the
candidate. Use the **Fit** and **Aspect** pickers above the stage. Detach hands the
window back exactly as it was.

---

## MCP: connect Claude Code (or any MCP client)

The runtime (`fivem-mcp-server/`, bundled as `runtime.cjs`) speaks MCP over
**stdio** or **streamable HTTP**. Out of the box it exposes eight tools:

| Tool | What it does |
|---|---|
| `list_resources` | Workspace resources + which ones the server reports started |
| `start_resource` / `stop_resource` / `restart_resource` | Lifecycle for one named resource via loopback RCON |
| `get_console_output` | Recent FXServer console lines from txAdmin's log |
| `get_errors` | Only the errors/warnings from recent console output, de-duplicated and attributed to the resource that produced them |
| `restart_and_verify` | Restart a resource **and report whether it actually came up clean** — marks the console position, sends `ensure`, then returns only the new errors plus the resulting state |
| `get_runtime_identity` | Which workspace/server this runtime controls (secret-free) |

### Optional capabilities (off unless you enable them)

An agent editing a remote server through plain SSH pays a fresh handshake for
every file read, edit and git step. These tool groups run the same work *on the
host*, over the one connection the MCP client already holds — measured against a
remote VPS, four operations took **4.30 s** as separate `ssh`
calls and **0.73 s** as MCP tool calls.

Set these in the runtime's env file; each is absent from `tools/list` unless its
flag is `1`:

| Flag | Tools |
|---|---|
| `MCP_ENABLE_FILES=1` | `read_file` (returns sha256), `write_file` (atomic, optional `expected_sha256` conflict check), `edit_file` (exact-substring — no full resend), `list_dir`, `search_files`, `check_lua` (parse before you restart a resource), and **`batch`** — up to 25 of those in a single call |
| `MCP_ENABLE_GIT=1` | `git_status` (fetches first, so ahead/behind is truthful), `git_diff`, `git_log`, `git_pull`, and **`git_sync`** — add + commit + push in one call, so GitHub never drifts from the server |
| `MCP_ENABLE_RAW_RCON=1` | `server_command` — the full FXServer console (`refresh`, `ensure`, convars) |
| `MCP_ENABLE_SHELL=1` | `run_command` — bounded arbitrary execution (timeout + output cap + cwd inside the roots) |
| `MCP_WORKSPACE_ROOTS=/path[:/path]` | Jail for every file/git/shell path. Defaults to the server-data workspace and its parent |

Git calls run as each repository's **owning user** (`sudo -n -u '#uid' -H`),
because deploy keys and `github.com-*` ssh aliases belong to that user rather
than to whoever runs the runtime.

### Recommended: stdio over SSH (for a VPS server)

On the host, create an env file and a wrapper (once):

```bash
# ~/.qb-studio/runtime.env  (chmod 600)
RCON_HOST=127.0.0.1
RCON_PORT=30120
RCON_PASSWORD=<from server.cfg>
SERVER_DATA_WORKSPACE=/srv/fxserver/txData/server-data
SERVER_CONFIG_PATH=/srv/fxserver/txData/server-data/server.cfg
TXADMIN_DATA_DIR=/srv/fxserver/txData
TXADMIN_CONTROL_PROFILE=default
```

```bash
# ~/.qb-studio/mcp-stdio.sh  (chmod 700)
#!/bin/sh
set -a; . "$HOME/.qb-studio/runtime.env"; set +a
MCP_TRANSPORT=stdio; export MCP_TRANSPORT
exec "$HOME/.qb-studio/node/bin/node" "$HOME/.qb-studio/runtime.cjs"
```

Then in the folder where you run Claude Code, add `.mcp.json`:

```json
{
  "mcpServers": {
    "fivem1": {
      "command": "ssh",
      "args": ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
               "fivem", "~/.qb-studio/mcp-stdio.sh"]
    }
  }
}
```

Open a Claude Code session in that folder — the tools appear (the base eight, plus
whichever optional groups that env file enables), driving your live server. One
entry per server (different env files) scales to a whole fleet.

### Alternative: HTTP + SSH tunnel

Run the runtime on the host with `MCP_TRANSPORT=http`, `MCP_HOST=127.0.0.1`,
`MCP_PORT=3414` and an `MCP_TOKEN`; then `ssh -L 3414:127.0.0.1:3414 <host>` and
point any streamable-HTTP MCP client at `http://127.0.0.1:3414/mcp` with the
bearer token. The listener refuses to bind anything but loopback by design.

---

## Development

```bash
npm run typecheck      # runtime + app
npm run check:static   # repository invariants
npm run dev            # vite + electron
```

The repo is an npm workspace: `fivem-studio/` (Electron app) and
`fivem-mcp-server/` (the MCP runtime). Node/npm versions are pinned; the
committed lockfile is the source of truth.

---

## Credits & license

- Forked from **[QB Studio](https://github.com/qbcore-framework/qb-studio)** by the
  **QBCore Framework** — thank you. MIT license retained; see [LICENSE](LICENSE).
- Lua platform definitions from
  [overextended/fivem-lls-addon](https://github.com/overextended/fivem-lls-addon)
  (MIT) and the official Cfx.re natives dataset.
- **FiveM Studio is not approved, sponsored, or endorsed by Cfx.re, Rockstar
  Games, or Take-Two Interactive.** FiveM® is a registered trademark of its owner;
  the name is used descriptively for a tool that works with the FiveM platform.

*Tufan Studio — Bangladesh. We build game things.*
