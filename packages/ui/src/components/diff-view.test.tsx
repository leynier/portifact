// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { DiffView, type DiffViewHunk, type DiffViewLabels } from "./diff-view.tsx";

afterEach(cleanup);

const labels: DiffViewLabels = {
  before: "Before",
  after: "After",
  change: "Change",
  text: "Text",
  added: "Added",
  removed: "Removed",
  unchanged: "Unchanged",
  noNewline: "no line break at the end",
  hunk: (hunk) => `Lines ${hunk.beforeStart} and ${hunk.afterStart}`,
};

const hunks: DiffViewHunk[] = [
  {
    beforeStart: 1,
    beforeLines: 3,
    afterStart: 1,
    afterLines: 2,
    lines: [
      { type: "removed", text: "one", before: 1, after: null, noNewline: false },
      { type: "removed", text: "two", before: 2, after: null, noNewline: false },
      { type: "added", text: "uno", before: null, after: 1, noNewline: false },
      { type: "context", text: "three", before: 3, after: 2, noNewline: true },
    ],
  },
];

describe("DiffView", () => {
  it("names every line's change in text in the unified layout, never by color alone", async () => {
    const { container } = render(
      <DiffView caption="Changes to index.md" hunks={hunks} layout="unified" labels={labels} />,
    );
    const region = screen.getByRole("region", { name: "Changes to index.md" });
    expect(region.tabIndex).toBe(0);
    const table = within(region).getByRole("table", { name: "Changes to index.md" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Before", "After", "Change", "Text"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]?.textContent).toBe("Lines 1 and 1");
    expect(rows[1]?.textContent).toBe("1-RemovedRemoved: one");
    expect(rows[3]?.textContent).toBe("1+AddedAdded: uno");
    expect(rows[4]?.textContent).toBe("32 Unchangedthree(no line break at the end)");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("pairs removed and added lines side by side, padding the shorter side", async () => {
    const { container } = render(
      <DiffView caption="Changes" hunks={hunks} layout="split" labels={labels} />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Lines 1 and 1",
      "1-Removed: one1+Added: uno",
      "2-Removed: two",
      "3three(no line break at the end)2three(no line break at the end)",
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });
});
