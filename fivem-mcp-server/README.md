# FiveM Studio runtime

This package is the loopback sidecar bundled with FiveM Studio. It is a coding
sidecar, not a server administration product: it binds to loopback only, and in
remote mode it runs **on** the server host itself so that RCON never crosses a
network.

By default it exposes six coding-session tools:

- report the runtime's own identity (which workspace and server it controls);
- read recent FXServer console output;
- list resources with their started/stopped state;
- start, stop, or restart a named resource.

There are deliberately no player, entity, teleport, spawn, screenshot, or
arbitrary-Lua tools at any setting.

## Optional capabilities

Coding agents that would otherwise pay a fresh SSH round trip per file read,
edit or git step can be given more reach. Each group is **off unless its flag is
set**, and stays absent from `tools/list` until then:

| Flag | Adds |
|---|---|
| `MCP_ENABLE_FILES=1` | `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `check_lua` |
| `MCP_ENABLE_GIT=1` | `git_status`, `git_diff`, `git_log`, `git_pull`, `git_sync` |
| `MCP_ENABLE_RAW_RCON=1` | `server_command` — the full FXServer console |
| `MCP_ENABLE_SHELL=1` | `run_command` — bounded shell execution |
| `MCP_WORKSPACE_ROOTS` | Path-list jail for all of the above (default: the server-data workspace and its parent) |

Every path these tools accept is resolved and checked against the workspace
roots before use, and every spawned process has a hard timeout and an output
cap. Git commands run as the owning user of the repository they act on, so a
repo's own deploy key and ssh host alias apply.

For standalone development:

```powershell
npm install
npm test
npm run bundle
```

Standalone HTTP mode fails closed unless `MCP_TOKEN` is set. Clients must send
that value as `Authorization: Bearer <MCP_TOKEN>`. For a deliberate local-only
development session, unauthenticated HTTP can be enabled explicitly with
`MCP_UNSAFE_ALLOW_NO_TOKEN=1`; the listener remains restricted to numeric
loopback addresses. Stdio mode does not require an HTTP token.

The desktop release starts this runtime automatically with an ephemeral port
and bearer token.
