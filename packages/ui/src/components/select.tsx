// One choice among many, drawn by the design system instead of the browser so it looks the same
// in every engine and theme. It follows the WAI-ARIA "select-only combobox" pattern: focus stays
// on the trigger, the listbox points at the active option with `aria-activedescendant`, and the
// keyboard works like a native select (arrows, Home, End, Page keys, typeahead, Enter, Space,
// Escape and Tab).
import { Check, ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { describedBy, FieldError } from "./fields.tsx";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** The language of the label when it differs from the page's, such as a language's own name. */
  lang?: string;
}

export interface SelectProps<T extends string = string> {
  label: string;
  /**
   * Show the label (the default). Hide it only where the surroundings already say what the
   * choice is about, such as a row of a list; assistive technology still reads it.
   */
  labelVisible?: boolean;
  description?: ReactNode;
  error?: string | undefined;
  value: T;
  options: readonly SelectOption<T>[];
  onChange(value: T): void;
  onBlur?(): void;
  disabled?: boolean | undefined;
  /** Submitted with a native form, through a hidden input. */
  name?: string;
  /**
   * `field` (the default) fills its column with the label above it. `compact` is a chip for
   * toolbars, such as the filters above a list: the label sits inside the trigger before the
   * chosen option.
   */
  variant?: "field" | "compact";
  /**
   * The choice differs from the neutral one, such as a filter that is on. A compact trigger
   * then has a solid strong border and its value in bold, so it never relies on tone.
   */
  active?: boolean;
}

/** How long typed characters keep adding to one typeahead search. */
const TYPEAHEAD_MS = 500;
/** Options moved by Page Up and Page Down. */
const PAGE = 10;
/** Space kept between the listbox and the edges of the window. */
const GUTTER = 8;
/** Gap between the trigger and the listbox. */
const OFFSET = 4;

/**
 * Where the listbox goes: under the trigger, or above it when there is more room there, kept
 * inside the window. Exported for its tests; happy-dom lays nothing out.
 */
export function placeListbox(
  trigger: { top: number; bottom: number; left: number; width: number },
  list: { width: number; height: number },
  view: { width: number; height: number },
): { top: number; left: number; maxHeight: number; width: number } {
  const width = Math.min(Math.max(list.width, trigger.width), view.width - 2 * GUTTER);
  const below = view.height - trigger.bottom - OFFSET - GUTTER;
  const above = trigger.top - OFFSET - GUTTER;
  const up = list.height > below && above > below;
  const maxHeight = Math.max(0, up ? above : below);
  const height = Math.min(list.height, maxHeight);
  const top = up ? trigger.top - OFFSET - height : trigger.bottom + OFFSET;
  const left = Math.min(
    Math.max(GUTTER, trigger.left),
    Math.max(GUTTER, view.width - GUTTER - width),
  );
  return { top, left, maxHeight, width };
}

/** The index of the next option whose label starts with `typed`, after `from`, wrapping. */
export function typeaheadMatch(
  labels: readonly string[],
  typed: string,
  from: number,
): number | null {
  const query = typed.toLocaleLowerCase();
  // Repeating one letter cycles through the options that start with it.
  const repeated = query.length > 1 && [...query].every((char) => char === query[0]);
  const needle = repeated ? (query[0] ?? "") : query;
  const start = repeated || query.length === 1 ? from + 1 : from;
  for (let step = 0; step < labels.length; step++) {
    const index = (start + step) % labels.length;
    if (labels[index]?.toLocaleLowerCase().startsWith(needle)) return index;
  }
  return null;
}

/**
 * One choice among many: a button that shows the chosen option and opens a listbox of the
 * others, with a check on the chosen one. Use a radio group instead when every option needs
 * explaining. The listbox is rendered at the end of the landmark that holds the trigger and placed
 * in the window with fixed coordinates, so a scrolling or clipping parent never cuts it.
 */
export function Select<T extends string = string>({
  label,
  labelVisible = true,
  description,
  error,
  value,
  options,
  onChange,
  onBlur,
  disabled = false,
  name,
  variant = "field",
  active = false,
}: SelectProps<T>) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const listId = `${id}-listbox`;
  const triggerId = `${id}-trigger`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // The active option is outlined only while the keyboard moves it; the pointer has hover.
  const [keyboard, setKeyboard] = useState(false);
  // Where the listbox is rendered: the landmark or modal dialog that holds the trigger, so it
  // stays inside the page's landmarks and is never made inert by an open dialog.
  const [host, setHost] = useState<Element | null>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  const show = (index: number, fromKeyboard: boolean) => {
    setActiveIndex(Math.min(Math.max(index, 0), options.length - 1));
    setKeyboard(fromKeyboard);
    setHost(trigger.current?.closest("dialog, main, [role=main]") ?? document.body);
    setOpen(true);
  };
  const close = useCallback(() => setOpen(false), []);
  const choose = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
  };

  const place = useCallback(() => {
    const button = trigger.current;
    const listbox = list.current;
    if (!button || !listbox) return;
    const box = button.getBoundingClientRect();
    listbox.style.maxHeight = "";
    const spot = placeListbox(
      box,
      { width: listbox.offsetWidth, height: listbox.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    // Coordinates through the CSSOM, the dynamic-geometry exception of the design rules.
    listbox.style.top = `${spot.top}px`;
    listbox.style.left = `${spot.left}px`;
    listbox.style.minWidth = `${box.width}px`;
    listbox.style.maxWidth = `${window.innerWidth - 2 * GUTTER}px`;
    listbox.style.maxHeight = `${spot.maxHeight}px`;
    listbox.style.visibility = "visible";
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Follow the trigger while the page scrolls or the window changes, and close on a press
  // anywhere else.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger.current?.contains(target) || list.current?.contains(target))) return;
      close();
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, place, close]);

  // Keep the active option in view as the keyboard moves it.
  useEffect(() => {
    if (!open) return;
    const element = document.getElementById(optionId(activeIndex));
    element?.scrollIntoView?.({ block: "nearest" });
  });

  const typeahead = (char: string) => {
    const now = Date.now();
    const text = now - typed.current.at > TYPEAHEAD_MS ? char : typed.current.text + char;
    typed.current = { text, at: now };
    const from = open ? activeIndex : Math.max(selectedIndex, 0);
    return typeaheadMatch(
      options.map((option) => option.label),
      text,
      from,
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1;
    const current = Math.max(selectedIndex, 0);
    const key = event.key;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        show(current, true);
      } else if (key === "Home") {
        event.preventDefault();
        show(0, true);
      } else if (key === "End") {
        event.preventDefault();
        show(last, true);
      } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const match = typeahead(key);
        if (match !== null) show(match, true);
      }
      return;
    }
    const move = (index: number) => {
      event.preventDefault();
      setKeyboard(true);
      setActiveIndex(Math.min(Math.max(index, 0), last));
    };
    switch (key) {
      case "ArrowDown":
        if (event.altKey) return;
        move(activeIndex + 1);
        return;
      case "ArrowUp":
        if (event.altKey) {
          event.preventDefault();
          choose(activeIndex);
          return;
        }
        move(activeIndex - 1);
        return;
      case "Home":
        move(0);
        return;
      case "End":
        move(last);
        return;
      case "PageDown":
        move(activeIndex + PAGE);
        return;
      case "PageUp":
        move(activeIndex - PAGE);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (key === " " && Date.now() - typed.current.at < TYPEAHEAD_MS && typed.current.text) {
          // A space inside a typeahead search is part of the label being typed.
          const match = typeahead(" ");
          if (match !== null) move(match);
          return;
        }
        choose(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        close();
        return;
      case "Tab":
        // Like a native select: leaving keeps the highlighted option.
        choose(activeIndex);
        return;
      default:
        if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const match = typeahead(key);
          if (match !== null) move(match);
        }
    }
  };

  const compact = variant === "compact";
  const triggerClasses = compact
    ? `inline-flex h-8 max-w-full items-center gap-1.5 rounded-sm border bg-canvas pr-2 pl-3 text-sm text-text transition-colors duration-150 hover:bg-surface-hover disabled:opacity-55 disabled:hover:bg-canvas aria-expanded:bg-surface-hover ${active ? "border-text" : "border-border-strong"}`
    : "flex h-10 w-full items-center justify-between gap-2 rounded-sm border border-border-strong bg-canvas pr-2.5 pl-3 text-left text-sm text-text transition-colors duration-150 hover:border-text disabled:opacity-55 disabled:hover:border-border-strong aria-invalid:border-2 aria-invalid:border-text";

  const button = (
    <button
      ref={trigger}
      id={triggerId}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? optionId(activeIndex) : undefined}
      aria-labelledby={labelId}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(description !== undefined && hintId, error && errorId)}
      disabled={disabled}
      onClick={() => (open ? close() : show(Math.max(selectedIndex, 0), false))}
      onKeyDown={onKeyDown}
      onBlur={() => {
        // Choosing with the pointer keeps focus on the trigger (see the options below).
        close();
        onBlur?.();
      }}
      className={triggerClasses}
    >
      {compact ? (
        <span id={labelId} className="shrink-0 text-text-muted">
          {label}
        </span>
      ) : null}
      <span
        lang={selected?.lang}
        className={`min-w-0 truncate ${compact && active ? "font-semibold" : ""}`}
      >
        {selected?.label ?? ""}
      </span>
      <ChevronDown
        aria-hidden="true"
        className={`size-4 shrink-0 text-text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`}
      />
    </button>
  );

  const listbox =
    open && host
      ? createPortal(
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            className="invisible fixed z-50 overflow-y-auto rounded-md border border-border bg-surface-raised p-1 text-sm text-text shadow-float motion-safe:animate-pop"
          >
            {options.map((option, index) => {
              const chosen = index === selectedIndex;
              const current = index === activeIndex;
              return (
                // Options are never focused: the trigger keeps focus and points at the active one
                // with aria-activedescendant, and its own key handler does the keyboard.
                // biome-ignore lint/a11y/useFocusableInteractive: the select-only combobox pattern
                // biome-ignore lint/a11y/useKeyWithClickEvents: the trigger handles every key
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={chosen}
                  lang={option.lang}
                  data-active={current && keyboard ? "" : undefined}
                  // Keep focus on the trigger, so it never leaves the control while choosing.
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => {
                    if (index !== activeIndex || keyboard) {
                      setActiveIndex(index);
                      setKeyboard(false);
                    }
                  }}
                  onClick={() => {
                    choose(index);
                    trigger.current?.focus();
                  }}
                  className={`flex min-h-8 items-center gap-2 rounded-xs py-1.5 pr-3 pl-2 whitespace-nowrap select-none hover:bg-surface-hover data-active:outline-2 data-active:-outline-offset-2 data-active:outline-focus ${chosen ? "bg-selection font-semibold hover:bg-selection" : current ? "bg-surface-hover" : ""}`}
                >
                  <span aria-hidden="true" className="inline-flex size-4 shrink-0">
                    {chosen ? <Check className="size-4" /> : null}
                  </span>
                  {option.label}
                </div>
              );
            })}
          </div>,
          host,
        )
      : null;

  const hidden = name ? <input type="hidden" name={name} value={value} /> : null;

  if (compact) {
    return (
      <>
        {button}
        {listbox}
        {hidden}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label
        id={labelId}
        htmlFor={triggerId}
        className={labelVisible ? "text-sm font-medium" : "sr-only"}
      >
        {label}
      </label>
      {description ? (
        <p id={hintId} className="text-sm text-text-muted">
          {description}
        </p>
      ) : null}
      {button}
      {listbox}
      {hidden}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
