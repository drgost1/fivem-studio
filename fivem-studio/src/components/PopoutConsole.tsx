import { useCallback, useEffect, useState } from "react";

import type { ThemePack, ThemePreference } from "../global";
import { activateTheme } from "../theme";
import { ConsolePanel } from "./CenterPane";

export default function PopoutConsole() {
  const [connected, setConnected] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(2_000);
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");
  const [themePacks, setThemePacks] = useState<ThemePack[]>([]);

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
    void Promise.all([window.api.config.get(), window.api.theme.listPacks()]).then(async ([config, packs]) => {
      if (cancelled) return;
      setRefreshIntervalMs(config.consoleRefreshIntervalMs);
      setThemePreference(config.theme);
      setThemePacks(packs);
      const resolved = config.theme === "system" ? await window.api.theme.system() : config.theme;
      if (!cancelled) activateTheme(resolved, packs);
    });
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshStatus]);

  useEffect(() => window.api.theme.onSystemChanged((theme) => {
    if (themePreference === "system") activateTheme(theme, themePacks);
  }), [themePacks, themePreference]);

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
