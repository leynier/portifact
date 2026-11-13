// The production preview builder (`buildPreview` in `@portifact/domain/suggestions`) in a real
// engine: author CSS cannot animate a built preview, however its motion properties are written
// (escaped, longhand, prefixed, nested, inline, `!important`). Second review of pull request #252,
// R4. CI runs this file in the e2e jobs' Chromium and Firefox.

import { expect, test } from "@playwright/test";
import { buildPreview } from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";

const KEYFRAMES = "@keyframes spin{from{opacity:1}to{opacity:0}}";
const CASES: Record<string, { head: string; body: string }> = {
  "a plain shorthand": { head: `p{animation:spin 1s infinite!important}`, body: "<p>x</p>" },
  "an escaped shorthand": {
    head: String.raw`p{\61 nimation:spin 1s infinite!important}`,
    body: "<p>x</p>",
  },
  "escaped longhands": {
    head: String.raw`p{anim\61 tion-name:spin!important;animation-duration:1s!important;animation-iteration-count:infinite!important}`,
    body: "<p>x</p>",
  },
  "a nested escaped rule": {
    head: String.raw`@media all{@supports(display:block){#x{\61 nimation:spin 1s infinite!important}}}`,
    body: '<p id="x">x</p>',
  },
  "an escaped prefix": {
    head: String.raw`p{-webkit-\61 nimation:spin 1s infinite!important}`,
    body: "<p>x</p>",
  },
  "an inline important style": {
    head: "",
    body: String.raw`<p style="\61 nimation:spin 1s infinite!important">x</p>`,
  },
  "a transition": { head: "p{transition:opacity 1s!important}", body: "<p>x</p>" },
};

for (const [name, { head, body }] of Object.entries(CASES)) {
  test(`a built preview does not animate with ${name}`, async ({ page }) => {
    const built = buildPreview(
      "html",
      `<!doctype html><html><head><style>${KEYFRAMES}${head}</style></head><body>${body}</body></html>`,
      DOCUMENT_RENDERER,
    );
    expect(built.state).toBe("ready");
    if (built.state !== "ready") return;
    await page.setContent('<iframe sandbox=""></iframe>');
    const frameElement = page.locator("iframe");
    await frameElement.evaluate((frame, html) => {
      (frame as HTMLIFrameElement).srcdoc = html;
    }, built.document);
    await expect.poll(() => page.frames().length).toBe(2);
    const frame = page.frames()[1];
    if (!frame) throw new Error("no frame");
    await frame.waitForSelector("p");
    const motion = await frame.evaluate(() => {
      const p = document.querySelector("p") as HTMLElement;
      return {
        name: getComputedStyle(p).animationName,
        animations: document.getAnimations().length,
      };
    });
    expect(motion).toEqual({ name: "none", animations: 0 });
  });
}
