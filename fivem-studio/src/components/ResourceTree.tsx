import { useEffect, useState } from "react";
import type { DirEntry } from "../global";
import ContextMenu from "./ContextMenu";

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  refreshKey: number;
  renamingPath: string | null;
  onCommitRename: (entry: DirEntry, newName: string) => void;
  onCancelRename: () => void;
  onContextMenu: (entry: DirEntry, x: number, y: number) => void;
}

function TreeNode({
  entry,
  depth,
  selectedPath,
  onOpenFile,
  refreshKey,
  renamingPath,
  onCommitRename,
  onCancelRename,
  onContextMenu,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (!entry.isDirectory) {
      onOpenFile(entry.path);
      return;
    }
    if (!expanded && children === null) {
      try {
        setChildren(await window.api.fs.listDir(entry.path));
      } catch (err) {
        setError((err as Error).message);
      }
    }
    setExpanded((e) => !e);
  }

  // Keep already-loaded folders in sync with changes made outside Studio
  // (files moved/renamed/added/deleted in Explorer) — re-fetch whenever the
  // watcher-driven refreshKey ticks, regardless of current expand state.
  useEffect(() => {
    if (children === null) return;
    window.api.fs
      .listDir(entry.path)
      .then(setChildren)
      .catch((err) => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const isRenaming = renamingPath === entry.path;

  return (
    <div>
      <div
        className={`tree-node ${selectedPath === entry.path ? "selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(entry, e.clientX, e.clientY);
        }}
      >
        <span className="icon">{entry.isDirectory ? (expanded ? "▾" : "▸") : "📄"}</span>
        {isRenaming ? (
          <input
            className="tree-rename-input"
            autoFocus
            defaultValue={entry.name}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitRename(entry, (e.target as HTMLInputElement).value);
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={(e) => onCommitRename(entry, e.target.value)}
          />
        ) : (
          <span>{entry.name}</span>
        )}
      </div>
      {expanded && entry.isDirectory && (
        <div>
          {error && <div className="tree-empty">{error}</div>}
          {children?.length === 0 && <div className="tree-empty">(empty)</div>}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
              refreshKey={refreshKey}
              renamingPath={renamingPath}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ResourceTreeProps {
  rootPath: string | null;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  refreshKey: number;
  onPathRenamed: (oldPath: string, newPath: string) => void;
  onDeleteEntry: (path: string, name: string) => Promise<boolean>;
}

interface MenuState {
  x: number;
  y: number;
  entry: DirEntry;
}

export default function ResourceTree({ rootPath, selectedPath, onOpenFile, refreshKey, onPathRenamed, onDeleteEntry }: ResourceTreeProps) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  useEffect(() => {
    if (!rootPath) {
      setEntries([]);
      return;
    }
    window.api.fs
      .listDir(rootPath)
      .then(setEntries)
      .catch((err) => setError((err as Error).message));
  }, [rootPath, refreshKey]);

  async function commitRename(entry: DirEntry, newName: string) {
    setRenamingPath(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) return;
    try {
      const newPath = await window.api.fs.rename(entry.path, trimmed);
      onPathRenamed(entry.path, newPath);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function deleteEntry(entry: DirEntry) {
    await onDeleteEntry(entry.path, entry.name);
  }

  function openContextMenu(entry: DirEntry, x: number, y: number) {
    setMenu({ x, y, entry });
  }

  if (!rootPath) {
    return <div className="tree-empty">No profile selected — open Settings and pick your txData folder and profile.</div>;
  }
  if (error) {
    return <div className="tree-empty">{error}</div>;
  }
  if (entries.length === 0) {
    return <div className="tree-empty">(empty folder)</div>;
  }

  return (
    <div>
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          refreshKey={refreshKey}
          renamingPath={renamingPath}
          onCommitRename={commitRename}
          onCancelRename={() => setRenamingPath(null)}
          onContextMenu={openContextMenu}
        />
      ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", onClick: () => setRenamingPath(menu.entry.path) },
            { label: "Show in Explorer", onClick: () => window.api.shell.showItemInFolder(menu.entry.path) },
            { label: "Delete", danger: true, onClick: () => deleteEntry(menu.entry) },
          ]}
        />
      )}
    </div>
  );
}
