// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { Badge } from "./badge.tsx";
import { buttonClasses } from "./button.tsx";
import { Callout } from "./callout.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { CopyField } from "./copy-field.tsx";
import { DetailList } from "./detail-list.tsx";
import { DropZone, readDrop } from "./drop-zone.tsx";
import { LoadingState } from "./loading-state.tsx";
import { Meter } from "./meter.tsx";
import { Panel } from "./panel.tsx";
import { Steps } from "./steps.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "./table.tsx";
import { Toast } from "./toast.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Panel", () => {
  it("is a region named by its heading, with its description and actions", async () => {
    const { container } = render(
      <Panel
        id="usage"
        title="Usage"
        description="What the account uses"
        actions={<button type="button">Export</button>}
      >
        <p>Body</p>
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "Usage" });
    expect(region.id).toBe("usage");
    expect(screen.getByRole("heading", { level: 2, name: "Usage" })).toBeTruthy();
    expect(region.textContent).toContain("What the account uses");
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("takes a lower heading level and works without an id", () => {
    render(
      <Panel title="Readers" headingLevel={3} flush>
        <p>Body</p>
      </Panel>,
    );
    expect(screen.getByRole("region", { name: "Readers" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Readers" })).toBeTruthy();
  });
});

describe("Meter", () => {
  const meter = (value: number) =>
    render(
      <Meter
        label="Storage"
        value={value}
        max={100}
        valueText={`${value} of 100`}
        nearLimitLabel="Near the limit"
        atLimitLabel="Limit reached"
      />,
    );

  it("is a named meter read with its amount in words", async () => {
    const { container } = meter(20);
    const bar = screen.getByRole("meter");
    expect(document.getElementById(bar.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      "Storage",
    );
    expect(document.getElementById(bar.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "20 of 100",
    );
    expect(bar.getAttribute("value")).toBe("20");
    expect(screen.queryByText("Near the limit")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says in words when the amount is near or at the limit", async () => {
    const { container } = meter(85);
    const bar = screen.getByRole("meter");
    const [, state] = (bar.getAttribute("aria-describedby") ?? "").split(" ");
    expect(document.getElementById(state ?? "")?.textContent).toBe("Near the limit");
    expect(await axeViolations(container)).toEqual([]);
    cleanup();
    meter(140);
    expect(screen.getByText("Limit reached")).toBeTruthy();
    // Over the limit, the bar stays full instead of overflowing.
    expect(screen.getByRole("meter").getAttribute("value")).toBe("100");
  });

  it("never warns about a limit of zero", () => {
    render(
      <Meter
        label="Nothing"
        value={0}
        max={0}
        valueText="0 of 0"
        nearLimitLabel="Near"
        atLimitLabel="At"
      />,
    );
    expect(screen.queryByText("At")).toBeNull();
    expect(screen.queryByText("Near")).toBeNull();
  });
});

describe("Toast", () => {
  it("announces each message politely, shows it for a while and keeps it in the live region", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Toast message="" dismissLabel="Dismiss" />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    rerender(<Toast message="Artifact archived" dismissLabel="Dismiss" durationMs={1000} />);
    expect(screen.getByRole("status").textContent).toBe("Artifact archived");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    // Hidden from sight, but the text stays where a screen reader found it.
    expect(screen.getByRole("status").textContent).toBe("Artifact archived");
  });

  it("passes the accessibility check while shown", async () => {
    const { container } = render(<Toast message="Artifact archived" dismissLabel="Dismiss" />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("stays while the pointer or focus is on it, and hides when dismissed", () => {
    vi.useFakeTimers();
    render(<Toast message="Link copied" dismissLabel="Dismiss" durationMs={1000} />);
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    fireEvent.pointerEnter(dismiss.parentElement?.parentElement as HTMLElement);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    fireEvent.pointerLeave(dismiss.parentElement?.parentElement as HTMLElement);
    fireEvent.focus(dismiss);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});

describe("CopyField", () => {
  it("shows the value as a link and copies it, then says it did", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onCopied = vi.fn();
    const { container } = render(
      <CopyField
        label="Link"
        value="https://a.portifact.dev/"
        href="https://a.portifact.dev/"
        copyLabel="Copy link"
        copiedLabel="Copied"
        onCopied={onCopied}
        actions={<a href="https://a.portifact.dev/">Open</a>}
      />,
    );
    expect(
      screen.getByRole("link", { name: "https://a.portifact.dev/" }).getAttribute("href"),
    ).toBe("https://a.portifact.dev/");
    const button = screen.getByRole("button", { name: "Copy link" });
    // The button is described by what it copies.
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Link");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(button);
    await waitFor(() => expect(onCopied).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("https://a.portifact.dev/");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("reports a refused clipboard and shows a command with a prompt", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onCopyFailed = vi.fn();
    render(
      <CopyField
        kind="command"
        label="Install"
        value="curl -fsSL https://portifact.com/install | bash"
        copyLabel="Copy command"
        copiedLabel="Copied"
        onCopyFailed={onCopyFailed}
      />,
    );
    expect(screen.getByText("curl -fsSL https://portifact.com/install | bash").tagName).toBe(
      "CODE",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(onCopyFailed).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
  });
});

describe("Steps", () => {
  it("marks the current step and says which are done", async () => {
    const { container } = render(
      <Steps
        label="Publishing steps"
        stateLabels={{ done: "done", upcoming: "not started" }}
        steps={[
          { label: "Choose", state: "done" },
          { label: "Review", state: "current" },
          { label: "Publish", state: "upcoming" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Publishing steps" });
    const items = [...list.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual(["Choose, done", "2Review", "3Publish, not started"]);
    expect(list.querySelector('[aria-current="step"]')?.textContent).toBe("2Review");
    expect(await axeViolations(container)).toEqual([]);
  });
});

/** A DataTransfer stand-in with the entries API, as Chromium and Firefox give it. */
function transfer(entries: FileSystemEntry[] | null, files: File[] = []): DataTransfer {
  return {
    types: ["Files"],
    files,
    items: (entries ?? files).map((entry) => ({
      webkitGetAsEntry: entries ? () => entry : undefined,
    })),
  } as unknown as DataTransfer;
}

function fileEntry(fullPath: string, content = "x"): FileSystemEntry {
  const name = fullPath.split("/").at(-1) ?? fullPath;
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    name,
    file: (resolve: (file: File) => void) => resolve(new File([content], name)),
  } as unknown as FileSystemEntry;
}

function folderEntry(fullPath: string, children: FileSystemEntry[]): FileSystemEntry {
  let read = false;
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    name: fullPath.split("/").at(-1),
    createReader: () => ({
      readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
        resolve(read ? [] : children);
        read = true;
      },
    }),
  } as unknown as FileSystemEntry;
}

describe("DropZone", () => {
  it("walks a dropped folder and keeps the paths inside it", async () => {
    const dropped = await readDrop(
      transfer([
        folderEntry("/site", [
          fileEntry("/site/index.html"),
          folderEntry("/site/css", [fileEntry("/site/css/a.css")]),
        ]),
      ]),
    );
    expect(dropped.folder).toBe(true);
    expect(dropped.files.map((entry) => entry.path)).toEqual(["site/index.html", "site/css/a.css"]);
  });

  it("reads loose files, and plain files where the browser has no entries API", async () => {
    const loose = await readDrop(transfer([fileEntry("/a.html"), fileEntry("/b.css")]));
    expect(loose.folder).toBe(false);
    expect(loose.files.map((entry) => entry.path)).toEqual(["a.html", "b.css"]);
    const plain = await readDrop(transfer(null, [new File(["x"], "report.zip")]));
    expect(plain).toMatchObject({ folder: false, files: [{ path: "report.zip" }] });
  });

  it("highlights while files are dragged over it and hands them over on drop", async () => {
    const onDrop = vi.fn();
    const { container } = render(
      <DropZone label="Drag files here" activeLabel="Drop to choose these files" onDrop={onDrop}>
        <button type="button">Choose files</button>
      </DropZone>,
    );
    const zone = screen.getByText("Drag files here").parentElement as HTMLElement;
    const data = transfer([fileEntry("/index.html")]);
    fireEvent.dragEnter(zone, { dataTransfer: data });
    expect(screen.getByText("Drop to choose these files")).toBeTruthy();
    fireEvent.dragOver(zone, { dataTransfer: data });
    fireEvent.dragLeave(zone, { dataTransfer: data });
    expect(screen.getByText("Drag files here")).toBeTruthy();
    fireEvent.dragEnter(zone, { dataTransfer: data });
    fireEvent.drop(zone, { dataTransfer: data });
    await waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onDrop.mock.calls[0]?.[0]).toMatchObject({
      folder: false,
      files: [{ path: "index.html" }],
    });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("ignores drags without files and drops while disabled", () => {
    const onDrop = vi.fn();
    render(
      <DropZone label="Drag here" activeLabel="Drop now" disabled onDrop={onDrop}>
        <span>Pickers</span>
      </DropZone>,
    );
    const zone = screen.getByText("Drag here").parentElement as HTMLElement;
    fireEvent.dragEnter(zone, { dataTransfer: transfer([fileEntry("/a.html")]) });
    fireEvent.drop(zone, { dataTransfer: transfer([fileEntry("/a.html")]) });
    expect(screen.queryByText("Drop now")).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe("variants added with the redesign", () => {
  it("draws loading placeholders hidden from assistive technology", async () => {
    const { container } = render(<LoadingState label="Loading your artifacts" skeleton={3} />);
    expect(screen.getByRole("status").textContent).toBe("Loading your artifacts");
    const placeholders = container.querySelector('[aria-hidden="true"].divide-y');
    expect(placeholders?.children.length).toBe(3);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("leads a dangerous confirmation with a warning icon, hidden from assistive technology", async () => {
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    const { container } = render(
      <ConfirmDialog
        open
        tone="danger"
        title="Delete Plan?"
        confirmLabel="Delete"
        cancelLabel="Keep it"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        It cannot be undone.
      </ConfirmDialog>,
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("offers ghost buttons, subtle badges, success callouts and stacked or unframed lists", async () => {
    expect(buttonClasses({ intent: "ghost" })).toContain("hover:bg-surface-hover");
    const { container } = render(
      <>
        <Badge emphasis="subtle">Public</Badge>
        <Callout tone="success" title="Published version 2" />
        <DetailList layout="stacked" framed={false} items={[{ term: "Type", detail: "Site" }]} />
        <Table caption="Versions" variant="flush">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Version</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell>2</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </>,
    );
    expect(screen.getByText("Public")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Published version 2");
    expect(screen.getByRole("term").textContent).toBe("Type");
    expect(screen.getByRole("table", { name: "Versions" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });
});
