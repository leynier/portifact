// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TIMING,
  setupTypewriter,
  type TypewriterTiming,
  typewriterSteps,
} from "./typewriter.ts";

const timing: TypewriterTiming = { typeMs: 1, deleteMs: 2, holdMs: 30, betweenMs: 5 };

function markup(phrases: string[]): string {
  const ghosts = phrases
    .map((phrase) => `<span data-typewriter-phrase>${phrase}<span></span></span>`)
    .join("");
  return `<h1><span data-typewriter>${ghosts}<span><span data-typewriter-text>${phrases[0] ?? ""}</span><span data-typewriter-caret></span></span></span></h1>`;
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`${selector} not rendered`);
  return found;
}

/** A wait that records each delay and the text on screen when it was requested. */
function recorder(): { wait: (ms: number) => Promise<void>; delays: number[]; seen: string[] } {
  const delays: number[] = [];
  const seen: string[] = [];
  return {
    delays,
    seen,
    wait: async (ms) => {
      delays.push(ms);
      seen.push(element("[data-typewriter-text]").textContent ?? "");
    },
  };
}

describe("typewriterSteps", () => {
  it("deletes the current phrase, types the next and comes back to the first", () => {
    const texts = typewriterSteps(["ab", "xyz"], timing).map((step) => step.text);
    expect(texts).toEqual(["a", "", "x", "xy", "xyz", "xy", "x", "", "a", "ab"]);
  });

  it("holds a complete phrase, pauses on the empty line and paces each keystroke", () => {
    const delays = typewriterSteps(["ab", "xyz"], timing).map((step) => step.delay);
    expect(delays).toEqual([30, 2, 5, 1, 1, 30, 2, 2, 5, 1]);
  });

  it("visits every phrase in order and ends on the first one", () => {
    const steps = typewriterSteps(["one", "two", "three"]);
    const complete = steps
      .map((step) => step.text)
      .filter((text) => ["one", "two", "three"].includes(text));
    expect(complete).toEqual(["two", "three", "one"]);
    expect(steps.at(-1)?.text).toBe("one");
  });

  it("returns no steps when there is nothing to cycle through", () => {
    expect(typewriterSteps([])).toEqual([]);
    expect(typewriterSteps(["only"])).toEqual([]);
  });

  it("uses a readable default pace", () => {
    expect(DEFAULT_TIMING.typeMs).toBeGreaterThan(DEFAULT_TIMING.deleteMs);
    expect(DEFAULT_TIMING.holdMs).toBeGreaterThanOrEqual(2000);
  });
});

describe("setupTypewriter", () => {
  beforeEach(() => {
    document.body.innerHTML = markup(["Get feedback", "Stay private"]);
  });

  it("plays one pass, settles on the first phrase and stops the caret", async () => {
    const { wait, seen } = recorder();
    await expect(setupTypewriter(document, { reducedMotion: false, timing, wait })).resolves.toBe(
      true,
    );
    expect(seen).toContain("Stay private");
    expect(seen).toContain("");
    expect(element("[data-typewriter-text]").textContent).toBe("Get feedback");
    expect(element("[data-typewriter-caret]").hasAttribute("data-settled")).toBe(true);
  });

  it("waits the given timing between frames", async () => {
    const { wait, delays } = recorder();
    await setupTypewriter(document, { reducedMotion: false, timing, wait });
    expect(delays).toEqual(
      typewriterSteps(["Get feedback", "Stay private"], timing).map((step) => step.delay),
    );
  });

  it("keeps the first phrase still when the visitor prefers reduced motion", async () => {
    const { wait, delays } = recorder();
    await expect(setupTypewriter(document, { reducedMotion: true, timing, wait })).resolves.toBe(
      false,
    );
    expect(delays).toEqual([]);
    expect(element("[data-typewriter-text]").textContent).toBe("Get feedback");
    expect(element("[data-typewriter-caret]").hasAttribute("data-settled")).toBe(false);
  });

  it("does nothing without the markup or with a single phrase", async () => {
    const { wait, delays } = recorder();
    document.body.innerHTML = "<h1>Static</h1>";
    await expect(setupTypewriter(document, { reducedMotion: false, wait })).resolves.toBe(false);
    document.body.innerHTML = markup(["Only one", "   "]);
    await expect(setupTypewriter(document, { reducedMotion: false, wait })).resolves.toBe(false);
    expect(delays).toEqual([]);
  });

  it("waits on real timers by default", async () => {
    document.body.innerHTML = markup(["a", "b"]);
    const zero: TypewriterTiming = { typeMs: 0, deleteMs: 0, holdMs: 0, betweenMs: 0 };
    await expect(setupTypewriter(document, { reducedMotion: false, timing: zero })).resolves.toBe(
      true,
    );
    expect(element("[data-typewriter-text]").textContent).toBe("a");
  });
});
