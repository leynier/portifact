// The production preview builder with style operations (`previewOfEdit` in
// `@portifact/domain/suggestions`, decision 0027 delivery 3) in a real engine: every allowed value
// of every property of the allowlist sets exactly that declaration on the picked element of the
// built copy, the page's own rules do not hide it, and the framed preview makes no request. CI
// runs this file in the e2e jobs' Chromium and Firefox.

import { expect, test } from "@playwright/test";
import { type EditOperation, STYLE_PROPERTY_NAMES } from "@portifact/contracts";
import { previewOfEdit } from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";

/** Allowed values and what the engine computes for them, one or more per property. */
const SAMPLES: Record<string, [value: string, computed: string][]> = {
  color: [
    ["#abc", "rgb(170, 187, 204)"],
    ["rgb(1, 2, 3)", "rgb(1, 2, 3)"],
    ["navy", "rgb(0, 0, 128)"],
  ],
  "background-color": [["#102030", "rgb(16, 32, 48)"]],
  "font-size": [["96px", "96px"]],
  "font-weight": [["900", "900"]],
  "font-style": [["italic", "italic"]],
  "text-align": [["center", "center"]],
  "text-decoration-line": [["line-through", "line-through"]],
  "text-transform": [["uppercase", "uppercase"]],
  "letter-spacing": [["10px", "10px"]],
  "border-radius": [["64px", "64px"]],
};

// The page's own rules try to win; the preview writes the change so they cannot hide it.
const PAGE = `<!doctype html><html><head><style>p{color:red!important;font-size:12px!important;text-align:left!important;background:url(https://example.invalid/bg.png)}</style></head><body><p>Text</p><span>Other</span></body></html>`;

const styleOf = (property: string, value: string): EditOperation => ({
  kind: "style",
  target: {
    schema: 1,
    path: "index.html",
    anchor: { kind: "element", selectors: ["body > p"], tagName: "p", fingerprint: "Text" },
  },
  changes: [{ property, before: null, after: value }],
});

test("the samples cover every property of the allowlist", () => {
  expect(Object.keys(SAMPLES).sort()).toEqual([...STYLE_PROPERTY_NAMES].sort());
});

for (const [property, values] of Object.entries(SAMPLES)) {
  for (const [value, computed] of values) {
    test(`a built preview sets ${property}: ${value} and loads nothing`, async ({ page }) => {
      const built = previewOfEdit({
        kind: "html",
        base: PAGE,
        shown: PAGE,
        operations: [styleOf(property, value)],
        renderer: DOCUMENT_RENDERER,
      });
      expect(built.state).toBe("ready");
      if (built.state !== "ready") return;
      const requests: string[] = [];
      await page.setContent('<iframe sandbox=""></iframe>');
      // Recorded where a request reaches the network: one the preview's policy refuses never
      // does (Chromium still reports those as request events).
      await page.route("**/*", (route) => {
        requests.push(route.request().url());
        return route.abort();
      });
      await page.locator("iframe").evaluate((frame, html) => {
        (frame as HTMLIFrameElement).srcdoc = html;
      }, built.document);
      await expect.poll(() => page.frames().length).toBe(2);
      const frame = page.frames()[1];
      if (!frame) throw new Error("no frame");
      await frame.waitForSelector("p");
      const seen = await frame.evaluate((name) => {
        const p = document.querySelector("p") as HTMLElement;
        const span = document.querySelector("span") as HTMLElement;
        return {
          value: getComputedStyle(p).getPropertyValue(name),
          declarations: p.style.length,
          other: span.getAttribute("style"),
        };
      }, property);
      expect(seen.value).toBe(computed);
      // One declaration, only on the picked element (the `border-radius` shorthand is four
      // longhands in the engine's declaration list).
      expect(seen.declarations).toBe(property === "border-radius" ? 4 : 1);
      expect(seen.other).toBeNull();
      // The page's background image is refused by the preview's policy: nothing left the frame.
      await page.waitForTimeout(100);
      expect(requests.filter((url) => !url.startsWith("about:"))).toEqual([]);
    });
  }
}
