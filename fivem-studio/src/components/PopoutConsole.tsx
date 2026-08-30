import { useCallback, useEffect, useState } from "react";

import type { ThemePreference } from "../global";
import { ConsolePanel } from "./CenterPane";

export default function PopoutConsole() {
  const [connected, setConnected] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(2_000);
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");

  const refreshStatus = useCallback(async () => {
    try {
      const status = await window.api.mcp.status();
      const matchesWorkspace = status.workspaceMatch?.ok === true;
      setConnected(status.connected && matchesWorkspace);
      setAvailable(status.connected && matchesWorkspace ? (status.runtimeIdentity?.capabilities.console ?? null) : null);
    } catch {
      setConnected(false);
      setAvailable(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api.config.get().then(async (config) => {
      if (cancelled) return;
      setRefreshIntervalMs(config.consoleRefreshIntervalMs);
      setThemePreference(config.theme);
      const resolved = config.theme === "system" ? await window.api.theme.system() : config.theme;
      if (!cancelled) document.documentElement.dataset.theme = resolved;
    });
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshStatus]);

  useEffect(() => window.api.theme.onSystemChanged((theme) => {
    if (themePreference === "system") document.documentElement.dataset.theme = theme;
  }), [themePreference]);

  useEffect(() => window.api.console.onRefreshIntervalChanged(setRefreshIntervalMs), []);

  return (
    <main className="console-popout-root">
      <ConsolePanel
        active
        connected={connected}
        available={available}
        refreshIntervalMs={refreshIntervalMs}
        onRefreshIntervalChange={async (intervalMs) => {
          await window.api.console.setRefreshInterval(intervalMs);
          setRefreshIntervalMs(intervalMs);
        }}
        refreshSignal={null}
        crashTriage={null}
        onDismissCrashTriage={() => undefined}
        onSendCrashTriage={() => undefined}
        onOutputChange={() => undefined}
      />
    </main>
  );
}
