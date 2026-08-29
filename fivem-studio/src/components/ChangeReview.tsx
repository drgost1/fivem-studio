import { DiffEditor } from "@monaco-editor/react";

import "../monacoSetup";
import type { FileChangeReview } from "../App";
import type { EditorPreferences } from "../global";

interface ChangeReviewProps {
  review: FileChangeReview;
  language: string;
  preferences: EditorPreferences;
  onBack: () => void;
  onDismiss: () => void;
  onUseDisk: () => void;
  onSaveEditor: () => void;
}

export default function ChangeReview({
  review,
  language,
  preferences,
  onBack,
  onDismiss,
  onUseDisk,
  onSaveEditor,
}: ChangeReviewProps) {
  const modelBase = `qb-studio-diff://review/${review.id}`;
  return (
    <section className="change-review" aria-label={`Change review for ${review.path}`}>
      <header className="change-review-header">
        <div className="change-review-copy">
          <strong>{review.kind === "conflict" ? "Resolve file conflict" : "Review agent changes"}</strong>
          <span>{review.path.split(/[/\\]/).pop()}</span>
        </div>
        <div className="change-review-actions">
          {review.kind === "conflict" ? (
            <>
              <button type="button" onClick={onBack}>Back to editor</button>
              <button type="button" onClick={onUseDisk}>Use disk version</button>
              <button type="button" className="primary" onClick={onSaveEditor}>Save editor version</button>
            </>
          ) : (
            <button type="button" className="primary" onClick={onDismiss}>Done</button>
          )}
        </div>
      </header>
      <div className="change-review-labels" aria-hidden="true">
        <span>{review.originalLabel}</span>
        <span>{review.modifiedLabel}</span>
      </div>
      <div className="change-review-editor">
        <DiffEditor
          original={review.originalContent}
          modified={review.modifiedContent}
          language={language}
          originalModelPath={`${modelBase}/original.${language}`}
          modifiedModelPath={`${modelBase}/modified.${language}`}
          theme="vs-dark"
          options={{
            automaticLayout: true,
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            enableSplitViewResizing: true,
            minimap: { enabled: false },
            fontSize: preferences.fontSize,
            wordWrap: preferences.wordWrap ? "on" : "off",
            renderIndicators: true,
            renderOverviewRuler: true,
            maxComputationTime: 3_000,
            smoothScrolling: true,
          }}
        />
      </div>
    </section>
  );
}
