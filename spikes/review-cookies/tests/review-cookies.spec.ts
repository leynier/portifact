import {
  expect,
  frameData,
  liveSessionsFor,
  openViewer,
  refetchData,
  requestsSince,
  SUBRESOURCES,
  test,
} from "../src/fixtures.ts";
import { artifactOrigin, CONTENT_SITE, REVIEW_COOKIE, viewerUrl } from "../src/hosts.ts";

// Prints one observation per line so a run doubles as the evidence for the decision record.
function report(name: string, value: unknown): void {
  console.log(`[${test.info().project.name}] ${name}: ${JSON.stringify(value)}`);
}

test("the review cookie is set in the iframe and sent on every subresource", async ({
  page,
  context,
  spike,
  engine,
}) => {
  const start = spike.requests.length;
  const frame = await openViewer(page, "art1");
  const data = await frameData(frame);
  const requests = requestsSince(spike, start, "art1");
  const jar = await context.cookies();
  report(
    "review cookie in jar",
    jar.filter((cookie) => cookie.name === REVIEW_COOKIE),
  );

  if (!engine.partitionedCookieWorks) {
    expect(data.mode).toBe("public");
    expect(requests.every((request) => request.reviewValues.length === 0)).toBe(true);
    expect(jar.some((cookie) => cookie.name === REVIEW_COOKIE)).toBe(false);
    return;
  }

  expect(data.mode).toBe("review");
  for (const path of SUBRESOURCES) {
    const matching = requests.filter((request) => request.path === path);
    expect(matching.length, `request for ${path}`).toBeGreaterThan(0);
    for (const request of matching) expect(request.review, `review on ${path}`).toBe(true);
  }
  // A link followed inside the iframe keeps the session.
  const before = spike.requests.length;
  await frame.click("#next");
  await frame.waitForURL(`${artifactOrigin("art1")}/other.html`);
  await frame.waitForFunction(() => "spike" in window);
  expect(await frameData(frame)).toMatchObject({ mode: "review" });
  const navigation = requestsSince(spike, before, "art1");
  expect(navigation.length).toBeGreaterThan(0);
  expect(navigation.every((request) => request.review)).toBe(true);
});

test("third-party cookie blocking matches the project profile", async ({ page, spike, engine }) => {
  const start = spike.requests.length;
  await openViewer(page, "art1");
  const control = requestsSince(spike, start, "art1").some((request) => request.control);
  report("unpartitioned control cookie sent in iframe", control);
  expect(control).toBe(!engine.blocksThirdPartyCookies);
});

test("a top-level visit to the same artifact does not carry the review cookie", async ({
  page,
  context,
  spike,
  engine,
}) => {
  test.skip(!engine.partitionedCookieWorks, "no review cookie is stored in this configuration");
  await openViewer(page, "art1");
  const topLevel = await context.newPage();
  const start = spike.requests.length;
  await topLevel.goto(`${artifactOrigin("art1")}/`);
  await topLevel.waitForFunction(() => "spike" in window);
  const data = await frameData(topLevel.mainFrame());
  const requests = requestsSince(spike, start, "art1");

  expect(data.mode).toBe("public");
  expect(requests.length).toBeGreaterThanOrEqual(SUBRESOURCES.length);
  expect(requests.every((request) => request.reviewValues.length === 0)).toBe(true);
  // The viewer keeps working after the top-level visit.
  const again = await openViewer(page, "art1");
  expect(await frameData(again)).toMatchObject({ mode: "review" });
});

test("a sibling artifact cannot read or overwrite the review cookie", async ({
  page,
  context,
  spike,
  engine,
}) => {
  const art1 = await openViewer(page, "art1");
  const legit = engine.partitionedCookieWorks ? liveSessionsFor(spike, "art1").at(-1) : undefined;
  if (engine.partitionedCookieWorks) expect(legit).toBeDefined();

  // The sibling runs inside the viewer (the same cookie partition as art1's review cookie) and
  // as a top-level page, and tries every cookie-tossing variant available to page script.
  // Artifacts cannot set response headers, so document.cookie is the whole attack surface.
  const attacks = [
    `${REVIEW_COOKIE}=evil-domain; Domain=${CONTENT_SITE}; Path=/; Secure; SameSite=None; Partitioned`,
    `${REVIEW_COOKIE}=evil-domain-plain; Domain=${CONTENT_SITE}; Path=/; Secure; SameSite=None`,
    `__host-pf_review=evil-lowercase; Domain=${CONTENT_SITE}; Path=/; Secure; SameSite=None; Partitioned`,
    `=${REVIEW_COOKIE}=evil-nameless; Domain=${CONTENT_SITE}; Path=/; Secure; SameSite=None; Partitioned`,
    `=${REVIEW_COOKIE}=evil-nameless-plain; Domain=${CONTENT_SITE}; Path=/; Secure; SameSite=None`,
    `pf_review=evil-unprefixed; Domain=${CONTENT_SITE}; Path=/; Secure; SameSite=None; Partitioned`,
  ];
  const siblingViewer = await context.newPage();
  const art2InViewer = await openViewer(siblingViewer, "art2");
  const siblingTop = await context.newPage();
  await siblingTop.goto(`${artifactOrigin("art2")}/`);
  await siblingTop.waitForFunction(() => "spike" in window);

  for (const frame of [art2InViewer, siblingTop.mainFrame()]) {
    const visible = await frame.evaluate((list) => {
      // biome-ignore lint/suspicious/noDocumentCookie: the attack under test is document.cookie.
      for (const attack of list) document.cookie = attack;
      return document.cookie;
    }, attacks);
    report("sibling document.cookie after attacks", visible);
    if (legit) expect(visible).not.toContain(legit);
    expect(visible).not.toContain(`${REVIEW_COOKIE}=`);
  }

  // A credentialed request from the sibling to art1, inside the viewer partition. The browser
  // attaches art1's cookie (same site), so the Worker must refuse review mode by itself.
  const crossStart = spike.requests.length;
  await art2InViewer.evaluate(
    async (url) => {
      await fetch(url, { credentials: "include", mode: "no-cors" }).catch(() => undefined);
    },
    `${artifactOrigin("art1")}/data.json`,
  );
  const [cross] = requestsSince(spike, crossStart, "art1");
  report("sibling request to art1", cross);
  expect(cross?.secFetchSite).toBe("same-site");
  expect(cross?.sessionValid).toBe(engine.partitionedCookieWorks);
  expect(cross?.review).toBe(false);

  const after = await refetchData(art1);
  report("art1 cookies after sibling attacks", after.cookieNames);
  expect(after.mode).toBe(engine.partitionedCookieWorks ? "review" : "public");
  expect(after.reviewValues).toEqual(legit ? [legit] : []);
  expect(after.cookieNames.includes("__host-pf_review")).toBe(
    engine.acceptsLowercaseHostPrefixWithDomain,
  );
});

test("fallback: storage access api inside the iframe", async ({ page, context, spike, engine }) => {
  test.skip(engine.partitionedCookieWorks, "the partitioned cookie works; no fallback needed");
  // WebKit grants storage access only to sites the user interacted with as a first party.
  const firstParty = await context.newPage();
  await firstParty.goto(`${artifactOrigin("art1")}/`);
  await firstParty.click("h1");
  await firstParty.close();

  const frame = await openViewer(page, "art1");
  const sessionsBefore = liveSessionsFor(spike, "art1").length;
  const index = spike.requests.length;
  await frame.click("#grant");
  const handle = await page.waitForFunction(
    () => (window as unknown as { storageAccessResult: string | null }).storageAccessResult,
  );
  const result = String(await handle.jsonValue());
  report("requestStorageAccess result", result);

  if (engine.storageAccess === "denied") {
    expect(result).toMatch(/^denied/);
    return;
  }
  expect(result).toMatch(/^granted/);
  // The frame exchanges a fresh code with a same-document fetch, then reloads.
  await expect.poll(() => liveSessionsFor(spike, "art1").length).toBeGreaterThan(sessionsBefore);
  await expect
    .poll(() => requestsSince(spike, index, "art1").filter((r) => r.path === "/data.json").length)
    .toBeGreaterThanOrEqual(2);
  const afterGrant = requestsSince(spike, index, "art1");
  report(
    "requests after grant",
    afterGrant.map((r) => [r.path, r.reviewValues.length, r.review]),
  );
  const withCookie = afterGrant.some((request) => request.review);
  expect(withCookie).toBe(engine.storageAccess === "granted-with-cookies");
});

test("fallback: top-level review tab works but loses top-level isolation", async ({
  page,
  context,
  spike,
}) => {
  await page.goto(viewerUrl("art1"));
  const popupPromise = page.waitForEvent("popup");
  await page.click("#open-tab");
  const popup = await popupPromise;
  await popup.waitForURL(`${artifactOrigin("art1")}/`);
  await popup.waitForFunction(() => "spike" in window);
  expect(await frameData(popup.mainFrame())).toMatchObject({ mode: "review" });

  // The cookie now lives in the artifact's own partition, so a later typed visit carries it.
  // Fetch metadata keeps the document public (`Sec-Fetch-Site: none`), but the page's own
  // subresources are same-origin and come back in review mode.
  const start = spike.requests.length;
  const typed = await context.newPage();
  await typed.goto(`${artifactOrigin("art1")}/`);
  await typed.waitForFunction(() => "spike" in window);
  const requests = requestsSince(spike, start, "art1");
  report(
    "later typed top-level visit",
    requests.map((r) => [r.path, r.reviewValues.length, r.review, r.secFetchSite]),
  );
  const document = requests.find((request) => request.path === "/");
  expect(document?.reviewValues.length).toBe(1);
  expect(document?.review).toBe(false);
  expect(await frameData(typed.mainFrame())).toMatchObject({ mode: "review" });
});
