// A labelled tab list with its panels (WAI-ARIA tabs pattern, automatic activation): the arrow
// keys, Home and End move between tabs and show their panel; only the selected tab is in the tab
// order, and Tab moves on into the panel.
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
}

export interface TabsProps {
  /** Accessible name of the tab list, such as "Suggested change". */
  label: string;
  tabs: readonly TabItem[];
  /** The tab shown first; the first tab when omitted. */
  initial?: string;
  /** Called when another tab is shown. */
  onChange?(id: string): void;
}

export function Tabs({ label, tabs, initial, onChange }: TabsProps) {
  const base = useId();
  const [selected, setSelected] = useState(initial ?? tabs[0]?.id ?? "");
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const current = tabs.some((tab) => tab.id === selected) ? selected : (tabs[0]?.id ?? "");

  const show = (id: string, focus: boolean) => {
    setSelected(id);
    onChange?.(id);
    if (focus) buttons.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === current);
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab) show(tab.id, true);
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1 border-b border-border"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const active = tab.id === current;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element) buttons.current.set(tab.id, element);
                else buttons.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => show(tab.id, false)}
              className={`-mb-px min-h-11 border-b-2 px-3 text-sm font-medium ${
                active
                  ? "border-text text-text"
                  : "border-transparent text-text-muted hover:text-text"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={tab.id !== current}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the tabs pattern puts the panel in the tab order
          tabIndex={0}
        >
          {tab.id === current ? tab.panel : null}
        </div>
      ))}
    </div>
  );
}
