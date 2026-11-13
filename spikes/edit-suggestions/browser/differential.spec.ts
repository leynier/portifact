// Parse5 (the production parser) against Chromium and Firefox for the contexts finding 3 of the
// second review measured. That a built preview loads nothing in an empty-sandbox frame is now
// proven on the real preview host in every e2e project (e2e/tests/suggestion-previews.spec.ts).
import { expect, test } from "@playwright/test";
import { childrenOf, find, isElement, isText, type P5Node, parseHtml } from "../src/html-dom.ts";
import { subsetRefusal } from "../src/html-subset.ts";
import { pageText, parseDocument } from "../src/page.ts";

const CASES = [
  "<p>plain &amp; text</p>",
  "<xmp><b>x</b> &amp; y</xmp>",
  "<plaintext><b>x</b> & y",
  "<textarea><b>x</b> &amp; y</textarea>",
  '<div><template shadowrootmode="open"><p>shadow</p></template><p>light</p></div>',
  "<svg><text>svg &amp; text</text></svg><p>after</p>",
  "<math><mi>m</mi></math><p>after</p>",
  "<noscript><p>no script</p></noscript>",
  "<p>a<table><tr><td>cell</td></tr></table>b</p>",
];

/**
 * The body's light-DOM text nodes as parse5 builds them (scripting enabled, as browsers parse).
 * Template contents and declarative shadow roots are not light DOM; the subset refuses them.
 */
function parse5Texts(body: string): string[] {
  const document = parseHtml(
    `<!doctype html><html><head></head><body>${body}</body></html>`,
  ).document;
  const found: string[] = [];
  const visit = (node: P5Node) => {
    for (const child of childrenOf(node)) {
      if (isText(child)) found.push(child.value);
      else if (!(isElement(child) && child.tagName === "template")) visit(child);
    }
  };
  const bodyNode = find(document, "body");
  if (bodyNode) visit(bodyNode);
  return found;
}

for (const body of CASES) {
  test(`parse5 reads ${JSON.stringify(body)} as the browser does`, async ({ page }) => {
    await page.setContent(`<!doctype html><html><head></head><body>${body}</body></html>`);
    const browser = await page.evaluate(() => {
      const found: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        found.push((node as Text).data);
      return found;
    });
    expect(parse5Texts(body)).toEqual(browser);
  });
}

test("happy-dom differs from the browser where the subset refuses the context", () => {
  // Recorded, not asserted per engine: the spike's earlier oracle used happy-dom and missed these.
  const refused = CASES.filter(
    (body) =>
      subsetRefusal(
        `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`,
        parseHtml(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`),
      ) !== null,
  );
  expect(refused.length).toBeGreaterThanOrEqual(7);
  expect(pageText(parseDocument("<!doctype html><body><p>x</p>").body)).toBe("x");
});
