import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { Button } from "./button.tsx";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** Icon on the confirm button, for example a trash can for a destructive action. */
  confirmIcon?: ReactNode;
  /** True while the confirmed action runs; both buttons wait for it. */
  busy?: boolean;
  /**
   * `danger` for actions that cannot be undone or end something elsewhere: a warning icon leads
   * the title, so the risk reads in shape as well as in words.
   */
  tone?: "default" | "danger";
  onConfirm(): void;
  onCancel(): void;
}

/**
 * A modal confirmation built on the native `dialog` element: `showModal()` makes the rest of
 * the page inert, Escape cancels, and focus goes back to the control that opened it. Native
 * instead of a Radix primitive because Radix's scroll lock injects inline `<style>` elements,
 * which the dashboard's CSP refuses.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  confirmIcon,
  busy = false,
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = dialog.ownerDocument.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const target = opener.current;
    opener.current = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        // Escape: let the owner decide, so `open` stays the single source of truth.
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-full max-w-md rounded-lg border border-border bg-surface-raised p-6 text-text shadow-float backdrop:bg-surface-inverse/50 open:motion-safe:animate-pop"
    >
      <div className="flex gap-4">
        {tone === "danger" ? (
          <span
            aria-hidden="true"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-selection"
          >
            <TriangleAlert className="size-5" />
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight break-words">
            {title}
          </h2>
          <div id={bodyId} className="mt-1.5 text-sm text-text-muted">
            {children}
          </div>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        {/* No autoFocus: React would focus it while the dialog is closed. showModal() moves
            focus to this first control, the safe choice. */}
        <Button intent="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button intent="primary" icon={confirmIcon} onClick={onConfirm} busy={busy}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
