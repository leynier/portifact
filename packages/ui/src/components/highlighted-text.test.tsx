// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { HighlightedText, highlightParts } from "./highlighted-text.tsx";

afterEach(cleanup);

describe("HighlightedText", () => {
  it("marks the ranges and keeps the rest as text", async () => {
    const { container } = render(
      <p>
        <HighlightedText text="The quarterly roadmap" ranges={[[4, 13]]} />
      </p>,
    );
    expect(container.textContent).toBe("The quarterly roadmap");
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "quarterly",
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("renders hostile text as text", () => {
    const text = '<img src=x onerror="alert(1)">';
    const { container } = render(<HighlightedText text={text} ranges={[[0, 4]]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it("orders ranges and drops empty, overlapping and out-of-range ones", () => {
    expect(
      highlightParts("abcdef", [
        [4, 5],
        [0, 2],
        [1, 3],
        [3, 3],
        [5, 99],
      ]),
    ).toEqual([
      { text: "ab", marked: true },
      { text: "cd", marked: false },
      { text: "e", marked: true },
      { text: "f", marked: false },
    ]);
    expect(highlightParts("", [])).toEqual([]);
  });
});
