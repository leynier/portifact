// The third code review of pull request #252: its reproductions (F1, F2, F3a, F3b), as written,
// and the rules decided on them.
import { describe, expect, it, vi } from "vitest";
import { check } from "../testing/suggestions/checker.ts";
import { edit, PAGE_URL, plan, planOne } from "../testing/suggestions/harness.ts";
import { planHtml } from "./html-planner.ts";
import * as locate from "./locate.ts";
import { newWork } from "./work.ts";

const page = (base: string) => `<!doctype html><base href="${base}"><p><a href="/pay">Pay</a></p>`;

async function destinationOf(source: string) {
  const built = await plan("html", source, [await edit("html", source, "Pay", "Send")]);
  return [...built.applied, ...built.listed][0]?.destinations[0];
}

describe("third review of #252", () => {
  it("F1: a base a browser ignores falls back to the page's own URL", async () => {
    // HTML ignores a base whose URL is `javascript:` or `data:`, and one that cannot be parsed.
    for (const base of [
      "javascript://evil.example/path",
      "data://evil.example/path",
      "JavaScript://evil.example/",
      "https://[bad",
    ]) {
      expect(await destinationOf(page(base)), base).toMatchObject({
        origin: new URL(PAGE_URL).origin,
        effective: new URL("/pay", PAGE_URL).href,
        resolved: true,
      });
    }
  });

  it("F1: an ordinary base on another host is where the link really goes, and only the first counts", async () => {
    expect(await destinationOf(page("https://other.example/dir/"))).toMatchObject({
      origin: "https://other.example",
      effective: "https://other.example/pay",
      resolved: true,
    });
    // The first base with an href decides, even when a browser ignores its URL: a later one never does.
    const two =
      '<!doctype html><base href="javascript:x"><base href="https://other.example/"><p><a href="/pay">Pay</a></p>';
    expect(await destinationOf(two)).toMatchObject({ origin: new URL(PAGE_URL).origin });
  });

  it("F2: a page over the node budget is never indexed or mapped, whatever else refuses it", async () => {
    const big = `<!doctype html><p>needle</p>${"<b>x</b>".repeat(25_001)}`;
    for (const suffix of [
      "<script></script>",
      "<form></form>",
      "<custom-element></custom-element>",
    ]) {
      const index = vi.spyOn(locate, "PageIndex").mockImplementation((() => {
        throw new Error("the index must not be built");
      }) as never);
      try {
        const work = newWork();
        const planned = planHtml({
          html: big + suffix,
          edits: [{ start: 0, end: 6, before: "needle", after: "fixed" }],
          pageUrl: PAGE_URL,
          work,
        });
        expect(index, suffix).not.toHaveBeenCalled();
        expect(planned.listed[0]?.reason, suffix).toBe("too_large");
        expect(work, suffix).toMatchObject({ parses: 1, indexes: 0, maps: 0 });
      } finally {
        index.mockRestore();
      }
    }
  });

  it("F2: within the budget an ordinary refusal still places its operations", async () => {
    const source = "<!doctype html><p>needle</p><script></script>";
    const work = newWork();
    const planned = await planOne(
      "html",
      source,
      [{ start: 0, end: 6, before: "needle", after: "fixed" }],
      work,
    );
    expect(planned.listed[0]?.reason).toBe("not_eligible");
    expect(work).toMatchObject({ parses: 1, indexes: 1, maps: 1 });
  });

  it("F3a: the checker refuses a Markdown rewrite outside the selected text", async () => {
    const source = "cat &amp; mouse";
    expect(
      await check(
        "markdown",
        source,
        "dog &#38; mouse",
        await edit("markdown", source, "cat", "dog"),
        {
          start: 0,
          end: 9,
          replacement: "dog &#38;",
        },
      ),
    ).not.toBeNull();
    // The plain edit alone passes.
    expect(
      await check(
        "markdown",
        source,
        "dog &amp; mouse",
        await edit("markdown", source, "cat", "dog"),
        {
          start: 0,
          end: 3,
          replacement: "dog",
        },
      ),
    ).toBeNull();
  });

  it("F3b: the checker accepts a correct edit when a style holds text that looks like markup", async () => {
    const source =
      "<!doctype html><html><head><style>/*<b>cat</b>*/</style></head><body><p>cat</p></body></html>";
    const change = await edit("html", source, "cat", "dog");
    const built = await planOne("html", source, [change]);
    expect(built.applied).toHaveLength(1);
    const applied = built.applied[0];
    if (!applied || built.source === undefined) throw new Error("not applied");
    expect(await check("html", source, built.source, change, applied)).toBeNull();
  });
});
