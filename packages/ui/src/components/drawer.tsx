import { X } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useId, useRef } from "react";
import { Button } from "./button.tsx";

export interface DrawerProps {
  open: boolean;
  /** Names the drawer, such as "Navigation". */
  label: string;
  /** Accessible name of the close button. */
  closeLabel: string;
  onClose(): void;
  /** Shown at the top, next to the close button, such as the logo. */
  header?: ReactNode;
  /** The ID of the drawer, for `aria-controls` on the button that opens it. */
  id?: string;
  ref?: Ref<HTMLDialogElement>;
  children: ReactNode;
}

/**
 * An off-canvas panel from the start edge, such as the navigation on narrow screens. It is a
 * native `dialog` with `showModal()`, so focus stays inside and the rest of the page is inert;
 * Escape, a press on the dimmed page and following a link inside close it, focus goes back to
 * the control that opened it, and the page behind does not scroll while it is open
 * (`data-scroll-lock`, in theme.css). Its content is rendered only while it is open.
 */
export function Drawer({
  open,
  label,
  closeLabel,
  onClose,
  header,
  id,
  ref,
  children,
}: DrawerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<Element | null>(null);
  const fallbackId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: a press on the backdrop has its keyboard equivalent in Escape (onCancel)
    <dialog
      ref={(node) => {
        dialogRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      id={id ?? fallbackId}
      aria-label={label}
      data-scroll-lock=""
      onCancel={(event) => {
        // Escape: let the owner decide, so `open` stays the single source of truth.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A press on the backdrop lands on the dialog itself; a followed link closes it too.
        const target = event.target as Element;
        if (target === event.currentTarget || target.closest("a[href]")) onClose();
      }}
      className="m-0 h-full max-h-none w-80 max-w-full border-r border-border bg-canvas p-0 text-text shadow-float backdrop:bg-surface-inverse/50 open:motion-safe:animate-fade"
    >
      {open ? (
        <div className="flex h-full flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
            <div className="min-w-0">{header}</div>
            <Button
              intent="ghost"
              size="sm"
              aria-label={closeLabel}
              icon={<X className="size-5" />}
              onClick={onClose}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}
