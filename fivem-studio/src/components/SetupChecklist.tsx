import type { SetupDiagnostics } from "../global";
import { t } from "../i18n";

interface SetupChecklistActions {
  txDataRoot: () => void;
  workspace: () => void;
  serverExecutable: () => void;
  clientExecutable: () => void;
  txAdminAttachment: () => void;
  rconCapability: () => void;
  git: () => void;
}

interface SetupChecklistProps {
  diagnostics: SetupDiagnostics | null;
  targetLabel: string;
  actions: SetupChecklistActions;
}

export default function SetupChecklist({ diagnostics, targetLabel, actions }: SetupChecklistProps) {
  const rows: Array<{
    key: keyof SetupDiagnostics;
    label: string;
    action: string;
  }> = [
    { key: "txDataRoot", label: t("setup.check.txData"), action: t("setup.action.browse") },
    { key: "workspace", label: t("setup.check.workspace"), action: t("setup.action.chooseWorkspace") },
    { key: "serverExecutable", label: t("setup.check.server", { target: targetLabel }), action: t("setup.action.browse") },
    { key: "clientExecutable", label: t("setup.check.client", { target: targetLabel }), action: t("setup.action.browse") },
    { key: "txAdminAttachment", label: t("setup.check.txAdmin"), action: t("setup.action.openGuide") },
    { key: "rconCapability", label: t("setup.check.rcon"), action: t("setup.action.setupRcon") },
    { key: "git", label: t("setup.check.git"), action: t("setup.action.installGit") },
  ];

  return (
    <section className="setup-checklist" aria-labelledby="setup-checklist-title">
      <div className="setup-checklist-heading">
        <div>
          <strong id="setup-checklist-title">{t("setup.checklist.title")}</strong>
          <span>{t("setup.checklist.help")}</span>
        </div>
        {diagnostics && (
          <span className="setup-progress">
            {t("setup.checklist.progress", {
              ready: Object.values(diagnostics).filter(Boolean).length,
              total: rows.length,
            })}
          </span>
        )}
      </div>
      <div className="setup-checklist-rows">
        {rows.map((row) => {
          const ready = diagnostics?.[row.key] === true;
          const checking = diagnostics === null;
          return (
            <div className={`setup-check-row ${ready ? "ready" : ""}`} key={row.key}>
              <span className="setup-check-icon" aria-hidden="true">
                {ready ? (
                  <svg viewBox="0 0 16 16"><path d="m3 8.2 3 3L13 4.8" /></svg>
                ) : (
                  <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" /></svg>
                )}
              </span>
              <span className="setup-check-label">{row.label}</span>
              {ready ? (
                <span className="setup-check-state">{t("setup.state.ready")}</span>
              ) : checking ? (
                <span className="setup-check-state">{t("setup.state.checking")}</span>
              ) : (
                <button className="btn" type="button" onClick={actions[row.key]}>{row.action}</button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
