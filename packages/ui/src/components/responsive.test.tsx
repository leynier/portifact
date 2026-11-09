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
  it("names its navigation, links each section and marks the first one current", async () => {
    const { container } = render(
      <main>
        <SectionedPage
          label="Artifact sections"
          sections={[
            { id: "overview", label: "Overview" },
            { id: "danger", label: "Danger zone" },
          ]}
        >
          <PageSection id="overview" title="Overview" description="What it is">
            <p>Details</p>
          </PageSection>
          <PageSection id="danger" title="Danger zone" tone="danger">
            <p>Delete</p>
          </PageSection>
        </SectionedPage>
      </main>,
    );
    const nav = screen.getByRole("navigation", { name: "Artifact sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Overview", "#overview"],
      ["Danger zone", "#danger"],
    ]);
    expect(links[0]?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("region", { name: "Danger zone" }).id).toBe("danger");
    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Overview" }).textContent).toContain("What it is");

    // Following a link makes it the current one.
    fireEvent.click(links[1] as HTMLElement);
    expect(links[1]?.getAttribute("aria-current")).toBe("true");
    expect(links[0]?.hasAttribute("aria-current")).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
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
