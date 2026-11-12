// Finding 15: one operation must not render the document more than the plan's budget.
import { describe, expect, it, vi } from "vitest";

const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@portifact/render", async (original) => {
  const actual = await original<typeof import("@portifact/render")>();
  return {
    ...actual,
    renderMarkdown: (...args: Parameters<typeof actual.renderMarkdown>) => {
      renders.count++;
      return actual.renderMarkdown(...args);
    },
  };
});

const { renderPage, resolveMarkdownEdit } = await import("../src/markdown-resolver.ts");

describe("finding 15: renders are budgeted", () => {
  it("renders at most four times for the review's counterexample", () => {
    const source = `${"a".repeat(40)} needle ${"z".repeat(40)}`;
    const text = renderPage(source).text;
    const start = text.indexOf("needle");
    renders.count = 0;
    resolveMarkdownEdit(source, { start, end: start + 6, before: "needle", after: " " });
    expect(renders.count).toBeLessThanOrEqual(4);
  });
});
