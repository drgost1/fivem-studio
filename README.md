# FiveM Studio

**by [Tufan Studio](https://www.tufanstudio.net)**

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

### Security posture (inherited from upstream, kept intact)

- RCON is **loopback-only, always** — remote mode runs the runtime *on* the host so
  the plaintext UDP RCON never crosses a network; SSH carries an authenticated
  tunnel instead.
- The MCP surface is deliberately small: six tools, no arbitrary command execution,
  no raw RCON, no player/entity control.
- Secrets stay out of `argv` and out of the renderer; `rcon_password` is read from
  `server.cfg` *on the host* and never transmitted.

---

## Quick start

Requirements: **Windows**, **Node 24.20.0 + npm 11.19.0**, Git. A FiveM server —
local (txAdmin + `txData`) or reachable via an SSH alias with key auth.

```bash
git clone https://github.com/drgost1/qb-studio.git
cd qb-studio
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
**stdio** or **streamable HTTP**. It exposes exactly six tools:

| Tool | What it does |
|---|---|
| `list_resources` | Workspace resources + which ones the server reports started |
| `start_resource` / `stop_resource` / `restart_resource` | Lifecycle for one named resource via loopback RCON |
| `get_console_output` | Recent FXServer console lines from txAdmin's log |
| `get_runtime_identity` | Which workspace/server this runtime controls (secret-free) |

### Recommended: stdio over SSH (for a VPS server)

On the host, create an env file and a wrapper (once):

```bash
# ~/.qb-studio/runtime.env  (chmod 600)
RCON_HOST=127.0.0.1
RCON_PORT=30120
RCON_PASSWORD=<from server.cfg>
SERVER_DATA_WORKSPACE=/home/fivem/txData1/server-data
SERVER_CONFIG_PATH=/home/fivem/txData1/server-data/server.cfg
TXADMIN_DATA_DIR=/home/fivem/txData1
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

Open a Claude Code session in that folder — the six tools appear, driving your
live server. One entry per server (different env files) scales to a whole fleet.

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
