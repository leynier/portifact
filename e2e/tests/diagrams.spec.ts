// Markdown with Mermaid diagrams and highlighted code, end to end: the page draws its diagrams
// with the self-hosted diagram script under the document policy, in the light and dark schemes,
// and annotations on highlighted code and on a page with diagrams anchor to the same text as
// before. See "Diagrams and highlighted code" in docs/security.md.

import type { Frame, Page } from "@playwright/test";
import {
  artifactFrame,
  contentRequests,
  createUser,
  expect,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const CODE = "const answer: number = 42;";
const SOURCE = [
  "# Release plan",
  "",
  "```mermaid",
  "flowchart LR",
  "  accTitle: Release flow",
  "  Write --> Review --> Ship",
  "```",
  "",
  "```ts",
  `${CODE} // the answer`,
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  '  A["<img src=x onerror=window.pwned=1>"] --> B',
  '  click A href "javascript:window.pwned=2"',
  "```",
  "",
  "```mermaid",
  "this is not a diagram",
  "```",
  "",
  "The end.",
].join("\n");

/** Records CSP violations and stray script effects before the page's own scripts run. */
async function watchPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = window as unknown as { violations: string[] };
    record.violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      record.violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

async function diagramsDrawn(target: Page | Frame, count: number): Promise<void> {
  await expect(target.locator("figure.pf-diagram img")).toHaveCount(count);
  await expect
    .poll(() =>
      target.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLImageElement>("figure.pf-diagram img")).every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      ),
    )
    .toBe(true);
}

test("a Markdown page draws its diagrams on its own origin and highlights its code", async ({
  page,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: "Release plan",
    files: { "plan.md": SOURCE },
    accessMode: "public",
    bar: false,
  });
  await watchPage(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${artifactOrigin(artifactId)}/`);

  // Two diagrams are drawn; the one Mermaid cannot read stays as its source.
  await diagramsDrawn(page, 2);
  const first = page.locator("figure.pf-diagram").first();
  await expect(first.getByRole("img", { name: "Release flow" })).toBeVisible();
  await expect(page.getByText("this is not a diagram")).toBeVisible();

  // The source of a drawn diagram is folded behind a disclosure button and stays in the page.
  const toggle = first.getByRole("button", { name: "Diagram source" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Write --> Review --> Ship")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Write --> Review --> Ship")).toBeVisible();

  // Highlighted code is monochrome: weight and italics, never a hue.
  const keyword = page.locator("code .pf-tok-keyword").first();
  await expect(keyword).toHaveText("const");
  await expect(keyword).toHaveCSS("font-weight", "700");
  await expect(page.locator("code .pf-tok-comment")).toHaveCSS("font-style", "italic");
  const colors = await page.evaluate(() =>
    Array.from(document.querySelectorAll("code span"), (span) => getComputedStyle(span).color),
  );
  for (const color of colors) {
    const [r, g, b] = (color.match(/\d+/g) ?? []).map(Number);
    expect(r === g && g === b).toBe(true);
  }

  // Hostile diagram sources run nothing, and nothing the policy forbids was attempted.
  const effects = await page.evaluate(() => ({
    pwned: (window as unknown as { pwned?: number }).pwned,
    violations: (window as unknown as { violations: string[] }).violations,
    links: document.querySelectorAll('figure a, a[href^="javascript:"]').length,
  }));
  expect([effects.pwned, effects.links]).toEqual([undefined, 0]);
  // Mermaid puts a label's markup in the live page while it measures it; the policy refuses the
  // inline handler (Chromium reports it). Nothing else the policy forbids is attempted.
  for (const violation of effects.violations) {
    expect(violation).toMatch(/^script-src(?:-attr)? inline$/);
  }

  // The diagrams follow the color scheme.
  const lightSource = await first.locator("img").getAttribute("src");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(first.locator("img")).not.toHaveAttribute("src", lightSource ?? "");
  await diagramsDrawn(page, 2);
});

test("the diagram script is a compressed, immutable file the browser downloads once", async ({
  page,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: "Release plan",
    files: { "plan.md": SOURCE },
    accessMode: "public",
    bar: false,
  });
  const origin = artifactOrigin(artifactId);
  const FILE = /^\/__portifact\/diagrams\.[0-9a-f]{16}\.js$/;
  const before = (await contentRequests()).length;
  await page.goto(`${origin}/`);
  await diagramsDrawn(page, 2);
  // A second visit draws again from the browser's cache: the file is not requested again.
  await page.goto(`${origin}/?again`);
  await diagramsDrawn(page, 2);
  const files = (await contentRequests())
    .slice(before)
    .filter((request) => request.host.startsWith(`${artifactId}.`) && FILE.test(request.path));
  expect(files.map((request) => request.status)).toEqual([200]);

  // The loader's stable path is a short-lived redirect to the current build's file.
  const redirect = await page.request.get(`${origin}/__portifact/diagrams.js`, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers()["cache-control"]).toBe("public, max-age=3600");
  const location = redirect.headers().location ?? "";
  expect(location).toMatch(FILE);
  const file = await page.request.get(`${origin}${location}`, {
    headers: { "Accept-Encoding": "br" },
  });
  expect(file.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(file.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
  expect(file.headers()["content-encoding"]).toBe("br");
  // Compressed on the wire: about a fifth of the 5.5 MB script.
  expect(Number(file.headers()["content-length"])).toBeLessThan(2_000_000);
  expect((await file.body()).length).toBeGreaterThan(4_000_000);
  // Without brotli the Worker sends the plain script and the edge (here Miniflare, which
  // emulates it) gzips it.
  const gzip = await page.request.get(`${origin}${location}`, {
    headers: { "Accept-Encoding": "gzip" },
  });
  expect(gzip.headers()["content-encoding"]).toBe("gzip");
  expect((await gzip.body()).length).toBeGreaterThan(4_000_000);
});

/** Selects `quote` inside the first element matching `selector`, across highlight spans. */
async function selectIn(frame: Frame, selector: string, quote: string): Promise<void> {
  await frame.evaluate(
    ([css, text]) => {
      const root = document.querySelector(css as string);
      if (!root) throw new Error(`no ${css}`);
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
      const full = nodes.map((node) => node.data).join("");
      const start = full.indexOf(text as string);
      if (start < 0) throw new Error(`no ${text}`);
      const end = start + (text as string).length;
      const point = (offset: number): [Text, number] => {
        let seen = 0;
        for (const node of nodes) {
          if (offset <= seen + node.data.length) return [node, offset - seen];
          seen += node.data.length;
        }
        throw new Error("offset out of range");
      };
      const range = document.createRange();
      range.setStart(...point(start));
      range.setEnd(...point(end));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    [selector, quote],
  );
}

test("comments on highlighted code anchor to its text, with diagrams on the page", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "the bridge never runs in this configuration");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: "Release plan",
    files: { "plan.md": SOURCE },
  });
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  const frame = await artifactFrame(page, artifactId);
  // The review frame keeps the document policy and adds only the bridge: diagrams still draw.
  await diagramsDrawn(frame, 2);
  await expect(page.getByText("Connecting to the page")).toBeHidden();

  await selectIn(frame, "code.language-ts", CODE);
  const offer = page.getByRole("button", { name: "Comment", exact: true });
  await expect(offer).toBeVisible();
  await offer.click();
  const composer = page.getByRole("region", { name: "Comment on the selection" });
  await composer.getByRole("textbox", { name: "Comment" }).fill("Explain the type");
  await composer.getByRole("textbox", { name: "Comment" }).press("Enter");
  const sidebar = page.getByRole("complementary", { name: "Comments" });
  await expect(sidebar.getByText("1 comment thread")).toBeVisible();

  const [thread] = await sql<{ target: string }>(
    "SELECT target FROM annotation_threads WHERE author_id = ?",
    [owner.userId],
  );
  const target = JSON.parse(thread?.target ?? "{}");
  expect(target).toMatchObject({ anchor: { kind: "text", quote: { exact: CODE } } });
  await expect(
    sidebar.getByRole("article", { name: "Thread 1" }).getByRole("button", {
      name: "Show in the artifact",
    }),
  ).toBeVisible();

  // Without the diagram script the page keeps the same text, so the thread is found again.
  await context.route("**/__portifact/diagrams.js", (route) => route.abort());
  await page.reload();
  const bare = await artifactFrame(page, artifactId);
  await expect(bare.getByText("Write --> Review --> Ship")).toBeVisible();
  await expect(bare.locator("figure.pf-diagram")).toHaveCount(0);
  const again = page.getByRole("complementary", { name: "Comments" });
  await expect(
    again.getByRole("article", { name: "Thread 1" }).getByRole("button", {
      name: "Show in the artifact",
    }),
  ).toBeVisible();
  await expect(again.getByText("Without location")).toHaveCount(0);
});
