// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery, WIDE_QUERY } from "../hooks/use-media-query.ts";
import { PageSection, SectionedPage } from "../patterns/section-nav.tsx";
import { axeViolations, resetViewport, setViewportWidth } from "../testing/axe.ts";
import { Sheet } from "./sheet.tsx";
import {
  rowControlClasses,
  rowLinkClasses,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "./table.tsx";

afterEach(() => {
  cleanup();
  resetViewport();
});

function SheetExample({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Filters
      </button>
      <Sheet
        open={open}
        title="Filter artifacts"
        closeLabel="Close the filters"
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        footer={
          <button type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        }
      >
        <p>Choose filters</p>
      </Sheet>
    </main>
  );
}

describe("Sheet", () => {
  it("opens as a named modal dialog and gives focus back to its opener when it closes", async () => {
    render(<SheetExample />);
    const opener = screen.getByRole("button", { name: "Filters" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Filter artifacts" }) as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(within(dialog).getByText("Choose filters")).toBeTruthy();
    expect(await axeViolations(document.body)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("closes from its corner button, Escape and a press on the dimmed page, not inside", () => {
    const onClose = vi.fn();
    render(<SheetExample onClose={onClose} />);
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close the filters" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    open();
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);

    open();
    fireEvent.click(screen.getByText("Choose filters"));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("useMediaQuery", () => {
  it("answers the fallback without matchMedia", () => {
    const original = window.matchMedia;
    // @ts-expect-error: a browser without matchMedia
    window.matchMedia = undefined;
    try {
      expect(renderHook(() => useMediaQuery(WIDE_QUERY, false)).result.current).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });

  it("follows the window across the wide breakpoint", () => {
    setViewportWidth(1024);
    const { result } = renderHook(() => useMediaQuery(WIDE_QUERY));
    expect(result.current).toBe(true);
    act(() => setViewportWidth(375));
    expect(result.current).toBe(false);
    act(() => setViewportWidth(640));
    expect(result.current).toBe(true);
    act(() => setViewportWidth(639));
    expect(result.current).toBe(false);
  });
});

describe("SectionedPage", () => {
  const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "sharing", label: "Sharing" },
    { id: "danger", label: "Danger zone" },
  ];

  function Example() {
    return (
      <main>
        <SectionedPage label="Artifact sections" title="On this page" sections={SECTIONS}>
          <PageSection id="overview" title="Overview" description="What it is">
            <p>Details</p>
          </PageSection>
          <PageSection id="sharing" title="Sharing">
            <p>Access</p>
          </PageSection>
          <PageSection id="danger" title="Danger zone" tone="danger">
            <p>Delete</p>
          </PageSection>
        </SectionedPage>
      </main>
    );
  }

  /** The window `matchMedia` answers for: its width and whether reduced motion is asked for. */
  function stubMedia({ width, reduce }: { width: number; reduce: boolean }) {
    const original = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        media: query,
        matches: query.includes("reduced-motion")
          ? reduce
          : width >= Number(/min-width:\s*([\d.]+)rem/.exec(query)?.[1] ?? 0) * 16,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList;
    return () => {
      window.matchMedia = original;
    };
  }

  /** Captures the scroll spy's observer, so a test can say which sections are in view. */
  function stubObserver() {
    const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      targets: Element[] = [];
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback, targets: this.targets });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    const show = (inView: string[]) => {
      const observer = observers[observers.length - 1];
      if (!observer) throw new Error("no observer");
      act(() =>
        observer.callback(
          observer.targets.map(
            (target) =>
              ({ target, isIntersecting: inView.includes(target.id) }) as IntersectionObserverEntry,
          ),
          {} as IntersectionObserver,
        ),
      );
    };
    return {
      show,
      restore: () => {
        globalThis.IntersectionObserver = original;
      },
    };
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("puts a titled guide at the end on wide screens and marks the first section current", async () => {
    const restore = stubMedia({ width: 1440, reduce: false });
    const { container } = render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Artifact sections" });
    expect(nav.textContent).toContain("On this page");
    expect(nav.querySelector("details")).toBeNull();
    // The guide comes first for the keyboard, and the grid draws it in the column at the end.
    expect(nav.compareDocumentPosition(screen.getByRole("region", { name: "Overview" }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Overview", "#overview"],
      ["Sharing", "#sharing"],
      ["Danger zone", "#danger"],
    ]);
    expect(links[0]?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("region", { name: "Danger zone" }).id).toBe("danger");
    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Overview" }).textContent).toContain("What it is");
    expect(await axeViolations(container)).toEqual([]);
    restore();
  });

  it("scrolls smoothly to a followed section, focuses it and keeps the address shareable", () => {
    const restore = stubMedia({ width: 1440, reduce: false });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Artifact sections" });
    const link = within(nav).getByRole("link", { name: "Sharing" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    const section = screen.getByRole("region", { name: "Sharing" });
    expect(document.activeElement).toBe(section);
    expect(section.getAttribute("tabindex")).toBe("-1");
    expect(window.location.hash).toBe("#sharing");
    expect(link.getAttribute("aria-current")).toBe("true");
    expect(within(nav).getByRole("link", { name: "Overview" }).hasAttribute("aria-current")).toBe(
      false,
    );
    restore();
  });

  it("jumps without motion under reduced motion, and leaves new-tab clicks to the browser", () => {
    const restore = stubMedia({ width: 1440, reduce: true });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Artifact sections" });
    fireEvent.click(within(nav).getByRole("link", { name: "Danger zone" }));
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "start" });

    scroll.mockClear();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    fireEvent(within(nav).getByRole("link", { name: "Sharing" }), event);
    expect(event.defaultPrevented).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    restore();
  });

  it("follows the section in view, and the last one at the end of the page", () => {
    const restore = stubMedia({ width: 1440, reduce: false });
    const spy = stubObserver();
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Artifact sections" });
    const current = () => within(nav).getByRole("link", { current: true }).textContent;
    expect(current()).toBe("Overview");

    spy.show(["sharing", "danger"]);
    expect(current()).toBe("Sharing");
    spy.show(["overview"]);
    expect(current()).toBe("Overview");

    // Scrolled to the bottom: the short last section never reaches the top of the window.
    vi.spyOn(window, "scrollY", "get").mockReturnValue(900);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(1700);
    spy.show(["sharing"]);
    expect(current()).toBe("Danger zone");
    spy.restore();
    restore();
  });

  it("keeps a followed section current until the person scrolls again", () => {
    const restore = stubMedia({ width: 1440, reduce: true });
    const spy = stubObserver();
    Element.prototype.scrollIntoView = vi.fn();
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Artifact sections" });
    const current = () => within(nav).getByRole("link", { current: true }).textContent;
    fireEvent.click(within(nav).getByRole("link", { name: "Sharing" }));
    // The page cannot bring Sharing to the top: the spy sees Overview, but the choice holds.
    spy.show(["overview", "sharing"]);
    expect(current()).toBe("Sharing");
    // A key that does not scroll keeps it; the person's own scrolling hands it back.
    fireEvent.keyDown(window, { key: "Tab" });
    spy.show(["overview", "sharing"]);
    expect(current()).toBe("Sharing");
    fireEvent.wheel(window);
    spy.show(["overview", "sharing"]);
    expect(current()).toBe("Overview");
    fireEvent.click(within(nav).getByRole("link", { name: "Danger zone" }));
    fireEvent.keyDown(window, { key: "PageUp" });
    spy.show(["sharing"]);
    expect(current()).toBe("Sharing");
    spy.restore();
    restore();
  });

  it("starts at the section named in the address", () => {
    const restore = stubMedia({ width: 1440, reduce: false });
    window.history.replaceState(null, "", "/#danger");
    render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Artifact sections" });
    expect(within(nav).getByRole("link", { current: true }).textContent).toBe("Danger zone");
    restore();
  });

  it("is a compact menu at the top on narrow screens that closes when a section is chosen", async () => {
    const restore = stubMedia({ width: 375, reduce: true });
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = render(<Example />);
    const nav = screen.getByRole("navigation", { name: "Artifact sections" });
    const details = nav.querySelector("details") as HTMLDetailsElement;
    const summary = nav.querySelector("summary") as HTMLElement;
    expect(details.open).toBe(false);
    expect(summary.textContent).toBe("On this pageOverview");
    expect(await axeViolations(container)).toEqual([]);

    details.open = true;
    fireEvent(details, new Event("toggle"));
    fireEvent.click(within(nav).getByRole("link", { name: "Sharing" }));
    expect(details.open).toBe(false);
    expect(summary.textContent).toBe("On this pageSharing");
    expect(await axeViolations(container)).toEqual([]);
    restore();
  });
});

describe("Table", () => {
  function Example({ stacked }: { stacked: boolean }) {
    return (
      <main>
        <Table caption="Your artifacts" stacked={stacked}>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Expires</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow linked>
              <TableCell>
                <a href="/artifacts/a" className={rowLinkClasses}>
                  Launch plan
                </a>
              </TableCell>
              <TableCell label="Expires" stack="inline">
                Dec 8
              </TableCell>
              <TableCell stack="end">
                <a href="https://a.example/" className={rowControlClasses}>
                  Open
                </a>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </main>
    );
  }

  it("stacks rows on narrow screens with explicit table roles and labels only for the eye", async () => {
    const { container } = render(<Example stacked />);
    const table = screen.getByRole("table");
    expect(table.getAttribute("role")).toBe("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getAllByRole("columnheader")).toHaveLength(3);
    const cells = within(rows[1] as HTMLElement).getAllByRole("cell");
    // The visible label is hidden from assistive technology; the column header names the cell.
    const label = within(cells[1] as HTMLElement).getByText("Expires");
    expect(label.getAttribute("aria-hidden")).toBe("true");
    // A stacked table never scrolls sideways, so its region is not a tab stop.
    expect(screen.getByRole("region", { name: "Your artifacts" }).hasAttribute("tabindex")).toBe(
      false,
    );
    // The row's link and its own control stay two separate, real links.
    expect(
      within(rows[1] as HTMLElement)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Launch plan", "Open"]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("keeps a plain table that scrolls in its own region when it does not stack", async () => {
    const { container } = render(<Example stacked={false} />);
    expect(screen.getByRole("table").hasAttribute("role")).toBe(false);
    expect(screen.queryByText("Expires", { selector: "span" })).toBeNull();
    expect(screen.getByRole("region", { name: "Your artifacts" }).getAttribute("tabindex")).toBe(
      "0",
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
