import { useEffect, useState } from "react";
import type { ArtifactStatus, CfxTarget, ProfileInfo, StudioConfig } from "../global";
import { COST_LABEL, PROVIDER_PRESETS, matchPreset } from "../providerPresets";

interface SettingsModalProps {
  config: StudioConfig;
  onSave: (config: StudioConfig) => Promise<void>;
  onClose: () => void;
}

const CFX_TARGETS: readonly CfxTarget[] = ["legacy", "enhanced", "redm"];

function cfxTargetLabel(target: CfxTarget): string {
  if (target === "legacy") return "FiveM Legacy";
  if (target === "enhanced") return "FiveM Enhanced";
  return "RedM";
}

function serverExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFxServerExePath;
  if (target === "enhanced") return config.enhancedFxServerExePath;
  return config.redmFxServerExePath;
}

function clientExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFivemExePath;
  if (target === "enhanced") return config.enhancedFivemExePath;
  return config.redmClientExePath;
}

export default function SettingsModal({ config, onSave, onClose }: SettingsModalProps) {
  const [draft, setDraft] = useState<StudioConfig>(config);
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  // The stored key is never readable from here — the main process only reports
  // whether one exists. An empty box therefore means "leave whatever's saved
  // alone", not "clear it"; clearing is an explicit button.
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [hasLocalKey, setHasLocalKey] = useState(false);
  const [localKeyDraft, setLocalKeyDraft] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [toolCapable, setToolCapable] = useState<Record<string, boolean> | undefined>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspacePort, setWorkspacePort] = useState("30120");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [artifactStatus, setArtifactStatus] = useState<ArtifactStatus | null>(null);
  const [artifactBusy, setArtifactBusy] = useState<"checking" | "updating" | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactMessage, setArtifactMessage] = useState<string | null>(null);

  /** Asks the endpoint what it actually serves, rather than making the user guess a model id. */
  async function loadModels() {
    setLoadingModels(true);
    setModelsError(null);
    try {
      // Pass the typed key so this works before Save, when nothing is stored yet.
      const result = await window.api.agent.listModels(draft.openaiBaseUrl, localKeyDraft.trim() || undefined);
      if (result.ok && result.models) {
        setModels(result.models);
        setToolCapable(result.toolCapable);
        // Nothing chosen yet, or the saved id isn't on this endpoint — pick a sane one.
        // The preset's own recommendation wins over a keyword match, which would
        // otherwise just take whatever sorted first (e.g. gemini-2.5 over 3.7).
        // Where capabilities are known, never auto-pick a model that can't call tools.
        if (!draft.openaiModel || !result.models.includes(draft.openaiModel)) {
          const usable = result.toolCapable
            ? result.models.filter((m) => result.toolCapable![m] !== false)
            : result.models;
          const pool = usable.length > 0 ? usable : result.models;
          const preferred =
            (preset.model && pool.includes(preset.model) ? preset.model : undefined) ??
            pool.find((m) => /flash|instruct|coder/i.test(m)) ??
            pool[0];
          setDraft((d) => ({ ...d, openaiModel: preferred }));
        }
      } else {
        setModels([]);
        setToolCapable(undefined);
        setModelsError(result.error ?? "Could not list models.");
      }
    } catch (err) {
      setModels([]);
      setToolCapable(undefined);
      setModelsError((err as Error).message || "Could not list models.");
    } finally {
      setLoadingModels(false);
    }
  }

  const preset = matchPreset(draft.agentProvider, draft.openaiBaseUrl);
  const isAnthropic = draft.agentProvider === "anthropic";
  const activeTarget = draft.activeCfxTarget;
  const activeServerPath = serverExeFor(draft, activeTarget);
  const savedActiveServerPath = serverExeFor(config, activeTarget);
  const artifactTrack = activeTarget === "enhanced"
    ? "recommended"
    : activeTarget === "redm"
      ? draft.redmArtifactTrack
      : draft.legacyArtifactTrack;
  const serverPathIsSaved = Boolean(activeServerPath && activeServerPath === savedActiveServerPath);

  /** Picking a provider fills in its endpoint and a starting model; both stay editable. */
  function applyPreset(id: string) {
    const next = PROVIDER_PRESETS.find((p) => p.id === id);
    if (!next) return;
    if (next.id === "anthropic") {
      setDraft((d) => ({ ...d, agentProvider: "anthropic" }));
      return;
    }
    setDraft((d) => ({
      ...d,
      agentProvider: "openai",
      // "Custom" keeps whatever's already typed rather than blanking it.
      openaiBaseUrl: next.id === "custom" ? d.openaiBaseUrl : next.baseUrl,
      openaiModel: next.id === "custom" ? d.openaiModel : next.model,
    }));
  }

  useEffect(() => {
    window.api.agent.hasApiKey().then(setHasApiKey);
  }, []);

  // Re-check per endpoint: keys are stored per provider, so switching the picker
  // must not keep showing "a key is saved" from the previous one.
  useEffect(() => {
    setLocalKeyDraft("");
    setModels([]);
    setModelsError(null);
    window.api.agent.hasProviderKey(draft.openaiBaseUrl).then(setHasLocalKey);
  }, [draft.openaiBaseUrl]);

  useEffect(() => {
    if (!draft.txDataPath) {
      setProfiles([]);
      return;
    }
    let cancelled = false;
    window.api.txdata
      .listProfiles(draft.txDataPath)
      .then((found) => {
        if (cancelled) return;
        setProfiles(found);
        setProfilesError(null);
        // Keep the current selection if it's still present, otherwise default to the first profile found.
        setDraft((d) => ({
          ...d,
          selectedProfile: found.some((p) => p.name === d.selectedProfile) ? d.selectedProfile : (found[0]?.name ?? null),
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setProfiles([]);
        setProfilesError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.txDataPath]);

  async function pickTxDataFolder() {
    const folder = await window.api.dialog.chooseFolder();
    if (folder) setDraft((d) => ({ ...d, txDataPath: folder, selectedProfile: null }));
  }

  async function pickExe(target: CfxTarget) {
    try {
      const exe = await window.api.dialog.chooseExe(target);
      if (!exe) return;
      setDraft((d) => {
        if (target === "legacy") return { ...d, legacyFivemExePath: exe };
        if (target === "enhanced") return { ...d, enhancedFivemExePath: exe };
        return { ...d, redmClientExePath: exe };
      });
    } catch (err) {
      setArtifactError((err as Error).message);
    }
  }

  async function pickFxServerExe(target: CfxTarget) {
    try {
      const exe = await window.api.dialog.chooseFxServerExe(target);
      if (!exe) return;
      setDraft((d) => {
        if (target === "legacy") return { ...d, legacyFxServerExePath: exe };
        if (target === "enhanced") return { ...d, enhancedFxServerExePath: exe };
        return { ...d, redmFxServerExePath: exe };
      });
    } catch (err) {
      setArtifactError((err as Error).message);
    }
  }

  async function checkArtifacts() {
    setArtifactBusy("checking");
    setArtifactError(null);
    setArtifactMessage(null);
    try {
      const status = await window.api.artifacts.check(activeTarget, artifactTrack);
      setArtifactStatus(status);
      if (status.recoveryNotice) setArtifactMessage(status.recoveryNotice);
    } catch (err) {
      setArtifactStatus(null);
      setArtifactError((err as Error).message || "Could not check Cfx.re artifacts.");
    } finally {
      setArtifactBusy(null);
    }
  }

  async function updateArtifacts() {
    if (!artifactStatus) return;
    const target = activeServerPath ? activeServerPath.replace(/[\\/][^\\/]+$/, "") : "the artifact folder";
    if (
      !confirm(
        `Install Cfx.re build ${artifactStatus.build} into ${target}?\n\n` +
          "The local server must be stopped. Workbench will replace only the artifact folder, keep the previous folder as a backup, and never modify txData.",
      )
    ) {
      return;
    }
    setArtifactBusy("updating");
    setArtifactError(null);
    setArtifactMessage(null);
    try {
      const result = await window.api.artifacts.update(activeTarget, artifactTrack);
      setArtifactStatus(result);
      setArtifactMessage(
        `Installed build ${result.build}. Previous artifacts are preserved at ${result.backupPath}.` +
          (result.warning ? ` ${result.warning}` : ""),
      );
    } catch (err) {
      setArtifactError((err as Error).message || "Could not update Cfx.re artifacts.");
    } finally {
      setArtifactBusy(null);
    }
  }

  useEffect(() => {
    setArtifactStatus(null);
    setArtifactError(null);
    setArtifactMessage(null);
  }, [activeTarget, activeServerPath, artifactTrack]);

  async function createWorkspace() {
    if (!draft.txDataPath) {
      setSaveError("Choose a txData folder before creating a local workspace.");
      return;
    }
    setCreatingWorkspace(true);
    setSaveError(null);
    setWorkspaceMessage(null);
    try {
      const created = await window.api.txdata.createLocalWorkspace(
        draft.txDataPath,
        workspaceName,
        Number(workspacePort),
        draft.activeCfxTarget,
      );
      const found = await window.api.txdata.listProfiles(draft.txDataPath);
      setProfiles(found);
      setProfilesError(null);
      setDraft((d) => ({ ...d, selectedProfile: created.name }));
      setWorkspaceMessage(
        `Created and selected ${created.name}. Save Settings, add secrets.cfg, attach this .base folder in txAdmin as Existing Server Data, start FXServer, then save Settings again to rescan.`,
      );
      setWorkspaceName("");
    } catch (err) {
      setSaveError((err as Error).message || "Could not create the local workspace.");
    } finally {
      setCreatingWorkspace(false);
    }
  }

  async function save() {
    setBusy(true);
    setSaveError(null);
    try {
      if (apiKeyDraft.trim()) await window.api.agent.setApiKey(apiKeyDraft.trim());
      if (localKeyDraft.trim()) await window.api.agent.setProviderKey(draft.openaiBaseUrl, localKeyDraft.trim());
      await onSave(draft);
      onClose();
    } catch (err) {
      setSaveError((err as Error).message || "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  async function clearApiKey() {
    await window.api.agent.setApiKey("");
    setHasApiKey(false);
    setApiKeyDraft("");
  }

  async function clearLocalApiKey() {
    await window.api.agent.setProviderKey(draft.openaiBaseUrl, "");
    setHasLocalKey(false);
    setLocalKeyDraft("");
  }

  return (
    <div className="modal-backdrop" onClick={() => artifactBusy === null && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="settings-title">Settings</h3>

        {saveError && <div className="error-text" role="alert">{saveError}</div>}

        <label className="field-label">txData root</label>
        <div className="field-row">
          <input value={draft.txDataPath ?? ""} readOnly placeholder="Not set" />
          <button className="btn" onClick={pickTxDataFolder}>
            Browse…
          </button>
        </div>

        <label className="field-label">Server-data workspace</label>
        <div className="field-hint">
          Select the editable folder that contains <code>server.cfg</code> and <code>resources/</code>, usually a
          <code>*.base</code> folder—not txAdmin's control-profile folder.
        </div>
        <div style={{ marginBottom: 10 }}>
          {!draft.txDataPath ? (
            <div className="field-hint">Pick a txData folder above first.</div>
          ) : profilesError ? (
            <div className="error-text">{profilesError}</div>
          ) : profiles.length === 0 ? (
            <div className="field-hint">No profiles found — looking for subfolders with a server.cfg or resources/ folder.</div>
          ) : (
            <select
              value={draft.selectedProfile ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, selectedProfile: e.target.value }))}
            >
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="settings-divider">Local workspace</div>
        <div className="setup-guide" role="note">
          <strong>Required setup for local server tools</strong>
          <ol>
            <li>Create or select a server-data workspace below this txData root.</li>
            <li>
              Keep the <code>endpoint_add_tcp/udp</code> lines already in <code>server.cfg</code>; Workbench reads
              their port and always sends RCON through loopback.
            </li>
            <li>
              Add your license key and <code>set rcon_password "..."</code> to <code>server.cfg</code>, or put them
              in a sibling <code>secrets.cfg</code> and add <code>exec secrets.cfg</code> to <code>server.cfg</code>.
              The password is not stored in Settings.
            </li>
            <li>
              In txAdmin choose <strong>Existing Server Data</strong>, attach this exact workspace, and start FXServer.
            </li>
            <li>Save Settings again after changing server.cfg or attaching txAdmin so Workbench rescans both.</li>
          </ol>
          <strong>No server resource or separate MCP process is required.</strong> {" "}
          <a
            href="https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/"
            onClick={(e) => {
              e.preventDefault();
              void window.api.shell.openExternal("https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/");
            }}
          >
            Official txAdmin setup guide
          </a>
          .
        </div>
        <div className="field-hint" style={{ marginBottom: 6 }}>
          Create writes only <code>server.cfg</code>, <code>resources/[local]</code>, a gitignore, and a secrets example.
          txAdmin continues to own its separate control profile.
        </div>
        <div className="field-row" style={{ marginBottom: 6 }}>
          <input
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="workspace name"
            disabled={!draft.txDataPath || creatingWorkspace}
          />
          <input
            value={workspacePort}
            onChange={(e) => setWorkspacePort(e.target.value)}
            inputMode="numeric"
            placeholder="port"
            style={{ width: 90 }}
            disabled={!draft.txDataPath || creatingWorkspace}
          />
          <button className="btn" type="button" onClick={() => void createWorkspace()} disabled={!draft.txDataPath || creatingWorkspace}>
            {creatingWorkspace ? "Creating…" : "Create"}
          </button>
        </div>
        {workspaceMessage && <div className="field-hint" style={{ color: "var(--green)", marginBottom: 10 }}>{workspaceMessage}</div>}

        <div className="field-hint" style={{ marginBottom: 10 }}>
          The coding runtime is bundled, uses a fresh private token and ephemeral loopback port each launch, and is not configurable for remote servers.
        </div>

        <div className="settings-divider">Local server & client</div>

        <label className="field-label">Active Cfx.re target</label>
        <select
          value={draft.activeCfxTarget}
          onChange={(e) => setDraft((d) => ({ ...d, activeCfxTarget: e.target.value as CfxTarget }))}
          disabled={artifactBusy !== null}
        >
          <option value="legacy">FiveM — GTA V Legacy</option>
          <option value="enhanced">FiveM — GTA V Enhanced</option>
          <option value="redm">RedM — Red Dead Redemption 2</option>
        </select>
        <div className="field-hint">
          The top bar launches the client and server for this target. Every installation keeps its own client, server, and artifact state.
        </div>

        <div className="edition-path-grid">
          {CFX_TARGETS.map((target) => {
            const label = cfxTargetLabel(target);
            const serverPath = serverExeFor(draft, target);
            const clientPath = clientExeFor(draft, target);
            const clientExecutable = target === "redm" ? "RedM.exe" : "FiveM.exe";
            return (
              <section key={target} className={`edition-path-card ${activeTarget === target ? "active" : ""}`}>
                <h4>{label}</h4>
                <label className="field-label">Server artifact executable</label>
                <div className="field-row">
                  <input
                    value={serverPath ?? ""}
                    readOnly
                    placeholder={target === "enhanced" ? "cfx-server.exe" : "FXServer.exe"}
                  />
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void pickFxServerExe(target)}
                    disabled={artifactBusy !== null}
                  >
                    Browse…
                  </button>
                </div>
                <label className="field-label">{target === "redm" ? "RedM" : "FiveM"} client executable</label>
                <div className="field-row">
                  <input value={clientPath ?? ""} readOnly placeholder={clientExecutable} />
                  <button className="btn" type="button" onClick={() => void pickExe(target)} disabled={artifactBusy !== null}>
                    Browse…
                  </button>
                </div>
              </section>
            );
          })}
        </div>
        <div className="field-hint">
          Server paths enable <strong>Start server</strong>; client paths enable <strong>Launch client</strong>. Workbench uses the selected
          txData workspace for the active target and prevents different configured server artifacts from being started together.
        </div>
        {activeTarget === "redm" && (
          <div className="field-hint" style={{ color: "var(--yellow)" }}>
            RedM server profiles require <code>set gamename rdr3</code> in server.cfg. Workspaces created while RedM is active include it automatically.
          </div>
        )}

        <label className="field-label">{cfxTargetLabel(activeTarget)} artifact update track</label>
        <div className="field-row artifact-controls">
          <select
            value={artifactTrack}
            onChange={(e) => {
              const track = e.target.value as "recommended" | "latest";
              setDraft((d) => activeTarget === "redm" ? { ...d, redmArtifactTrack: track } : { ...d, legacyArtifactTrack: track });
            }}
            disabled={activeTarget === "enhanced" || artifactBusy !== null}
            title={activeTarget === "enhanced" ? "Cfx.re currently publishes one Windows Enhanced artifact track." : undefined}
          >
            <option value="recommended">Recommended</option>
            <option value="latest">Latest (preview)</option>
          </select>
          <button
            className="btn"
            type="button"
            onClick={() => void checkArtifacts()}
            disabled={!serverPathIsSaved || artifactBusy !== null}
          >
            {artifactBusy === "checking" ? "Checking…" : "Check"}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => void updateArtifacts()}
            disabled={!serverPathIsSaved || !artifactStatus || artifactStatus.installedBuild === artifactStatus.build || artifactBusy !== null}
          >
            {artifactBusy === "updating" ? "Updating…" : "Install update"}
          </button>
        </div>
        {!serverPathIsSaved && activeServerPath && (
          <div className="field-hint">Save Settings once before checking or installing artifacts for this path.</div>
        )}
        {artifactTrack === "latest" && activeTarget !== "enhanced" && (
          <div className="field-hint" style={{ color: "var(--yellow)" }}>
            Latest is newer, but Cfx.re has not marked it Recommended. Use it only when you need a recent server change.
          </div>
        )}
        {artifactStatus && (
          <div className="artifact-status" role="status">
            <strong>Cfx.re {artifactStatus.track} build {artifactStatus.build}</strong>
            <span>
              {artifactStatus.installedBuild === null
                ? "Installed build unknown (this installation has not yet been updated by Workbench)."
                : artifactStatus.installedBuild === artifactStatus.build
                  ? "This managed build is installed."
                  : `Workbench last installed build ${artifactStatus.installedBuild}.`}
            </span>
            <span>
              {artifactStatus.archiveSize ? `${(artifactStatus.archiveSize / 1024 / 1024).toFixed(1)} MB` : "Size unavailable"}
              {artifactStatus.publishedAt ? ` · ${new Date(artifactStatus.publishedAt).toLocaleDateString()}` : ""}
            </span>
          </div>
        )}
        {artifactError && <div className="error-text" role="alert">{artifactError}</div>}
        {artifactMessage && <div className="field-hint artifact-success">{artifactMessage}</div>}
        <div className="field-hint">
          Updates come from the {" "}
          <a
            href="https://docs.fivem.net/docs/server-download/"
            onClick={(e) => {
              e.preventDefault();
              void window.api.shell.openExternal("https://docs.fivem.net/docs/server-download/");
            }}
          >
            official Cfx.re server download page
          </a>
          . The archive is staged, path-checked, and CRC-checked before the artifact directory is swapped. Cfx.re does not publish a
          separate signature/checksum for these Windows artifacts. txData is never inside the update target.
        </div>

        <div className="settings-divider">Code editor</div>

        <label className="field-label">Lua intelligence</label>
        <select
          value={draft.editor.luaIntelligence}
          onChange={(e) => setDraft((d) => ({
            ...d,
            editor: {
              ...d.editor,
              luaIntelligence: e.target.value as StudioConfig["editor"]["luaIntelligence"],
            },
          }))}
        >
          <option value="balanced">Balanced — recommended</option>
          <option value="full">Full workspace</option>
          <option value="off">Off — syntax highlighting only</option>
        </select>
        <div className="field-hint">
          Balanced limits background indexing and diagnoses open files at full speed. The service runs only while a Lua tab is open; Full raises the file limits for unusually large frameworks.
        </div>

        <label className="field-label">Font size</label>
        <select
          value={draft.editor.fontSize}
          onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, fontSize: Number(e.target.value) } }))}
        >
          {[11, 12, 13, 14, 16, 18, 20, 22, 24].map((size) => (
            <option key={size} value={size}>{size}px</option>
          ))}
        </select>

        <label className="field-label">Word wrap</label>
        <select
          value={draft.editor.wordWrap ? "on" : "off"}
          onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, wordWrap: e.target.value === "on" } }))}
        >
          <option value="off">Off</option>
          <option value="on">On</option>
        </select>

        <div className="editor-settings-grid">
          <label className="field-label">
            Minimap
            <select
              value={draft.editor.minimap ? "on" : "off"}
              onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, minimap: e.target.value === "on" } }))}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
          <label className="field-label">
            Sticky scroll
            <select
              value={draft.editor.stickyScroll ? "on" : "off"}
              onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, stickyScroll: e.target.value === "on" } }))}
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="field-label">
            Format on save
            <select
              value={draft.editor.formatOnSave ? "on" : "off"}
              onChange={(e) => setDraft((d) => ({ ...d, editor: { ...d.editor, formatOnSave: e.target.value === "on" } }))}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
        </div>
        <div className="field-hint">
          Format on save runs only when the active language has a formatter. Editor models are kept only for open tabs so undo history survives tab switches without indexing closed files.
        </div>

        <div className="settings-divider">Agent Chat</div>

        <label className="field-label">Provider</label>
        <div style={{ marginBottom: 6 }}>
          <select value={preset.id} onChange={(e) => applyPreset(e.target.value)}>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {COST_LABEL[p.cost]}
              </option>
            ))}
          </select>
        </div>
        <div className="field-hint">
          {preset.note}
          {preset.keyUrl && (
            <>
              {" "}
              <a
                href={preset.keyUrl}
                onClick={(e) => {
                  e.preventDefault();
                  window.api.shell.openExternal(preset.keyUrl!);
                }}
              >
                Get a key
              </a>
            </>
          )}
        </div>
        <div className="field-hint">
          <strong>The model must support tool calling.</strong> The agent works entirely through tools, so a model
          without solid tool support will connect fine and then just chat without ever touching your server.
        </div>
        <div className="field-hint">
          Hosted providers receive your messages, selected code, and tool results. Choose Ollama or LM Studio if model traffic must stay on this PC.
        </div>

        {isAnthropic ? (
          <>
            <label className="field-label">Anthropic API key{hasApiKey ? " — a key is saved" : ""}</label>
            <div className="field-row">
              <input
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                type="password"
                placeholder={hasApiKey ? "Saved — type here to replace it" : "sk-ant-…"}
              />
              {hasApiKey && (
                <button className="btn" onClick={clearApiKey}>
                  Clear
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <label className="field-label">Server URL</label>
            <input
              value={draft.openaiBaseUrl}
              onChange={(e) => setDraft((d) => ({ ...d, openaiBaseUrl: e.target.value }))}
              placeholder="https://…/v1"
            />

            <label className="field-label">Model</label>
            <div className="field-row">
              <input
                value={draft.openaiModel}
                onChange={(e) => setDraft((d) => ({ ...d, openaiModel: e.target.value }))}
                placeholder="model id"
                list="model-suggestions"
              />
              <button className="btn" onClick={loadModels} disabled={loadingModels}>
                {loadingModels ? "Loading…" : "Load models"}
              </button>
            </div>
            {models.length > 0 && (
              <datalist id="model-suggestions">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
            {modelsError && <div className="error-text">{modelsError}</div>}
            {models.length > 0 && (
              <div className="field-hint">
                {models.length} model{models.length === 1 ? "" : "s"} available — click the field for the list.
                {toolCapable && (() => {
                  const noTools = models.filter((m) => toolCapable[m] === false);
                  return noTools.length === 0 ? null : (
                    <>
                      <br />
                      <span style={{ color: "var(--yellow)" }}>
                        No tool support (unusable for the agent): {noTools.join(", ")}
                      </span>
                    </>
                  );
                })()}
              </div>
            )}
            {toolCapable?.[draft.openaiModel] === false && (
              <div className="error-text">
                “{draft.openaiModel}” doesn't support tool calling — the agent won't be able to do anything with it.
              </div>
            )}

            <label className="field-label">
              API key{preset.needsKey ? "" : " — not needed for a local server"}
              {hasLocalKey ? " (a key is saved)" : ""}
            </label>
            <div className="field-row">
              <input
                value={localKeyDraft}
                onChange={(e) => setLocalKeyDraft(e.target.value)}
                type="password"
                placeholder={
                  hasLocalKey ? "Saved — type here to replace it" : preset.needsKey ? "Paste your key" : "Leave blank"
                }
              />
              {hasLocalKey && (
                <button className="btn" onClick={clearLocalApiKey}>
                  Clear
                </button>
              )}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={artifactBusy !== null}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || artifactBusy !== null}>
            {busy ? "Connecting…" : "Save & Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
