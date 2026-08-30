import { useEffect, useMemo, useState, type ReactNode } from "react";
import { t } from "../i18n";

export interface StatusItem {
  id: string;
  tone: "info" | "warning" | "error";
  content: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
}

const TONE_ORDER: Record<StatusItem["tone"], number> = { error: 0, warning: 1, info: 2 };

export default function StatusArea({ items }: { items: StatusItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(
    () => items.map((item, index) => ({ item, index })).sort((a, b) => TONE_ORDER[a.item.tone] - TONE_ORDER[b.item.tone] || a.index - b.index).map(({ item }) => item),
    [items],
  );
  useEffect(() => {
    if (ordered.length <= 1) setExpanded(false);
  }, [ordered.length]);
  if (ordered.length === 0) return null;
  const primary = ordered[0];

  const row = (item: StatusItem, compact: boolean) => (
    <div key={item.id} className={`status-area-row ${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
      <span className="status-area-icon" aria-hidden="true">{item.tone === "error" ? "×" : item.tone === "warning" ? "!" : "i"}</span>
      <div className="status-area-message">{item.content}</div>
      {item.actions && <div className="status-area-actions">{item.actions}</div>}
      {item.onDismiss && (
        <button type="button" className="banner-dismiss" onClick={item.onDismiss} aria-label={t("status.area.dismiss")}>×</button>
      )}
      {compact && ordered.length > 1 && (
        <button type="button" className="btn small status-area-more" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {expanded ? t("status.area.hide") : t("status.area.more", { count: ordered.length - 1 })}
        </button>
      )}
    </div>
  );

  return (
    <section className="status-area" aria-label={t("status.area.label")}>
      {row(primary, true)}
      {expanded && <div className="status-area-flyout">{ordered.slice(1).map((item) => row(item, false))}</div>}
    </section>
  );
}
