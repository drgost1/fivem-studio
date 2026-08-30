import type { KeyboardEvent } from "react";

import type { OpenFile } from "../App";
import { t } from "../i18n";
import {
  MANIFEST_LIST_FIELDS,
  parseManifestForm,
  updateManifestForm,
  type ManifestFormValues,
  type ManifestListField,
  type ManifestScalarField,
} from "../../electron/manifestModel";

interface ManifestFormEditorProps {
  file: OpenFile;
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string, expectedRevision: string) => Promise<void>;
}

const SCALAR_FIELDS: Array<{ field: ManifestScalarField; label: string; placeholder: string }> = [
  { field: "fx_version", label: "fx_version", placeholder: "cerulean" },
  { field: "game", label: "game", placeholder: "gta5 or rdr3" },
  { field: "author", label: "author", placeholder: "QBCore Framework" },
  { field: "version", label: "version", placeholder: "1.0.0" },
];

const LIST_LABELS: Record<ManifestListField, string> = {
  shared_scripts: "shared_scripts",
  client_scripts: "client_scripts",
  server_scripts: "server_scripts",
  files: "files",
  dependencies: "dependencies",
};

export default function ManifestFormEditor({ file, onChange, onSave }: ManifestFormEditorProps) {
  const parsed = parseManifestForm(file.content);
  if (!parsed.ok) return <div className="manifest-form-error">{parsed.reason}</div>;

  function apply(next: ManifestFormValues) {
    onChange(file.path, updateManifestForm(file.content, next));
  }

  function save(event?: KeyboardEvent<HTMLDivElement>) {
    if (event && (!event.ctrlKey && !event.metaKey || event.key.toLowerCase() !== "s")) return;
    event?.preventDefault();
    void onSave(file.path, file.content, file.revision).catch(() => {
      // App owns the visible conflict/error status.
    });
  }

  return (
    <div className="manifest-form" onKeyDown={save}>
      <div className="manifest-form-header">
        <div>
          <strong>{t("manifest.title")}</strong>
          <span>{t("manifest.preserveHelp")}</span>
        </div>
        <button type="button" className="btn small primary" disabled={!file.dirty} onClick={() => save()}>
          {file.dirty ? t("manifest.save") : t("manifest.saved")}
        </button>
      </div>
      <div className="manifest-form-body">
        <section className="manifest-form-section">
          <h3>{t("manifest.identity")}</h3>
          <div className="manifest-scalar-grid">
            {SCALAR_FIELDS.map(({ field, label, placeholder }) => (
              <label key={field}>
                <span>{label}</span>
                <input
                  value={parsed.values[field]}
                  placeholder={placeholder}
                  onChange={(event) => apply({ ...parsed.values, [field]: event.target.value })}
                />
              </label>
            ))}
          </div>
        </section>
        <section className="manifest-form-section">
          <h3>{t("manifest.scriptLists")}</h3>
          <div className="manifest-list-grid">
            {MANIFEST_LIST_FIELDS.map((field) => (
              <label key={field}>
                <span>{LIST_LABELS[field]}</span>
                <textarea
                  rows={field === "files" ? 6 : 4}
                  value={parsed.values[field].join("\n")}
                  placeholder={t("manifest.onePerLine")}
                  onChange={(event) => apply({
                    ...parsed.values,
                    [field]: event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
                  })}
                />
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
