import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Focuses a dialog, traps Tab within it, handles Escape, and restores focus. */
export function useDialogFocus<T extends HTMLElement>(onRequestClose: () => void, canClose = true) {
  const dialogRef = useRef<T | null>(null);
  const closeRef = useRef(onRequestClose);
  const canCloseRef = useRef(canClose);
  closeRef.current = onRequestClose;
  canCloseRef.current = canClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const activeDialog: T = dialog;

    const focusable = () => Array.from(activeDialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
    (activeDialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? focusable()[0] ?? activeDialog).focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && canCloseRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        activeDialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeIndex = document.activeElement instanceof HTMLElement
        ? items.indexOf(document.activeElement)
        : -1;
      // Programmatically focused headings/containers are intentionally outside
      // the sequential tab order. Treat them (and any escaped focus) as a trap
      // boundary instead of allowing Shift+Tab into the page behind the dialog.
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex === -1 || activeIndex === items.length - 1)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, []);

  return dialogRef;
}
