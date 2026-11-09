import { cva } from "class-variance-authority";
import { Ellipsis } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { IconButton } from "./icon-button.tsx";

interface MenuItemBase {
  /** Stable key of the item. */
  id: string;
  label: string;
  /** Decorative icon before the label. */
  icon?: ReactNode;
}

/**
 * An action, or a link when it has an `href`. A link stays open until the page navigates, because
 * a link removed during its own click no longer navigates.
 */
export type MenuItem =
  | (MenuItemBase & { onSelect(): void; href?: undefined })
  | (MenuItemBase & { href: string; onSelect?: undefined });

export interface MenuProps {
  /** Accessible name of the button that opens the menu, also its tooltip. */
  label: string;
  items: MenuItem[];
  /** The button's icon; an ellipsis by default. */
  icon?: ReactNode;
  /** Which edge of the button the list lines up with: `end` near the right of the screen. */
  align?: "start" | "end";
  size?: "sm" | "xs";
  /** The button that opens the menu, for moving focus back to it. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

const listClasses = cva(
  "absolute top-full z-40 mt-1 flex min-w-40 flex-col rounded-md border border-border bg-surface-raised p-1 shadow-raised motion-safe:animate-pop",
  {
    variants: { align: { start: "left-0", end: "right-0" } },
    defaultVariants: { align: "end" },
  },
);

const ITEM_CLASSES =
  "flex h-9 w-full items-center gap-2 rounded-xs px-2.5 text-left text-sm whitespace-nowrap text-text no-underline hover:bg-surface-hover";

/**
 * A button that opens a short list of actions (the ARIA menu button pattern): the arrow keys,
 * Home and End move between items, Enter or Space chooses one, and Escape, Tab or a click outside
 * closes it. Focus returns to the button unless the chosen action moved it somewhere else, such
 * as into a form it opened.
 */
export function Menu({ label, items, icon, align = "end", size = "xs", buttonRef }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = buttonRef ?? ownTrigger;
  const list = useRef<HTMLDivElement>(null);
  /** Which item takes focus once the list opens. */
  const startAt = useRef<"first" | "last">("first");
  const id = useId();

  const entries = () =>
    Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    const all = entries();
    (startAt.current === "first" ? all[0] : all.at(-1))?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const choose = (item: MenuItem) => {
    close(false);
    item.onSelect?.();
    // Back to the button, unless the action put focus somewhere (a form, a dialog).
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || list.current?.contains(active)) {
        trigger.current?.focus();
      }
    }, 0);
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    startAt.current = event.key === "ArrowDown" ? "first" : "last";
    setOpen(true);
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      all[(index + all.length) % all.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(at + 1);
      case "ArrowUp":
        return move(at - 1);
      case "Home":
        return move(0);
      case "End":
        return move(all.length - 1);
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        return close(true);
      case "Tab":
        return close(false);
    }
  };

  return (
    <span ref={root} className="relative inline-flex">
      <IconButton
        ref={trigger}
        id={`${id}-button`}
        label={label}
        icon={icon ?? <Ellipsis className="size-4" />}
        size={size}
        align={align}
        hideTooltip={open}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => {
          startAt.current = "first";
          setOpen((current) => !current);
        }}
        onKeyDown={onTriggerKey}
      />
      {open ? (
        <div
          ref={list}
          id={`${id}-menu`}
          role="menu"
          aria-labelledby={`${id}-button`}
          className={listClasses({ align })}
          onKeyDown={onListKey}
        >
          {items.map((item) => {
            const content = (
              <>
                {item.icon ? (
                  <span aria-hidden="true" className="inline-flex text-text-muted">
                    {item.icon}
                  </span>
                ) : null}
                {item.label}
              </>
            );
            return (
              <Fragment key={item.id}>
                {item.href !== undefined ? (
                  <a href={item.href} role="menuitem" tabIndex={-1} className={ITEM_CLASSES}>
                    {content}
                  </a>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={ITEM_CLASSES}
                    onClick={() => choose(item)}
                  >
                    {content}
                  </button>
                )}
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
