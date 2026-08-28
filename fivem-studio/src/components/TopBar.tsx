import type { RuntimeIdentity, RuntimeWorkspaceMatch } from "../global";

interface TopBarProps {
  connected: boolean;
  runtimeIdentity: RuntimeIdentity | null;
  workspaceMatch: RuntimeWorkspaceMatch | null;
  onOpenSettings: () => void;
  onLaunchFivem: () => void;
  fivemExePath: string | null;
}

export default function TopBar({
  connected,
  runtimeIdentity,
  workspaceMatch,
  onOpenSettings,
  onLaunchFivem,
  fivemExePath,
}: TopBarProps) {
  const runtimeReady = connected && workspaceMatch?.ok === true;
  const statusLabel = !connected
    ? "Coding runtime unavailable"
    : runtimeReady
      ? "Coding runtime ready"
      : "Coding runtime ready · read only";
  const availabilityNote = "The coding runtime does not confirm that FXServer is running.";
  const statusTitle = !connected
    ? "Ghz Workbench could not reach its bundled coding runtime."
    : `${workspaceMatch?.reason ?? (runtimeIdentity ? `${runtimeIdentity.mcp.name} ${runtimeIdentity.mcp.version}` : "Bundled coding runtime")}. ${availabilityNote}`;
  return (
    <div className="topbar">
      <span className="brand">Ghz Workbench</span>
      <div className="spacer" />
      <div className="status-pill" title={statusTitle}>
        <span className={`status-dot ${runtimeReady ? "connected" : connected ? "limited" : "disconnected"}`} />
        {statusLabel}
      </div>
      <button className="btn" onClick={onLaunchFivem} disabled={!fivemExePath} title={fivemExePath ?? "Set FiveM.exe path in Settings"}>
        ▶ Launch client
      </button>
      <button className="btn" onClick={onOpenSettings}>
        ⚙ Settings
      </button>
    </div>
  );
}
