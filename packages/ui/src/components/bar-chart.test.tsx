// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { BarChart, type BarChartDatum } from "./bar-chart.tsx";

afterEach(cleanup);

const data: BarChartDatum[] = [
  { key: "2026-11-06", label: "6 Nov", value: 2, description: "6 Nov: 2 views" },
  { key: "2026-11-07", label: "7 Nov", value: 0, description: "7 Nov: no views" },
  { key: "2026-11-08", label: "8 Nov", value: 8, description: "8 Nov: 8 views" },
];

function chart(items = data) {
  return render(
    <BarChart
      label="Views per day"
      summary="10 views in 3 days, most on 8 Nov"
      data={items}
      keyboardHint="Use the arrow keys to pick a day"
    />,
  );
}

const plot = () => screen.getByRole("group", { name: "Views per day" });
const described = () =>
  (plot().getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" | ");

describe("BarChart", () => {
  it("is one named, focusable group described by its summary, the selected bar and the hint", async () => {
    const { container } = chart();
    expect(plot().tabIndex).toBe(0);
    expect(described()).toBe(
      "10 views in 3 days, most on 8 Nov | 8 Nov: 8 views | Use the arrow keys to pick a day",
    );
    // The drawing itself is hidden: the words and the screen's table carry the numbers.
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("moves the selection with the arrow keys, Home and End, and stops at the ends", () => {
    chart();
    const current = () => screen.getByText(/views$/, { selector: "[aria-live]" }).textContent;
    fireEvent.keyDown(plot(), { key: "ArrowLeft" });
    expect(current()).toBe("7 Nov: no views");
    fireEvent.keyDown(plot(), { key: "Home" });
    expect(current()).toBe("6 Nov: 2 views");
    fireEvent.keyDown(plot(), { key: "ArrowLeft" });
    expect(current()).toBe("6 Nov: 2 views");
    fireEvent.keyDown(plot(), { key: "End" });
    expect(current()).toBe("8 Nov: 8 views");
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(current()).toBe("8 Nov: 8 views");
    fireEvent.keyDown(plot(), { key: "a" });
    expect(current()).toBe("8 Nov: 8 views");
  });

  it("marks the selected bar with a tick, not only a color, and selects on pointer", () => {
    const { container } = chart();
    const bars = container.querySelectorAll("g");
    expect(bars).toHaveLength(3);
    expect(bars[2]?.getAttribute("data-selected")).toBe("true");
    expect(bars[2]?.querySelectorAll("rect")).toHaveLength(3);
    fireEvent.click(bars[0] as Element);
    expect(bars[0]?.getAttribute("data-selected")).toBe("true");
    expect(bars[0]?.querySelectorAll("rect")).toHaveLength(3);
    fireEvent.pointerEnter(bars[1] as Element);
    expect(screen.getByText("7 Nov: no views")).toBeTruthy();
  });

  it("scales bars to the highest value and labels the axis ends", () => {
    const { container } = chart();
    const heights = [...container.querySelectorAll("g")].map((g) =>
      g.querySelectorAll("rect")[1]?.getAttribute("height"),
    );
    expect(heights).toEqual(["25", "0", "100"]);
    expect(container.textContent).toContain("6 Nov");
    expect(container.textContent).toContain("8 Nov");
  });

  it("draws an empty series without failing", () => {
    const { container } = chart([]);
    expect(container.querySelectorAll("g")).toHaveLength(0);
    expect(plot()).toBeTruthy();
  });
});
