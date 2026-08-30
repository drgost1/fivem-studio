import type { EditorBookmark } from "../global";
import { t } from "../i18n";

export default function BookmarksPanel({
  bookmarks,
  onOpen,
  onRemove,
}: {
  bookmarks: EditorBookmark[];
  onOpen: (path: string, line: number) => void;
  onRemove: (path: string, line: number) => void;
}) {
  if (bookmarks.length === 0) return <div className="bookmarks-empty">{t("bookmarks.empty")}</div>;
  return (
    <div className="bookmarks-list">
      {bookmarks.map((bookmark) => {
        const parts = bookmark.path.split(/[/\\]/);
        const name = parts.pop() ?? bookmark.path;
        const parent = parts.pop();
        return (
          <div className="bookmark-row" key={`${bookmark.path}:${bookmark.line}`}>
            <button type="button" className="bookmark-open" onClick={() => onOpen(bookmark.path, bookmark.line)}>
              <span>{name}:{bookmark.line}</span>
              {parent && <small>{parent}</small>}
            </button>
            <button type="button" className="bookmark-remove" onClick={() => onRemove(bookmark.path, bookmark.line)} aria-label={t("bookmarks.remove")}>×</button>
          </div>
        );
      })}
    </div>
  );
}
