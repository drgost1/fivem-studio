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
    let appearanceGeneration = 0;
    const applyConfig = async (config: Awaited<ReturnType<typeof window.api.config.get>>) => {
      if (cancelled) return;
      const generation = ++appearanceGeneration;
      // Interval persistence has its own ordered event. Apply the snapshot
      // before theme I/O so an older appearance request cannot later overwrite
      // a newer refresh-interval event.
      setRefreshIntervalMs(config.consoleRefreshIntervalMs);
      const packs = await window.api.theme.listPacks();
      const resolved = config.theme === "system" ? await window.api.theme.system() : config.theme;
      if (cancelled || generation !== appearanceGeneration) return;
      setThemePreference(config.theme);
      setThemePacks(packs);
      activateTheme(resolved, packs);
    };
    const safelyApplyConfig = (config: Awaited<ReturnType<typeof window.api.config.get>>) => {
      void applyConfig(config).catch(() => {
        // Keep the last usable appearance if a theme pack is temporarily unreadable.
      });
    };
    void window.api.config.get().then(safelyApplyConfig).catch(() => {
      // Defaults remain usable when the persisted config cannot be loaded.
    });
    const disposeConfig = window.api.config.onChanged(safelyApplyConfig);
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 2_000);
    return () => {
      cancelled = true;
      disposeConfig();
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
        agentEnabled={false}
        onOutputChange={() => undefined}
      />
    </main>
  );
}
