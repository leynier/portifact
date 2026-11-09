// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { Badge } from "./badge.tsx";
import { Button, buttonClasses } from "./button.tsx";
import { Callout } from "./callout.tsx";
import { DetailList } from "./detail-list.tsx";
import { Disclosure } from "./disclosure.tsx";
import { EmptyState } from "./empty-state.tsx";
import { LiveRegion } from "./live-region.tsx";
import { LoadingState } from "./loading-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "./table.tsx";

afterEach(cleanup);

const Icon = () => <svg data-testid="icon" />;

describe("Button", () => {
  it("is a button named by its label that runs its action", () => {
    const onClick = vi.fn();
    render(
      <Button icon={<Icon />} onClick={onClick}>
        Archive
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Archive" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("icon").parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is disabled and marked busy while its action runs", () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Restore
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Restore" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps a submit type when asked and has no busy state otherwise", () => {
    render(<Button type="submit">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("gives links the same look as each button variant", () => {
    expect(buttonClasses({ intent: "primary" })).toContain("bg-surface-inverse");
    expect(buttonClasses({ intent: "link", size: "inline" })).toContain("underline");
    expect(buttonClasses()).toContain("border-border-strong");
  });

  it("draws a destructive secondary action without a hue, and stays accessible", async () => {
    const { container } = render(
      <Button intent="danger" size="sm" icon={<Icon />}>
        Disconnect
      </Button>,
    );
    expect(buttonClasses({ intent: "danger" })).toContain("border-dashed");
    expect(buttonClasses({ intent: "danger" })).toContain("hover:bg-surface-inverse");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDefined();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("Badge", () => {
  it("always shows a text label and hides its icon from assistive technology", () => {
    render(
      <Badge emphasis="strong" icon={<Icon />}>
        Archived
      </Badge>,
    );
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByTestId("icon").parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders without an icon", () => {
    const { container } = render(<Badge>Active</Badge>);
    expect(container.textContent).toBe("Active");
    expect(container.querySelector("[aria-hidden]")).toBeNull();
  });
});

describe("Callout", () => {
  it("announces errors as alerts with their details and action", () => {
    render(
      <Callout tone="error" title="Could not load" icon={<Icon />} action={<Button>Retry</Button>}>
        Check your connection.
      </Callout>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not load");
    expect(alert.textContent).toContain("Check your connection.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("announces other messages politely", () => {
    render(<Callout title="Saved" />);
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });
});

describe("states", () => {
  it("shows an empty state with a heading at the requested level", () => {
    render(
      <EmptyState
        title="No artifacts yet"
        icon={<Icon />}
        headingLevel={3}
        action={<a href="/x">Learn</a>}
      >
        Publish one.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "No artifacts yet" })).toBeTruthy();
    expect(screen.getByText("Publish one.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Learn" })).toBeTruthy();
  });

  it("defaults the empty state heading to level 2 without extras", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole("heading", { level: 2, name: "Nothing here" })).toBeTruthy();
    expect(container.querySelectorAll("div")).toHaveLength(0);
  });

  it("tells in words what is loading", () => {
    render(<LoadingState label="Loading artifacts" />);
    expect(screen.getByRole("status").textContent).toBe("Loading artifacts");
  });

  it("announces action results politely without showing them", () => {
    render(<LiveRegion message="Artifact archived" />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("Artifact archived");
  });
});

describe("DetailList and Table", () => {
  it("pairs each term with its detail", () => {
    render(
      <DetailList
        items={[
          { term: "State", detail: "Active" },
          { term: "Expires", detail: "December 8, 2026" },
        ]}
      />,
    );
    const terms = screen.getAllByRole("term").map((node) => node.textContent);
    const details = screen.getAllByRole("definition").map((node) => node.textContent);
    expect(terms).toEqual(["State", "Expires"]);
    expect(details).toEqual(["Active", "December 8, 2026"]);
  });

  it("names the table and its keyboard-scrollable region by the caption", () => {
    render(
      <Table caption="Your artifacts">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>Plan</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("table", { name: "Your artifacts" })).toBeTruthy();
    const region = screen.getByRole("region", { name: "Your artifacts" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("columnheader", { name: "Name" }).getAttribute("scope")).toBe("col");
  });

  it("can show the caption to everyone", () => {
    const { container } = render(
      <Table caption="Versions" captionVisible>
        <TableBody>
          <TableRow>
            <TableCell>1</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(container.querySelector("caption")?.className).not.toContain("sr-only");
  });
});

describe("accessibility", () => {
  it("has no axe violations across components and states", async () => {
    const { container } = render(
      <div>
        <h1>Components</h1>
        <Button icon={<Icon />}>Archive</Button>
        <Button busy>Restore</Button>
        <Button intent="link" size="inline">
          Load more
        </Button>
        <Badge icon={<Icon />}>Active</Badge>
        <Callout tone="error" title="Could not load" action={<Button>Retry</Button>}>
          Try again.
        </Callout>
        <EmptyState title="No artifacts yet">Publish one.</EmptyState>
        <LoadingState label="Loading" />
        <LiveRegion message="Done" />
        <DetailList items={[{ term: "State", detail: "Active" }]} />
        <Table caption="Artifacts">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell>Plan</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("Disclosure", () => {
  it("hides its content until the summary opens it, and reports each change", async () => {
    const onToggle = vi.fn();
    const { container } = render(
      <Disclosure summary="Version 2: 3 threads" onToggle={onToggle}>
        <p>Thread 1</p>
      </Disclosure>,
    );
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = screen.getByText("Version 2: 3 threads").closest("summary") as HTMLElement;
    expect(details.open).toBe(false);
    expect(summary.parentElement).toBe(details);
    expect(summary.querySelector("[aria-hidden='true'] svg")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Thread 1")).toBeDefined();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("can start open", () => {
    const { container } = render(
      <Disclosure summary="Details" defaultOpen>
        <p>Shown</p>
      </Disclosure>,
    );
    expect((container.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("has an inline look for cards, named by its label when the summary repeats", async () => {
    const onToggle = vi.fn();
    const { container } = render(
      <ul>
        <li>
          <Disclosure
            appearance="inline"
            summary="Details"
            label="Details of Claude"
            onToggle={onToggle}
          >
            <p>Read your artifacts</p>
          </Disclosure>
        </li>
        <li>
          <Disclosure appearance="inline" summary="Details" label="Details of Codex">
            <p>Publish</p>
          </Disclosure>
        </li>
      </ul>,
    );
    const summaries = [...container.querySelectorAll("summary")];
    expect(summaries.map((summary) => summary.getAttribute("aria-label"))).toEqual([
      "Details of Claude",
      "Details of Codex",
    ]);
    expect(summaries.map((summary) => summary.textContent)).toEqual(["Details", "Details"]);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.className).not.toContain("border");
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(await axeViolations(container)).toEqual([]);
  });
});
