import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const enabledItems = () => Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    enabledItems()[0]?.focus();

    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = enabledItems();
      if (buttons.length === 0) return;
      e.preventDefault();
      const current = document.activeElement instanceof HTMLButtonElement
        ? buttons.indexOf(document.activeElement)
        : -1;
      const next = e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : e.key === "ArrowDown"
            ? (current + 1 + buttons.length) % buttons.length
            : (current - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus.current?.focus();
    };
  }, []);

  return (
    <div ref={ref} className="context-menu" role="menu" aria-label="Resource actions" style={{ left: x, top: y }}>
      {items.map((item) => (
        <button
          type="button"
          role="menuitem"
          key={item.label}
          className={`context-menu-item ${item.danger ? "danger" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
