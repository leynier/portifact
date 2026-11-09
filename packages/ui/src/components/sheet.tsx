import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { Button } from "./button.tsx";

export interface SheetProps {
  open: boolean;
  title: string;
  /** Accessible name of the close button in the corner. */
  closeLabel: string;
  onClose(): void;
  children: ReactNode;
  /** Actions along the bottom, such as "Done". */
  footer?: ReactNode;
}

/**
 * A modal panel for narrow screens, such as filters that do not fit beside a list: a native
 * `dialog` with `showModal()`, so the rest of the page is inert, Escape or a press on the dimmed
 * page closes it, and focus goes back to the control that opened it. It rises from the bottom
 * edge on phones and is centered on wider screens. It only fades in, never moves, so fixed
 * popups inside it, such as a select's listbox, are placed against the window.
 */
export function Sheet({ open, title, closeLabel, onClose, children, footer }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();

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
    // A press on the dimmed page closes it; Escape does the same through the cancel event.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard closes it with Escape
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: let the owner decide, so `open` stays the single source of truth.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A press on the backdrop lands on the dialog itself, outside its content.
        if (event.target === event.currentTarget) onClose();
      }}
      className="mx-0 mt-auto mb-0 max-h-full w-full max-w-none rounded-t-lg border border-border bg-surface-raised p-0 text-text shadow-float backdrop:bg-surface-inverse/50 open:motion-safe:animate-fade sm:m-auto sm:max-w-md sm:rounded-lg"
    >
      <div className="flex flex-col gap-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <Button
            intent="ghost"
            size="sm"
            aria-label={closeLabel}
            title={closeLabel}
            icon={<X className="size-4" />}
            onClick={onClose}
          />
        </div>
        {children}
        {footer ? <div className="flex flex-wrap justify-end gap-3">{footer}</div> : null}
      </div>
    </dialog>
  );
}
