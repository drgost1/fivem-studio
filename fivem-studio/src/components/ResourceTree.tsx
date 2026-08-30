import { useEffect, useState } from "react";
import type { DirEntry, ResourceDuplicateResult } from "../global";
import { t } from "../i18n";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

type ResourceState = "started" | "stopped";
type ResourceAction = "start" | "stop" | "restart";

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
  resourceStates: Record<string, ResourceState>;
  serverStateAvailable: boolean;
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
  resourceStates,
  serverStateAvailable,
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
  const resourceState = entry.resourceName && serverStateAvailable
    ? resourceStates[entry.resourceName.toLowerCase()]
    : undefined;

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
          <>
            <span>{entry.name}</span>
            {entry.resourceName && (
              <span
                className={`resource-state-dot ${resourceState ?? "unknown"}`}
                title={t(`resource.state.${resourceState ?? "unknown"}`)}
                aria-label={t(`resource.state.${resourceState ?? "unknown"}`)}
              />
            )}
          </>
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
              resourceStates={resourceStates}
              serverStateAvailable={serverStateAvailable}
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
  resourceStates: Record<string, ResourceState>;
  serverStateAvailable: boolean;
  runtimeWritable: boolean;
  resourceAction: string | null;
  onResourceAction: (kind: ResourceAction, name: string) => Promise<unknown>;
  onResourceDuplicated: (sourceName: string, result: ResourceDuplicateResult) => void;
}

interface MenuState {
  x: number;
  y: number;
  entry: DirEntry;
}

export default function ResourceTree({
  rootPath,
  selectedPath,
  onOpenFile,
  refreshKey,
  onPathRenamed,
  onDeleteEntry,
  resourceStates,
  serverStateAvailable,
  runtimeWritable,
  resourceAction,
  onResourceAction,
  onResourceDuplicated,
}: ResourceTreeProps) {
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

  async function duplicateEntry(entry: DirEntry) {
    if (!entry.resourceName) return;
    const proposed = prompt(t("resource.duplicate.prompt"), `${entry.resourceName}-copy`);
    if (proposed === null || !proposed.trim()) return;
    try {
      const result = await window.api.resources.duplicate(entry.path, proposed.trim());
      onResourceDuplicated(entry.resourceName, result);
    } catch (error) {
      alert((error as Error).message);
    }
  }

  function openContextMenu(entry: DirEntry, x: number, y: number) {
    setMenu({ x, y, entry });
  }

  function lifecycleMenuItems(): ContextMenuItem[] {
    const name = menu?.entry.resourceName;
    if (!name) return [];
    const state = serverStateAvailable ? resourceStates[name.toLowerCase()] : undefined;
    const controlsBlocked = !runtimeWritable || resourceAction !== null || !serverStateAvailable || state === undefined;
    return [
      ...(!serverStateAvailable
        ? [{ label: t("resource.context.unavailable"), disabled: true, onClick: () => undefined }]
        : []),
      {
        label: t("resource.context.start", { resource: name }),
        disabled: controlsBlocked || state === "started",
        onClick: () => void onResourceAction("start", name),
      },
      {
        label: t("resource.context.restart", { resource: name }),
        disabled: controlsBlocked,
        onClick: () => void onResourceAction("restart", name),
      },
      {
        label: t("resource.context.stop", { resource: name }),
        danger: true,
        disabled: controlsBlocked || state === "stopped",
        onClick: () => void onResourceAction("stop", name),
      },
    ];
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
          resourceStates={resourceStates}
          serverStateAvailable={serverStateAvailable}
        />
      ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...lifecycleMenuItems(),
            ...(menu.entry.resourceName
              ? [{ label: t("resource.context.duplicate"), onClick: () => void duplicateEntry(menu.entry) }]
              : []),
            { label: "Rename", onClick: () => setRenamingPath(menu.entry.path) },
            { label: "Show in Explorer", onClick: () => window.api.shell.showItemInFolder(menu.entry.path) },
            { label: "Delete", danger: true, onClick: () => deleteEntry(menu.entry) },
          ]}
        />
      )}
    </div>
  );
}
