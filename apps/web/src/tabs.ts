// Keyboard-operable tabs following the WAI-ARIA tabs pattern with automatic activation.
// Markup: a `[role="tablist"]` holding `[role="tab"]` buttons whose `aria-controls` names a
// `[role="tabpanel"]`. The tab with `aria-selected="true"` starts selected.

const MOVES: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

/** Wires every tablist under `root`. Returns the number of tablists wired. */
export function setupTabs(root: ParentNode): number {
  const lists = root.querySelectorAll<HTMLElement>('[role="tablist"]');
  for (const list of lists) wireTablist(list);
  return lists.length;
}

function wireTablist(list: HTMLElement): void {
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
  const select = (selected: HTMLElement): void => {
    for (const tab of tabs) {
      const isSelected = tab === selected;
      tab.setAttribute("aria-selected", String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      const panel = list.ownerDocument.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !isSelected;
    }
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const move = MOVES[event.key];
      if (!move) return;
      event.preventDefault();
      const next = tabs[move(index, tabs.length)];
      if (!next) return;
      select(next);
      next.focus();
    });
  });

  const initial = tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
  if (initial) select(initial);
}
