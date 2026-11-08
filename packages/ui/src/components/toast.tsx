import { CircleCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface ToastProps {
  /**
   * The latest result of an action, such as "Artifact archived". Every new message is announced
   * politely and shown for a while; an empty message shows nothing.
   */
  message: string;
  /** Accessible name of the button that hides the toast. */
  dismissLabel: string;
  /** How long a message stays on screen, unless the pointer or focus is on it. */
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 6000;

/**
 * The shell's polite live region, drawn as a toast. The text stays in the live region after the
 * toast hides, so it is announced once and never removed from under a screen reader; hovering or
 * focusing the toast keeps it open (WCAG 2.2.1). Toasts only report results: anything they offer
 * is also available on the screen.
 */
export function Toast({ message, dismissLabel, durationMs = DEFAULT_DURATION_MS }: ToastProps) {
  const [shown, setShown] = useState(false);
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setShown(message !== "");
  }, [message]);

  useEffect(() => {
    if (!shown || held) return;
    timer.current = setTimeout(() => setShown(false), durationMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [shown, held, durationMs, message]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering or focusing only pauses the timer, it acts on nothing
    <div
      className={
        shown
          ? "fixed right-4 bottom-4 left-4 z-50 flex justify-center sm:left-auto sm:justify-end"
          : "sr-only"
      }
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div
        className={
          shown
            ? "flex max-w-md items-start gap-3 rounded-md bg-surface-inverse py-3 pr-2 pl-4 text-sm text-text-inverse shadow-raised motion-safe:animate-pop"
            : ""
        }
      >
        {shown ? <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
        <p role="status" aria-live="polite" className="min-w-0 flex-1 break-words">
          {message}
        </p>
        {shown ? (
          <button
            type="button"
            aria-label={dismissLabel}
            onClick={() => setShown(false)}
            className="-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-xs hover:bg-text-inverse/15"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
