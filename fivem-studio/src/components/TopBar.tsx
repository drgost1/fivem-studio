import type { CfxTarget, RuntimeIdentity, RuntimeWorkspaceMatch } from "../global";

interface TopBarProps {
  connected: boolean;
  runtimeIdentity: RuntimeIdentity | null;
  workspaceMatch: RuntimeWorkspaceMatch | null;
  onOpenSettings: () => void;
  onLaunchServer: () => void;
  onStopServer: () => void;
  onLaunchClient: () => void;
  activeTarget: CfxTarget;
  serverTarget: CfxTarget;
  activeServerPath: string | null;
  serverConfigured: boolean;
  serverAction: "starting" | "stopping" | null;
  serverRunning: boolean;
  serverPids: number[];
  serverStatusError: string | null;
  activeClientPath: string | null;
}

export default function TopBar({
  connected,
  runtimeIdentity,
  workspaceMatch,
  onOpenSettings,
  onLaunchServer,
  onStopServer,
  onLaunchClient,
  activeTarget,
  serverTarget,
  activeServerPath,
  serverConfigured,
  serverAction,
  serverRunning,
  serverPids,
  serverStatusError,
  activeClientPath,
}: TopBarProps) {
  const labelFor = (target: CfxTarget) => target === "legacy" ? "FiveM Legacy" : target === "enhanced" ? "FiveM Enhanced" : "RedM";
  const activeLabel = labelFor(activeTarget);
  const serverLabel = labelFor(serverTarget);
  const clientExecutable = activeTarget === "redm" ? "RedM.exe" : "FiveM.exe";
  const runtimeReady = connected && workspaceMatch?.ok === true;
  const statusLabel = !connected
    ? "Coding runtime unavailable"
    : runtimeReady
      ? "Coding runtime ready"
      : "Coding runtime ready · read only";
  const availabilityNote = "The coding runtime does not confirm that FXServer is running.";
  const statusTitle = !connected
    ? "QB Studio could not reach its bundled coding runtime."
    : `${workspaceMatch?.reason ?? (runtimeIdentity ? `${runtimeIdentity.mcp.name} ${runtimeIdentity.mcp.version}` : "Bundled coding runtime")}. ${availabilityNote}`;
  return (
    <div className="topbar">
      <span className="brand">QB Studio</span>
      <div className="spacer" />
      <div className="status-pill" title={statusTitle}>
        <span className={`status-dot ${runtimeReady ? "connected" : connected ? "limited" : "disconnected"}`} />
        {statusLabel}
      </div>
      <button
        className="btn"
        onClick={serverRunning ? onStopServer : onLaunchServer}
        disabled={serverAction !== null || (!serverRunning && (!activeServerPath || !serverConfigured))}
        title={
          serverStatusError
            ? `Server status unavailable: ${serverStatusError}`
            : serverRunning
              ? `Stop the ${serverLabel} local server${serverPids.length ? ` (process ${serverPids.join(", ")})` : ""}`
            : !activeServerPath
            ? `Set the ${activeLabel} server executable in Settings`
            : !serverConfigured
              ? "Choose a txData workspace in Settings"
              : activeServerPath
        }
      >
        {serverAction === "starting"
          ? "Starting…"
          : serverAction === "stopping"
            ? "Stopping…"
            : serverRunning
              ? `■ Stop ${serverLabel} server`
              : `▶ Start ${activeLabel} server`}
      </button>
      <button className="btn" onClick={onLaunchClient} disabled={!activeClientPath} title={activeClientPath ?? `Set the ${activeLabel} ${clientExecutable} path in Settings`}>
        ▶ Launch {activeLabel}
      </button>
      <button className="btn" onClick={onOpenSettings}>
        ⚙ Settings
      </button>
    </div>
  );
}
