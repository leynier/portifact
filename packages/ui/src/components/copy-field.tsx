import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { buttonClasses } from "./button.tsx";

export interface CopyFieldProps {
  /** What the value is, such as "Link" or "MCP server URL". Always visible. */
  label: string;
  /** The text to show and copy, such as a URL or a command. */
  value: string;
  /** Makes the value a link to this address. */
  href?: string;
  /** The copy button's label, such as "Copy link". */
  copyLabel: string;
  /** The copy button's label for a moment after copying, such as "Copied". */
  copiedLabel: string;
  /** Called after the value is on the clipboard, for example to announce it. */
  onCopied?(): void;
  /** Called when the browser refuses the clipboard; the value stays selectable by hand. */
  onCopyFailed?(): void;
  /** More controls beside the copy button, such as an "Open" link. */
  actions?: ReactNode;
  /** `command` prefixes the value with a prompt, for a shell command. */
  kind?: "value" | "command";
  /**
   * One slim row for a bar or a caption: the label is kept for assistive technology only and the
   * copy button is small. The value must be clear without the visible label, such as a URL, and
   * is never cut short: it wraps, so an origin is always shown whole.
   */
  compact?: boolean;
}

const COPIED_MS = 2000;

/**
 * A value people copy somewhere else, such as an artifact's URL, the MCP server URL or a CLI
 * command: monospaced, selectable by hand and copied with one button.
 */
export function CopyField({
  label,
  value,
  href,
  copyLabel,
  copiedLabel,
  onCopied,
  onCopyFailed,
  actions,
  kind = "value",
  compact = false,
}: CopyFieldProps) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.();
    } catch {
      onCopyFailed?.();
    }
  };

  return (
    <div className={compact ? "flex min-w-0 flex-col" : "flex flex-col gap-1.5"}>
      <span id={`${id}-label`} className={compact ? "sr-only" : "text-xs text-text-muted"}>
        {label}
      </span>
      <div
        className={
          compact ? "flex min-w-0 items-center gap-1.5" : "flex flex-wrap items-stretch gap-2"
        }
      >
        <div
          className={
            compact
              ? "flex min-h-8 min-w-0 items-center gap-2 rounded-sm border border-border bg-surface px-2.5 py-1 font-mono text-xs"
              : "flex min-h-10 min-w-0 flex-1 basis-60 items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 font-mono text-sm"
          }
        >
          {kind === "command" ? (
            <span aria-hidden="true" className="text-text-muted select-none">
              $
            </span>
          ) : null}
          {href ? (
            <a href={href} className="min-w-0 break-all underline-offset-4">
              {value}
            </a>
          ) : (
            <code className="min-w-0 break-all">{value}</code>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            aria-describedby={`${id}-label`}
            onClick={() => void copy()}
            className={buttonClasses(
              compact ? { intent: "ghost", size: "sm" } : { intent: "secondary" },
            )}
          >
            <span aria-hidden="true" className="inline-flex">
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </span>
            {copied ? copiedLabel : copyLabel}
          </button>
          {actions}
        </div>
      </div>
    </div>
  );
}
