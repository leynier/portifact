// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { RegionSelector, type RegionSelectorProps } from "./region-selector.tsx";

afterEach(cleanup);

function setup(overrides: Partial<RegionSelectorProps> = {}) {
  const props: RegionSelectorProps = {
    box: { x: 40, y: 60, width: 400, height: 200 },
    region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    label: "Region of the image",
    instructions: "Drag to draw. Arrow keys move, Shift with arrows resizes.",
    status: "From 25% to 75% across, 25% to 75% down.",
    onDraw: vi.fn(),
    onKey: vi.fn(() => true),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const view = render(<RegionSelector {...props} />);
  const surface = screen.getByRole("group", { name: "Region of the image" });
  return { props, view, surface };
}

describe("RegionSelector", () => {
  it("covers the image's box, draws the rectangle in percentages and takes focus", () => {
    const { surface } = setup();
    expect(surface.style.transform).toBe("translate(40px, 60px)");
    expect(surface.style.width).toBe("400px");
    expect(surface.style.height).toBe("200px");
    const mark = surface.querySelector<HTMLElement>("[aria-hidden]");
    expect(mark?.style.left).toBe("25%");
    expect(mark?.style.width).toBe("50%");
    expect(document.activeElement).toBe(surface);
  });

  it("describes itself and announces the rectangle politely", () => {
    const { surface } = setup();
    const described = (surface.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual([
      "Drag to draw. Arrow keys move, Shift with arrows resizes.",
      "From 25% to 75% across, 25% to 75% down.",
    ]);
    expect(screen.getByText(/From 25%/).getAttribute("aria-live")).toBe("polite");
  });

  it("passes keys on, and confirms with Enter and cancels with Escape", () => {
    const { props, surface } = setup();
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    fireEvent.keyDown(surface, { key: "ArrowDown", shiftKey: true });
    expect(props.onKey).toHaveBeenNthCalledWith(1, "ArrowRight", false);
    expect(props.onKey).toHaveBeenNthCalledWith(2, "ArrowDown", true);
    // Browser and system shortcuts are left alone.
    fireEvent.keyDown(surface, { key: "ArrowLeft", ctrlKey: true });
    expect(props.onKey).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("reports a drag in the box's pixels, and ignores a click without one", () => {
    const { props, surface } = setup();
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 400, 200));
    fireEvent.pointerDown(surface, { button: 0, clientX: 110, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 111, clientY: 60, pointerId: 1 });
    expect(props.onDraw).not.toHaveBeenCalled();
    fireEvent.pointerDown(surface, { button: 0, clientX: 110, clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 300, clientY: 150, pointerId: 1 });
    expect(props.onDraw).toHaveBeenNthCalledWith(1, { x: 10, y: 10 }, { x: 100, y: 50 });
    expect(props.onDraw).toHaveBeenNthCalledWith(2, { x: 10, y: 10 }, { x: 200, y: 100 });
    // Moving without a pressed button draws nothing.
    fireEvent.pointerMove(surface, { clientX: 250, clientY: 120, pointerId: 1 });
    expect(props.onDraw).toHaveBeenCalledTimes(2);
  });

  it("has no accessibility violations", async () => {
    const { view } = setup();
    expect(await axeViolations(view.container)).toEqual([]);
  });
});
