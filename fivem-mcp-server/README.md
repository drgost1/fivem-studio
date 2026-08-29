# QB Studio runtime

This package is the private loopback sidecar bundled with QB Studio. It is
not a server administration product and is not intended to run on a remote or
live server.

It exposes only five coding-session tools:

- read recent local FXServer console output;
- list resources;
- start, stop, or restart a named resource.

There are deliberately no player, entity, teleport, spawn, screenshot,
arbitrary Lua, or raw RCON tools. The HTTP listener and RCON target are both
restricted to loopback addresses.

For standalone development:

```powershell
npm install
npm test
npm run bundle
```

The desktop release starts this runtime automatically with an ephemeral port
and bearer token.
