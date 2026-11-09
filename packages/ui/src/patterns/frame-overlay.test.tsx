// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../components/button.tsx";
import { axeViolations } from "../testing/axe.ts";
import { Floating, FloatingPanel, FrameOverlay } from "./frame-overlay.tsx";

const LAYOUT = { clientWidth: 800, clientHeight: 600, offsetWidth: 100, offsetHeight: 32 };

beforeEach(() => {
  for (const [name, value] of Object.entries(LAYOUT)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
});

afterEach(() => {
  cleanup();
  for (const name of Object.keys(LAYOUT)) Reflect.deleteProperty(HTMLElement.prototype, name);
});

const wrapperOf = (element: HTMLElement) => element.closest<HTMLElement>("[style]");

describe("FrameOverlay and Floating", () => {
  it("places content where `place` says, given its size and the frame's", () => {
    const place = vi.fn(() => ({ x: 40, y: 72 }));
    const onPlaced = vi.fn();
    render(
      <FrameOverlay
        layer={
          <Floating place={place} onPlaced={onPlaced}>
            <Button intent="floating" size="sm">
              Comment
            </Button>
          </Floating>
        }
      >
        <iframe title="Artifact" src="about:blank" />
      </FrameOverlay>,
    );
    const wrapper = wrapperOf(screen.getByRole("button", { name: "Comment" }));
    expect(place).toHaveBeenCalledWith({ width: 100, height: 32 }, { width: 800, height: 600 });
    expect(wrapper?.style.transform).toBe("translate(40px, 72px)");
    expect(wrapper?.style.visibility).toBe("visible");
    expect(onPlaced).toHaveBeenCalledWith(true);
    expect(screen.getByTitle("Artifact")).toBeTruthy();
  });

  it("hides content that cannot be placed, and says so once", () => {
    const onPlaced = vi.fn();
    const view = (x: number | null) => (
      <FrameOverlay
        layer={
          <Floating place={() => (x === null ? null : { x, y: 0 })} onPlaced={onPlaced}>
            <Button>Comment</Button>
          </Floating>
        }
      >
        <iframe title="Artifact" src="about:blank" />
      </FrameOverlay>
    );
    const { rerender } = render(view(null));
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    rerender(view(null));
    expect(onPlaced.mock.calls).toEqual([[false]]);
    rerender(view(5));
    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
    expect(onPlaced.mock.calls).toEqual([[false], [true]]);
  });

  it("follows the frame's size", () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    let width = 30;
    render(
      <FrameOverlay
        layer={
          <Floating place={() => ({ x: width, y: 0 })}>
            <Button>Comment</Button>
          </Floating>
        }
      >
        <iframe title="Artifact" src="about:blank" />
      </FrameOverlay>,
    );
    width = 60;
    act(() => {
      for (const observer of observers) observer();
    });
    expect(wrapperOf(screen.getByRole("button", { name: "Comment" }))?.style.transform).toBe(
      "translate(60px, 0px)",
    );
    vi.unstubAllGlobals();
  });

  it("shows a sheet without placing it, keeping its content", () => {
    const place = vi.fn(() => null);
    const view = (sheet: boolean) => (
      <FrameOverlay
        layer={
          <Floating place={place} sheet={sheet}>
            <FloatingPanel label="Comment on the selection" sheet={sheet}>
              <textarea aria-label="Comment" />
            </FloatingPanel>
          </Floating>
        }
      >
        <iframe title="Artifact" src="about:blank" />
      </FrameOverlay>
    );
    const { rerender } = render(view(false));
    expect(screen.queryByRole("region", { name: "Comment on the selection" })).toBeNull();
    const box = screen.getByLabelText("Comment") as HTMLTextAreaElement;
    box.value = "kept";
    place.mockClear();
    rerender(view(true));
    const region = screen.getByRole("region", { name: "Comment on the selection" });
    expect(wrapperOf(region)?.style.transform).toBe("");
    expect(place).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("kept");
  });

  it("renders the frame alone without a layer, and has no axe violations", async () => {
    const { container } = render(
      <FrameOverlay
        layer={
          <Floating place={() => ({ x: 0, y: 0 })}>
            <FloatingPanel label="Comment on the selection">
              <label>
                Comment
                <textarea />
              </label>
            </FloatingPanel>
          </Floating>
        }
      >
        <iframe title="Artifact" src="about:blank" />
      </FrameOverlay>,
    );
    expect(await axeViolations(container)).toEqual([]);
    cleanup();
    const alone = render(
      <FrameOverlay>
        <iframe title="Artifact" src="about:blank" />
      </FrameOverlay>,
    );
    expect(alone.container.querySelectorAll("div")).toHaveLength(1);
  });
});
