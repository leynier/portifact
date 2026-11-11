// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { CodeSample } from "./code-sample.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("CodeSample", () => {
  it("is a named, focusable region holding the code as text, axe clean in both themes", async () => {
    const code = 'const ok = verify(secret, headers, body);\n// <script>alert("never")</script>';
    const { container } = render(<CodeSample label="Signature check" code={code} />);
    const region = screen.getByRole("region", { name: "Signature check" });
    expect(region.tabIndex).toBe(0);
    expect(region.querySelector("code")?.textContent).toBe(code);
    // Text, never markup.
    expect(region.querySelector("script")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
    document.documentElement.dataset.theme = "dark";
    expect(await axeViolations(container)).toEqual([]);
  });
});
