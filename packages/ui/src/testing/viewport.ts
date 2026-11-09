// A stand-in for the window's width in component tests: happy-dom answers `matchMedia` from a
// fixed 1024 px window, so tests of narrow layouts set the width here instead.

let width: number | null = null;
const listeners = new Set<() => void>();
let original: typeof window.matchMedia | undefined;

/** Whether `query` (only `min-width` and `max-width` in px or rem) matches `px`. */
function matches(query: string, px: number): boolean {
  return [...query.matchAll(/\((min|max)-width:\s*([\d.]+)(px|rem)\)/g)].every(
    ([, bound, value, unit]) => {
      const limit = Number(value) * (unit === "rem" ? 16 : 1);
      return bound === "min" ? px >= limit : px <= limit;
    },
  );
}

/**
 * Makes `matchMedia` answer as if the window were `px` wide and tells every listener, so
 * `useMediaQuery` re-renders. Call `resetViewport` after the test.
 */
export function setViewportWidth(px: number): void {
  if (width === null) {
    original = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        media: query,
        get matches() {
          return matches(query, width ?? 1024);
        },
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: (listener: () => void) => listeners.add(listener),
        removeListener: (listener: () => void) => listeners.delete(listener),
        dispatchEvent: () => true,
      }) as unknown as MediaQueryList;
  }
  width = px;
  for (const listener of [...listeners]) listener();
}

/** Puts the window's own `matchMedia` back. */
export function resetViewport(): void {
  if (width === null) return;
  width = null;
  listeners.clear();
  if (original) window.matchMedia = original;
}
