import { t } from "../i18n";

export default function WhatsNewPanel({ currentVersion, onClose }: { currentVersion: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop whats-new-backdrop" onClick={onClose}>
      <section className="whats-new-panel" role="dialog" aria-modal="true" aria-labelledby="whats-new-title" onClick={(event) => event.stopPropagation()}>
        <div className="whats-new-brand" aria-hidden="true">QB</div>
        <div>
          <h2 id="whats-new-title">{t("whatsNew.title", { version: currentVersion })}</h2>
          <p>{t("whatsNew.intro")}</p>
          <ul>
            <li>{t("whatsNew.resourceWorkflow")}</li>
            <li>{t("whatsNew.safeSearch")}</li>
            <li>{t("whatsNew.console")}</li>
          </ul>
          <div className="modal-actions">
            <button type="button" className="btn primary" onClick={onClose}>{t("whatsNew.continue")}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
