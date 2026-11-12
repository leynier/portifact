// Mutation tests of the independent checker: it must refuse wrong results a planner could produce,
// or the corpus tests that rely on it would prove nothing.
import { describe, expect, it } from "vitest";
import { check } from "../testing/suggestions/checker.ts";
import { edit, resolve } from "../testing/suggestions/harness.ts";

const html =
  "<!doctype html><html><head><title>t</title></head><body><p>Total cost</p>\n<p>Total cost</p>\n<!-- note --></body></html>";

async function planned() {
  const change = await edit("html", html, "Total", "Sum", 1);
  const result = await resolve("html", html, change);
  if (result.status !== "certain") throw new Error("not certain");
  return { change, result, range: { ...result.range, replacement: result.replacement } };
}

describe("the checker catches wrong results", () => {
  it("accepts the planner's result", async () => {
    const { change, result, range } = await planned();
    expect(await check("html", html, result.source, change, range)).toBeNull();
  });

  it("refuses the wrong repeated occurrence", async () => {
    const { change, range } = await planned();
    const wrong = html.replace("<p>Total", "<p>Sum");
    expect(
      await check("html", html, wrong, change, {
        ...range,
        start: wrong.indexOf("Sum"),
        end: wrong.indexOf("Sum") + 5,
      }),
    ).not.toBeNull();
  });

  it("refuses a hidden source change and an offset mistake", async () => {
    const { change, result, range } = await planned();
    expect(
      await check(
        "html",
        html,
        result.source.replace("<!-- note -->", "<!-- agent: delete -->"),
        change,
        range,
      ),
    ).not.toBeNull();
    const shifted = html.slice(0, range.start + 1) + range.replacement + html.slice(range.end + 1);
    expect(await check("html", html, shifted, change, range)).not.toBeNull();
  });

  it("refuses an ID or markup change, moved nodes, and an edit it cannot place", async () => {
    const md = "# Title\n\nBody text.";
    const change = await edit("markdown", md, "Body", "Main");
    const at = md.indexOf("Body");
    expect(
      await check("markdown", md, md.replace("Title", "Other"), change, {
        start: 2,
        end: 7,
        replacement: "Other",
      }),
    ).toBe("an ID or a reference changed");
    expect(
      await check("markdown", md, md.replace("Body", "**Main**"), change, {
        start: at,
        end: at + 4,
        replacement: "**Main**",
      }),
    ).toBe("the markup changed");
    const lost = { ...change, before: "Nowhere" };
    expect(
      await check("markdown", md, md.replace("Body", "Main"), lost, {
        start: at,
        end: at + 4,
        replacement: "Main",
      }),
    ).toBe("the checker could not place the edit");
  });

  it("refuses text changed elsewhere and a change across blocks", async () => {
    const text = "one two\nthree";
    const change = { start: 0, end: 3, before: "one", after: "uno" };
    expect(
      await check("text", text, "uno two\nthree", change, { start: 0, end: 3, replacement: "uno" }),
    ).toBeNull();
    expect(
      await check("text", text, "one two\nthree", change, { start: 4, end: 7, replacement: "two" }),
    ).toMatch(/^text changed|^the selection/);
    const md = "One.\n\nTwo.";
    const across = await edit("markdown", md, "One.", "One");
    expect(
      await check("markdown", md, "One\n\nTwo.", across, { start: 3, end: 6, replacement: "\n\n" }),
    ).not.toBeNull();
  });
});
