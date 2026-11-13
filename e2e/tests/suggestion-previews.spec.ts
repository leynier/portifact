// Built previews of edit suggestions on the preview origin (decision 0027, "Previews"), in every
// engine of the stack: the app issues a one-use URL for a stored plan, and the preview host serves
// the built document into an empty-sandbox frame on an app page, the frame the viewer will use. No
// request leaves the frame, no script runs, nothing animates, a link goes nowhere and the page
// cannot reach the app or the artifact origin; the URL works once. The parse5 differential and the
// detailed motion matrix stay in spikes/edit-suggestions/browser, which CI also runs.

import type { Frame, Page } from "@playwright/test";
import { control, createUser, expect, publish, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin, CONTENT_SITE } from "../src/hosts.ts";

const PREVIEW_ORIGIN = `https://preview.${CONTENT_SITE}`;
/** A page on the app origin that only frames: the stand-in for the viewer's preview tab. */
const HOST_PAGE = `${APP_ORIGIN}/__e2e/preview-host`;
const REFUSED = "This preview has expired or was already used";

const HOSTILE = `<!-- <head> --><html><head><title>x</title><base href="https://e.example/"><meta http-equiv="refresh" content="0;url=${APP_ORIGIN}/"><link rel="stylesheet" href="s.css"><style>@keyframes spin{from{opacity:1}to{opacity:0}} p{animation:spin 1s infinite!important;background:url(x.png)} @import url(i.css); @font-face{font-family:f;src:url(f.woff)} p{font-family:f}</style></head><body><header>x</header><script>parent.postMessage("ran","*");document.title="ran"</script><img src="x.png" alt="Chart" onerror="parent.postMessage('ran','*')"><a href="${APP_ORIGIN}/" id="go">Go</a><form action="/x"><input name="x"></form><iframe src="${APP_ORIGIN}/"></iframe><svg><image href="x.png"/></svg><video src="v.mp4" autoplay></video><p style="background:url(y.png)">Hostile text</p></body></html>`;

test.beforeEach(async () => {
  await sql("delete from rate_limits where key like 'suggestion-plan:%'");
});

/**
 * Opens the host page (answered by the test, on the app origin) and records every request that
 * leaves the page afterwards. Routing sees only what the engine actually sends: a load the
 * document's policy refuses never reaches it (Chromium still reports those as request events).
 */
async function hostPage(page: Page): Promise<string[]> {
  const sent: string[] = [];
  let recording = false;
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url === HOST_PAGE) {
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><head><title>Preview host</title></head><body><script>window.__messages=[];addEventListener('message',(e)=>window.__messages.push(String(e.data)));</script></body></html>",
      });
    }
    if (recording) sent.push(url);
    return route.continue();
  });
  await page.goto(HOST_PAGE);
  recording = true;
  return sent;
}

/** Asks the app for a preview URL with the page's dashboard session, as the viewer will. */
async function issue(page: Page, artifactId: string, digest: string) {
  return page.evaluate(
    async ([id, d]) => {
      const response = await fetch(`/api/v1/artifacts/${id}/previews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digest: d }),
      });
      return { status: response.status, body: await response.json() };
    },
    [artifactId, digest] as const,
  );
}

/** Frames a URL with an empty sandbox on the host page and returns the loaded frame. */
async function frame(page: Page, url: string, id: string): Promise<Frame> {
  await page.evaluate(
    ([src, frameId]) => {
      const element = document.createElement("iframe");
      element.id = frameId;
      element.setAttribute("sandbox", "");
      element.src = src;
      document.body.append(element);
    },
    [url, id] as const,
  );
  let found: Frame | null = null;
  await expect
    .poll(async () => {
      found = (await (await page.$(`#${id}`))?.contentFrame()) ?? null;
      return found?.url();
    })
    .toBe(url);
  const loaded = found as unknown as Frame;
  await loaded.waitForLoadState("load");
  return loaded;
}

/** What the framed document can do and reach, read from inside it. */
function inside(f: Frame) {
  return f.evaluate(() => {
    const blocked = (read: () => unknown) => {
      try {
        read();
        return "reachable";
      } catch {
        return "blocked";
      }
    };
    const p = document.querySelector("p");
    return {
      origin: self.origin,
      title: document.title,
      scripts: document.scripts.length,
      cookie: blocked(() => document.cookie),
      top: blocked(() => window.top?.location.href),
      animations: document.getAnimations().length,
      animationName: p ? getComputedStyle(p).animationName : "none",
      frames: document.querySelectorAll("iframe, frame, object, embed").length,
      hrefs: document.querySelectorAll("[href], [src], [action]").length,
    };
  });
}

/** Requests other than the host page's own favicon, which some engines ask for. */
const outside = (requests: string[], allowed: string[]) =>
  requests.filter((u) => !allowed.includes(u) && !u.endsWith("/favicon.ico"));

/**
 * Waits until the frame's document has nothing left to load: its `load` event (images, styles)
 * and its fonts settled. A request the page could start would have started by then, so no fixed
 * delay is needed before checking that none left the frame.
 */
async function settled(f: Frame): Promise<void> {
  await f.waitForLoadState("load");
  await f.evaluate(() => document.fonts.ready.then(() => document.fonts.status));
}

const DOCUMENTS = [
  {
    type: "markdown" as const,
    path: "index.md",
    source:
      "# Notes\n\nThe quick brown cat jumps.\n\n![secret](secret.png) [link](https://evil.example) <img src=x>\n",
    gone: "brown cat",
  },
  {
    type: "text" as const,
    path: "notes.txt",
    source: "First line\nThe cat sat\n<img src=x>\n",
    gone: "The cat sat",
  },
];

for (const doc of DOCUMENTS) {
  test(`a built preview of a ${doc.type} document shows the change, loads nothing and works once`, async ({
    page,
    context,
  }) => {
    const owner = await createUser("Owner");
    await signIn(context, owner);
    const requests = await hostPage(page);
    const published = await publish({
      ownerId: owner.userId,
      type: doc.type,
      name: "Notes",
      files: { [doc.path]: doc.source },
    });
    const planned = await control<{ digest: string; applies: boolean }>("/suggestion-plan", {
      ownerId: owner.userId,
      artifactId: published.artifactId,
      versionId: published.versionId,
      kind: doc.type,
      path: doc.path,
      source: doc.source,
      title: "Notes",
      before: "cat",
      after: "dog",
    });
    expect(planned.applies).toBe(true);
    const issued = await issue(page, published.artifactId, planned.digest);
    expect(issued.status).toBe(200);
    expect(issued.body.state).toBe("ready");
    const url = issued.body.url as string;
    expect(new URL(url).origin).toBe(PREVIEW_ORIGIN);

    requests.length = 0;
    const response = page.waitForResponse(url);
    const f = await frame(page, url, "preview");
    const headers = (await response).headers();
    expect(headers["content-security-policy"]).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors ${APP_ORIGIN}; sandbox`,
    );
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["set-cookie"]).toBeUndefined();
    await expect(f.locator("body")).toContainText("dog");
    await expect(f.locator("body")).not.toContainText(doc.gone);
    expect(await inside(f)).toMatchObject({
      origin: "null",
      scripts: 0,
      cookie: "blocked",
      top: "blocked",
      animations: 0,
      frames: 0,
      hrefs: 0,
    });
    await settled(f);
    expect(outside(requests, [url])).toEqual([]);

    // The same URL again: refused, whatever asks.
    const again = await frame(page, url, "again");
    await expect(again.locator("body")).toHaveText(REFUSED);
    expect(
      await page.evaluate(() => (window as unknown as { __messages: string[] }).__messages),
    ).toEqual([]);
  });
}

test("a hostile page's built preview runs nothing, loads nothing and goes nowhere", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  await signIn(context, owner);
  const source = "# Notes\n\nThe cat.\n";
  const published = await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: "Notes",
    files: { "index.md": source },
  });
  const planned = await control<{ threadId: string }>("/suggestion-plan", {
    ownerId: owner.userId,
    artifactId: published.artifactId,
    versionId: published.versionId,
    kind: "markdown",
    path: "index.md",
    source,
    title: "Notes",
    before: "cat",
    after: "dog",
  });
  const { url } = await control<{ url: string }>("/preview-document", {
    userId: owner.userId,
    sessionId: owner.sessionId,
    artifactId: published.artifactId,
    threadId: planned.threadId,
    kind: "html",
    source: HOSTILE,
  });
  const requests = await hostPage(page);
  const f = await frame(page, url, "hostile");
  await expect(f.locator("p")).toHaveText("Hostile text");
  await settled(f);
  expect(await inside(f)).toEqual({
    origin: "null",
    // The built document has no title: the head is written from scratch.
    title: "",
    scripts: 0,
    cookie: "blocked",
    top: "blocked",
    animations: 0,
    animationName: "none",
    frames: 0,
    hrefs: 0,
  });
  // The link kept its text without a destination: clicking it navigates nowhere.
  await settled(f);
  await f.locator("a").click();
  // A navigation the click started would replace the frame's document or the page's: both are
  // still the ones they were once they finished loading.
  await settled(f);
  await page.waitForLoadState("load");
  expect(f.url()).toBe(url);
  expect(page.url()).toBe(HOST_PAGE);
  expect(outside(requests, [url])).toEqual([]);
  expect(
    requests.some(
      (u) => u.startsWith(APP_ORIGIN) || u.startsWith(artifactOrigin(published.artifactId)),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() => (window as unknown as { __messages: string[] }).__messages),
  ).toEqual([]);
});

test("the preview host refuses a top-level visit and anything but a frame", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  await signIn(context, owner);
  const source = "# Notes\n\nThe cat.\n";
  const published = await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: "Notes",
    files: { "index.md": source },
  });
  const planned = await control<{ digest: string }>("/suggestion-plan", {
    ownerId: owner.userId,
    artifactId: published.artifactId,
    versionId: published.versionId,
    kind: "markdown",
    path: "index.md",
    source,
    title: "Notes",
    before: "cat",
    after: "dog",
  });
  await hostPage(page);
  const issued = await issue(page, published.artifactId, planned.digest);
  const url = issued.body.url as string;
  // A top-level visit does not spend the code: the frame still gets the preview afterwards.
  const visit = await page.goto(url);
  expect(visit?.status()).toBe(404);
  expect(await page.locator("body").textContent()).toBe(REFUSED);
  expect((await context.cookies(PREVIEW_ORIGIN)).length).toBe(0);
  await page.goto(HOST_PAGE);
  const f = await frame(page, url, "after-visit");
  await expect(f.locator("body")).toContainText("dog");
});
