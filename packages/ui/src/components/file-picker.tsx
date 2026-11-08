import { type ReactNode, useId, useRef } from "react";
import { buttonClasses } from "./button.tsx";

export interface FilePickerProps {
  /** The button's label, such as "Choose a folder". */
  label: string;
  /** A hint under the button, read with it. */
  description?: ReactNode;
  icon?: ReactNode;
  /** File types the system dialog offers, as the `accept` attribute takes them. */
  accept?: string;
  multiple?: boolean;
  /** Pick a folder and every file in it, where the browser can (`webkitdirectory`). */
  folder?: boolean;
  disabled?: boolean;
  intent?: "primary" | "secondary";
  /** Called with the chosen files; never with an empty list. */
  onPick(files: File[]): void;
}

/**
 * A native file input shown as a button. The input stays in the page, visually hidden, so the
 * keyboard, screen readers and drag and drop on the control keep working, and choosing the same
 * file again still reports it.
 */
export function FilePicker({
  label,
  description,
  icon,
  accept,
  multiple = false,
  folder = false,
  disabled = false,
  intent = "secondary",
  onPick,
}: FilePickerProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={input}
        id={id}
        type="file"
        className="peer sr-only"
        accept={accept}
        multiple={multiple || folder}
        disabled={disabled}
        aria-describedby={description ? hintId : undefined}
        {...(folder ? { webkitdirectory: "", directory: "" } : {})}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
      <label
        htmlFor={id}
        className={`${buttonClasses({ intent })} self-start peer-focus-visible:outline-2 peer-focus-visible:outline-offset-3 peer-focus-visible:outline-focus peer-disabled:opacity-60`}
      >
        {icon ? (
          <span aria-hidden="true" className="inline-flex shrink-0">
            {icon}
          </span>
        ) : null}
        {label}
      </label>
      {description ? (
        <p id={hintId} className="text-sm text-text-muted">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** Whether this browser can pick a whole folder; when it cannot, offer a ZIP instead. */
export function canPickFolders(): boolean {
  return typeof HTMLInputElement !== "undefined" && "webkitdirectory" in HTMLInputElement.prototype;
}
