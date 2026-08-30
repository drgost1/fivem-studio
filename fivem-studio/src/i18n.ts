/**
 * English-first localization catalog. QB Studio ships English today, but new
 * user-facing strings enter this catalog so adding another locale does not
 * require another sweep through component markup.
 */
const english = {
  "common.start": "Start",
  "common.stop": "Stop",
  "common.restart": "Restart",
  "common.starting": "Starting…",
  "common.restarting": "Restarting…",
  "resource.state.started": "started",
  "resource.state.stopped": "stopped",
  "resource.state.unknown": "state unavailable",
  "resource.context.start": "Start {resource}",
  "resource.context.stop": "Stop {resource}",
  "resource.context.restart": "Restart {resource}",
  "resource.context.unavailable": "Server state unavailable",
  "resource.confirmStop": "Stop resource \"{resource}\"?",
  "resource.actionSuccess": "{resource} {action} successfully.",
  "resource.actionFailure": "Could not {action} {resource}: {message}",
  "resource.readOnly": "Resource controls are unavailable until the local runtime matches this workspace.",
  "editor.resourceStopped": "This resource is stopped. Saved changes are not live yet.",
  "editor.startResource": "Start resource",
  "editor.restartResource": "Restart resource",
  "editor.restartAfterSave": "Restart a running resource after saving",
  "editor.restartAfterSaveHelp": "When a saved file belongs to a resource that is already running, restart it and open the refreshed console.",
  "editor.savedAndRestarted": "Saved and restarted {resource}.",
  "console.refreshAfterRestart": "Refreshing console after restarting {resource}…",
  "appearance.section": "Appearance",
  "appearance.theme": "Theme",
  "appearance.theme.system": "System",
  "appearance.theme.dark": "Dark — Nightshift",
  "appearance.theme.light": "Light — Daybreak",
  "appearance.theme.highContrast": "High Contrast",
  "appearance.themeHelp": "System follows the current Windows light or dark setting. The app chrome and code editors update together.",
} as const;

export type MessageKey = keyof typeof english;
export type MessageVariables = Record<string, string | number>;

export function t(key: MessageKey, variables: MessageVariables = {}): string {
  return english[key].replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : token,
  );
}

export const defaultLocale = "en" as const;
