import type { FileChangeReview } from "../App";
import type { EditorPreferences, ResolvedTheme } from "../global";
import ChangeDiff from "./ChangeDiff";

interface ChangeReviewProps {
  review: FileChangeReview;
  language: string;
  preferences: EditorPreferences;
  resolvedTheme: ResolvedTheme;
  onBack: () => void;
  onDismiss: () => void;
  onUseDisk: () => void;
  onSaveEditor: () => void;
}

export default function ChangeReview({
  review,
  language,
  preferences,
  resolvedTheme,
  onBack,
  onDismiss,
  onUseDisk,
  onSaveEditor,
}: ChangeReviewProps) {
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
        <ChangeDiff
          id={review.id}
          original={review.originalContent}
          modified={review.modifiedContent}
          language={language}
          fontSize={preferences.fontSize}
          wordWrap={preferences.wordWrap}
          resolvedTheme={resolvedTheme}
        />
      </div>
    </section>
  );
}
