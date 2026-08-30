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
  "setup.checklist.title": "Setup readiness",
  "setup.checklist.help": "Each check maps to one concrete action. QB Studio never scans entire drives.",
  "setup.checklist.progress": "{ready}/{total} ready",
  "setup.check.txData": "txData root selected",
  "setup.check.workspace": "Server-data workspace ready",
  "setup.check.server": "{target} server executable",
  "setup.check.client": "{target} client executable",
  "setup.check.txAdmin": "Workspace attached in txAdmin",
  "setup.check.rcon": "Local RCON capability",
  "setup.check.git": "Git available on PATH",
  "setup.action.browse": "Browse…",
  "setup.action.chooseWorkspace": "Choose workspace",
  "setup.action.openGuide": "Open guide",
  "setup.action.setupRcon": "Set up",
  "setup.action.installGit": "Get Git",
  "setup.state.ready": "Ready",
  "setup.state.checking": "Checking…",
  "setup.detected": "Detected conventional install — confirm with Save & Connect.",
  "setup.rcon.previewTitle": "Local RCON setup preview",
  "setup.rcon.previewHelp": "The password is generated only when you apply. It is never displayed, sent to the renderer, or stored in undo history.",
  "setup.rcon.existing": "This workspace already has an RCON password. Applying will rotate it after an explicit confirmation.",
  "setup.rcon.action.create": "Create",
  "setup.rcon.action.update": "Update",
  "setup.rcon.action.unchanged": "Already ready",
  "setup.rcon.change.load-secret-file": "Load secrets.cfg after existing server settings",
  "setup.rcon.change.write-redacted-password": "Write set rcon_password \"<generated securely during apply>\"",
  "setup.rcon.change.ignore-secret-file": "Ensure secrets.cfg is ignored by Git",
  "setup.rcon.apply": "Apply secure setup",
  "setup.rcon.applying": "Applying…",
  "setup.rcon.cancel": "Cancel preview",
  "setup.rcon.confirmRotate": "Replace the existing local RCON password?\n\nQB Studio will generate a new password and update secrets.cfg. The existing password will stop working after FXServer restarts.",
  "setup.rcon.applied": "Local RCON setup is ready. Restart FXServer, then Save & Connect so the runtime uses the new credential.",
  "setup.rcon.needWorkspace": "Choose a txData root and server-data workspace before setting up local RCON.",
  "setup.rcon.applyError": "Could not apply local RCON setup.",
  "setup.workspace.created": "Created and selected {workspace}. Use Set up beside Local RCON capability, attach this .base folder in txAdmin as Existing Server Data, then Save & Connect.",
  "setup.guide.title": "Local workspace flow",
  "setup.guide.workspace": "Create or select a server-data workspace below this txData root.",
  "setup.guide.endpoint": "Keep the loopback endpoint_add_tcp/udp lines in server.cfg; QB Studio uses their port only for local RCON.",
  "setup.guide.rcon": "Use the readiness checklist to create a protected local RCON credential without opening a config file.",
  "setup.guide.txAdmin": "Attach this exact workspace in txAdmin as Existing Server Data and start FXServer.",
  "setup.guide.rescan": "Save & Connect after configuration changes so QB Studio rescans the workspace.",
} as const;

export type MessageKey = keyof typeof english;
export type MessageVariables = Record<string, string | number>;

export function t(key: MessageKey, variables: MessageVariables = {}): string {
  return english[key].replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : token,
  );
}

export const defaultLocale = "en" as const;
