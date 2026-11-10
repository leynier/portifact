import { Check, ChevronsUpDown } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Avatar } from "../components/avatar.tsx";
import { Tooltip } from "../components/tooltip.tsx";
import { useSidebarCollapsed } from "./app-shell.tsx";

/** One space the person can switch to, such as their personal space or a workspace. */
export interface SpaceSwitcherOption {
  key: string;
  name: string;
  /** A second line, such as the person's role there. */
  detail: string;
  current: boolean;
  /**
   * Renders the link to the space with the given class, content and current marker; `onClick`
   * closes the list once the link is followed. A router link may mark the current space
   * `aria-current="page"` instead, which looks the same.
   */
  render(props: {
    className: string;
    children: ReactNode;
    "aria-current"?: "true";
    onClick(): void;
  }): ReactNode;
}

export interface SpaceSwitcherProps {
  /** What the control chooses, such as "Space"; shown above the current space and names the list. */
  label: string;
  current: { name: string; detail: string };
  options: SpaceSwitcherOption[];
  /** Shown under the list, such as a link to pending invitations. */
  footer?: ReactNode;
}

const optionClasses =
  "flex min-w-0 items-center gap-2.5 rounded-xs px-2 py-1.5 text-sm text-text no-underline hover:bg-surface-hover current-item:font-semibold current-item:selection-band current-item:hover:bg-selection current:font-semibold current:selection-band current:hover:bg-selection";

/**
 * Chooses the space the dashboard shows, at the top of the sidebar and the drawer (the disclosure
 * navigation pattern): a button with the current space and the person's role there opens a list
 * of links to every space, the current one marked with `aria-current`, a check and weight. Escape
 * closes it and returns focus to the button; so does following a link or pressing outside. In the
 * collapsed rail the button is the space's initial with a tooltip, and the list floats beside it.
 */
export function SpaceSwitcher({ label, current, options, footer }: SpaceSwitcherProps) {
  const collapsed = useSidebarCollapsed();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };

  const avatar = <Avatar name={current.name} size="md" />;
  const trigger = (
    <button
      ref={button}
      type="button"
      aria-expanded={open}
      aria-controls={listId}
      onClick={() => setOpen((value) => !value)}
      {...(collapsed ? { "aria-label": `${label}: ${current.name}, ${current.detail}` } : {})}
      className={
        collapsed
          ? "inline-flex rounded-full transition-opacity duration-150 hover:opacity-85"
          : "flex w-full min-w-0 items-center gap-2.5 rounded-sm border border-border bg-canvas p-1.5 text-left transition-colors duration-150 hover:bg-surface-hover"
      }
    >
      {collapsed ? (
        avatar
      ) : (
        <>
          {avatar}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs text-text-muted">{label}</span>{" "}
            <span className="truncate text-sm font-semibold">{current.name}</span>{" "}
            <span className="truncate text-xs text-text-muted">{current.detail}</span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
        </>
      )}
    </button>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere inside closes the list
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      {collapsed ? (
        <div className="flex justify-center">
          <Tooltip label={`${label}: ${current.name}`} side="right" disabled={open}>
            {trigger}
          </Tooltip>
        </div>
      ) : (
        trigger
      )}
      <div
        id={listId}
        hidden={!open}
        className={
          collapsed
            ? "absolute top-0 left-full z-40 ml-3 w-64 rounded-md border border-border bg-surface-raised p-1 shadow-raised"
            : "mt-1 rounded-md border border-border bg-surface-raised p-1 shadow-raised"
        }
      >
        <span id={labelId} className="sr-only">
          {label}
        </span>
        <ul aria-labelledby={labelId} className="flex flex-col gap-0.5">
          {options.map((option) => (
            <li key={option.key}>
              {option.render({
                className: optionClasses,
                ...(option.current ? { "aria-current": "true" as const } : {}),
                onClick: () => setOpen(false),
                children: (
                  <>
                    <Avatar name={option.name} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.name}</span>{" "}
                      <span className="truncate text-xs font-normal text-text-muted">
                        {option.detail}
                      </span>
                    </span>
                    {option.current ? (
                      <Check aria-hidden="true" className="size-4 shrink-0" />
                    ) : null}
                  </>
                ),
              })}
            </li>
          ))}
        </ul>
        {footer ? <div className="mt-1 border-t border-border px-2 pt-2 pb-1">{footer}</div> : null}
      </div>
    </div>
  );
}
