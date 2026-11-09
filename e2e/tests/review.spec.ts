// Review mode end to end, in every engine configuration of playwright.config.ts: the viewer on
// the app origin, the artifact isolated on its own origin with the bridge, and comments written
// and confirmed in the viewer. See docs/decisions/0002-review-mode-cookies.md.

import {
  artifactFrame,
  contentRequests,
  control,
  createUser,
  expect,
  openReview,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { bouncingPage, type HostileResults, hostilePage, plantingPage } from "../src/hostile.ts";
import {
  APP_ORIGIN,
  artifactOrigin,
  bounced,
  CONTROL_COOKIE,
  REVIEW_COOKIE,
} from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launch plan</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Launch plan</h1><p id="intro">Hello brave new world</p><button id="buy" type="button">Buy now</button></main><script src="app.js"></script></body></html>',
  "style.css": "main { font-family: sans-serif; }",
  "app.js": "document.documentElement.dataset.app = 'ran';",
};

/** Threads authored by a user, straight from D1. */
async function threadsBy(userId: string) {
  return sql<{ id: string; target: string }>(
    "SELECT id, target FROM annotation_threads WHERE author_id = ?",
    [userId],
  );
}

test("review works with third-party cookies blocked, and comments are confirmed in the viewer", async ({
  page,
  context,
  engine,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({ ownerId: owner.userId, name: "Launch plan", files: SITE });
  await signIn(context, owner);
  const before = (await contentRequests()).length;
  await openReview(page, artifactId, "Launch plan");

  if (!engine.reviewWorks) {
    // The browser drops the partitioned cookie: the viewer says so and keeps general comments.
    await expect(page.getByText("Review tools are not available in this browser")).toBeVisible();
    const sent = (await contentRequests()).slice(before);
    expect(sent.some((r) => r.cookieNames.includes(REVIEW_COOKIE))).toBe(false);
    await page.getByRole("button", { name: "Comment on the page" }).click();
    await page.getByRole("textbox", { name: "Comment" }).fill("General note");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByText("1 comment thread")).toBeVisible();
    expect(await threadsBy(owner.userId)).toHaveLength(1);
    return;
  }

  // The bridge answered: element mode is offered only once it is connected.
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();
  const frame = await artifactFrame(page, artifactId);
  const sent = (await contentRequests()).slice(before).filter((r) => r.host.startsWith(artifactId));
  for (const path of ["/", "/style.css", "/app.js", "/__portifact/bridge.js"]) {
    const matching = sent.filter((r) => r.path === path);
    expect(matching.length, path).toBeGreaterThan(0);
    for (const request of matching) {
      expect(request.cookieNames, path).toContain(REVIEW_COOKIE);
      expect(request.status, path).toBe(200);
    }
  }
  // Proof that third-party cookies are blocked in this run: the ordinary cookie set next to the
  // review cookie never came back.
  expect(sent.some((r) => r.cookieNames.includes(CONTROL_COOKIE))).toBe(
    !engine.blocksThirdPartyCookies,
  );
  expect(await frame.evaluate(() => document.documentElement.dataset.app)).toBe("ran");

  // Selecting text only offers a comment; nothing is posted until the reader saves it.
  await frame.locator("#intro").selectText();
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  expect(await threadsBy(owner.userId)).toHaveLength(0);
  await page.getByRole("textbox", { name: "Comment" }).fill("Say hello to the old world too");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("1 comment thread")).toBeVisible();
  const [text] = await threadsBy(owner.userId);
  expect(JSON.parse(text?.target ?? "{}")).toMatchObject({
    path: "index.html",
    anchor: { kind: "text", quote: { exact: "Hello brave new world" } },
  });
  // The page located the new thread, so the viewer can point at it.
  const first = page.getByRole("article", { name: "Thread 1" });
  await expect(first.getByRole("button", { name: "Show in the artifact" })).toBeVisible();

  // Element mode: the click goes to the bridge, not to the page.
  await page.getByRole("button", { name: "Select an element" }).click();
  await frame.locator("#buy").click();
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Element button")).toBeVisible();
  await page.getByRole("textbox", { name: "Comment" }).fill("Make this the primary action");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("2 comment threads")).toBeVisible();
  const targets = (await threadsBy(owner.userId)).map((t) => JSON.parse(t.target).anchor.kind);
  expect(targets.sort()).toEqual(["element", "text"]);
});

test("a top-level visit to a reviewed artifact gets no review cookie and no bridge", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "no review cookie is stored in this configuration");
  const owner = await createUser("Owner");
  // Without the bar, a top-level visit gets the artifact itself (viewer.spec.ts covers the bar).
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Launch plan",
    bar: false,
    files: SITE,
  });
  await signIn(context, owner);
  await openReview(page, artifactId, "Launch plan");
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();

  const before = (await contentRequests()).length;
  const visit = await context.newPage();
  await visit.goto(`${artifactOrigin(artifactId)}/`);
  await visit.getByRole("heading", { name: "Launch plan" }).waitFor();
  expect(await visit.locator('script[src*="/__portifact/bridge.js"]').count()).toBe(0);
  const sent = (await contentRequests()).slice(before).filter((r) => r.host.startsWith(artifactId));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.some((r) => r.cookieNames.includes(REVIEW_COOKIE))).toBe(false);
});

test("a hostile artifact cannot read the viewer, act as the visitor or forge a comment", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "the artifact never runs in the viewer in this configuration");
  const victim = await createUser("Victim");
  const attacker = await createUser("Attacker");
  const carol = await createUser("Carol");
  const secret = await publish({
    ownerId: victim.userId,
    name: "Private numbers",
    files: { "index.html": "<!doctype html><title>Private</title><p>Private launch numbers</p>" },
  });
  const hostile = await publish({
    ownerId: attacker.userId,
    name: "Free prizes",
    accessMode: "public",
    files: { "index.html": hostilePage(artifactOrigin(secret.artifactId), secret.artifactId) },
  });
  // Someone else's comment on the hostile artifact: the viewer shows it, the frame must not get it.
  // The attacker lets every reader see every thread, so the victim's viewer lists it.
  await sql("UPDATE artifacts SET comment_visibility = 'everyone' WHERE id = ?", [
    hostile.artifactId,
  ]);
  await control("/thread", {
    userId: carol.userId,
    artifactId: hostile.artifactId,
    versionId: hostile.versionId,
    path: "index.html",
    body: "TOP SECRET BODY",
  });

  await signIn(context, victim);
  // The victim reviews their own private artifact first, so the browser holds its review cookie
  // in the viewer's partition, where the hostile artifact also runs.
  await openReview(page, secret.artifactId, "Private numbers");
  // The frame must have shown the artifact, so its own requests are done before counting.
  await artifactFrame(page, secret.artifactId);
  await expect(page.getByText("Connecting to the page")).toBeHidden();
  const before = (await contentRequests()).length;

  await openReview(page, hostile.artifactId, "Free prizes");
  await expect(page.getByText("TOP SECRET BODY")).toBeVisible();
  const frame = await artifactFrame(page, hostile.artifactId);
  await expect
    .poll(async () => JSON.parse((await frame.locator("#results").textContent()) ?? "{}").done, {
      timeout: 20_000,
    })
    .toBe(true);
  const results = JSON.parse(
    (await frame.locator("#results").textContent()) ?? "{}",
  ) as HostileResults;

  // The frame cannot reach the viewer, navigate it, or read the API or another artifact.
  expect(results.parentDom).toBe("blocked");
  expect(page.url()).toBe(`${APP_ORIGIN}/view/${hostile.artifactId}`);
  expect(results.readApi).toBe("blocked");
  expect(results.readSibling).toBe("blocked");
  expect(results.cookies).not.toContain(REVIEW_COOKIE);
  expect(results.cookies).not.toContain("pf.session_token");

  // It received the targets to highlight, never bodies, names, emails or tokens.
  const received = results.received.join("\n");
  expect(received).toContain('"type":"init"');
  expect(received).toContain('"type":"highlights"');
  for (const leak of ["TOP SECRET BODY", victim.email, carol.email, "Carol", victim.cookie]) {
    expect(received).not.toContain(leak);
  }

  // Its forged selection only offered a comment in the viewer, drawn inside the frame whatever
  // rectangle it claimed, its forged element (with no pick in progress) did nothing, nothing was
  // posted, and its requests could not act as the visitor or sign them out.
  expect(results.forged).toBeGreaterThan(0);
  const offer = page.getByRole("button", { name: "Comment", exact: true });
  await expect(offer).toBeVisible();
  const offerBox = await offer.boundingBox();
  const frameBox = await page.locator("iframe").boundingBox();
  expect(offerBox && frameBox).toBeTruthy();
  if (offerBox && frameBox) {
    expect(offerBox.x).toBeGreaterThanOrEqual(frameBox.x);
    expect(offerBox.y).toBeGreaterThanOrEqual(frameBox.y);
    expect(offerBox.x + offerBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width);
    expect(offerBox.y + offerBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height);
  }
  await expect(page.getByRole("form", { name: "New comment" })).toBeHidden();
  expect(await threadsBy(victim.userId)).toHaveLength(0);
  expect(await sql("SELECT id FROM sessions WHERE id = ?", [victim.sessionId])).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Free prizes" })).toBeVisible();

  // Its loads of the victim's private artifact carried the review cookie as same-site requests,
  // and the content Worker refused every one of them.
  const sibling = (await contentRequests())
    .slice(before)
    .filter((r) => r.host.startsWith(secret.artifactId));
  expect(sibling.length).toBeGreaterThan(0);
  for (const request of sibling) {
    expect(request.site).toBe("same-site");
    expect(request.status).not.toBe(200);
  }
  expect(sibling.some((r) => r.cookieNames.includes(REVIEW_COOKIE))).toBe(true);
});

test("the viewer refuses a review session another artifact planted in its frame", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "no review cookie is stored in this configuration");
  const victim = await createUser("Victim");
  const attacker = await createUser("Attacker");
  const reviewed = await publish({
    ownerId: victim.userId,
    name: "Launch plan",
    accessMode: "public",
    files: SITE,
  });
  const { code } = await control<{ code: string }>("/review-code", {
    userId: attacker.userId,
    sessionId: attacker.sessionId,
    artifactId: reviewed.artifactId,
  });
  const exchange = `${artifactOrigin(reviewed.artifactId)}/__portifact/review?code=${code}`;
  const planter = await publish({
    ownerId: attacker.userId,
    name: "Cute cats",
    accessMode: "public",
    files: { "index.html": plantingPage(bounced(exchange)) },
  });

  await signIn(context, victim);
  await openReview(page, reviewed.artifactId, "Launch plan");
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();

  // In another tab of the same viewer, the attacker's artifact plants its session. The bounced
  // navigation reaches the exchange as a cross-site iframe navigation and is redeemed.
  const before = (await contentRequests()).length;
  const other = await context.newPage();
  await openReview(other, planter.artifactId, "Cute cats");
  await expect
    .poll(async () =>
      (await contentRequests())
        .slice(before)
        .some(
          (r) =>
            r.host.startsWith(reviewed.artifactId) &&
            r.path === "/__portifact/review" &&
            r.status === 303,
        ),
    )
    .toBe(true);
  await other.close();

  // The next page load in the first viewer runs the planted session; the viewer notices.
  // (A link, not a reload: Firefox sends `Sec-Fetch-Site: none` for a frame's reload, which the
  // review cookie is not honored for.)
  const frame = await artifactFrame(page, reviewed.artifactId);
  await frame.evaluate(() => {
    window.location.href = "/index.html";
  });
  await expect(page.getByText("The frame is not running your review session")).toBeVisible();
  await expect(page.getByRole("button", { name: "Select an element" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Comment on the page" })).toBeVisible();

  // Reloading the review starts the visitor's own session again.
  await page.getByRole("button", { name: "Reload the review" }).click();
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();
});

test("the frame never reaches another artifact, and the viewer warns when it leaves", async ({
  page,
  context,
  engine,
  browserName,
}) => {
  test.skip(!engine.reviewWorks, "the bridge never runs in this configuration");
  const victim = await createUser("Victim");
  const attacker = await createUser("Attacker");
  const elsewhere = await publish({
    ownerId: attacker.userId,
    name: "Look alike",
    accessMode: "public",
    files: { "index.html": "<!doctype html><title>Look alike</title><p>Not the artifact</p>" },
  });
  const trampoline = await publish({
    ownerId: attacker.userId,
    name: "Trampoline",
    accessMode: "public",
    files: { "index.html": bouncingPage(`${artifactOrigin(elsewhere.artifactId)}/`) },
  });

  await signIn(context, victim);
  const before = (await contentRequests()).length;
  await openReview(page, trampoline.artifactId, "Trampoline");
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();
  // The viewer's `frame-src` names only this artifact's origin, so the page's navigation to
  // another artifact is refused before it is sent (Chromium shows an error page, Firefox keeps
  // the page) and the look-alike never renders in the viewer.
  await page.waitForTimeout(4_000);
  const reached = (await contentRequests())
    .slice(before)
    .filter((r) => r.host.startsWith(elsewhere.artifactId));
  expect(reached).toEqual([]);
  expect(page.frames().some((f) => f.url().includes(elsewhere.artifactId))).toBe(false);
  if (browserName === "chromium") {
    // The error page cannot answer from the artifact's origin: the viewer says so.
    await expect(page.getByText("The frame stopped answering from the artifact")).toBeVisible();
    await expect(page.getByRole("button", { name: "Select an element" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Comment on the page" })).toBeVisible();
  }
});

test("a frame bounced through another site never reaches another artifact in review mode", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "no review cookie is stored in this configuration");
  const victim = await createUser("Victim");
  const attacker = await createUser("Attacker");
  const secret = await publish({
    ownerId: victim.userId,
    name: "Private numbers",
    files: { "index.html": "<!doctype html><title>Private</title><p>Private launch numbers</p>" },
  });
  const trampoline = await publish({
    ownerId: attacker.userId,
    name: "Trampoline",
    accessMode: "public",
    files: { "index.html": bouncingPage(bounced(`${artifactOrigin(secret.artifactId)}/`)) },
  });

  await signIn(context, victim);
  // The visitor holds a live review cookie of the private artifact in the viewer's partition.
  await openReview(page, secret.artifactId, "Private numbers");
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();
  const before = (await contentRequests()).length;
  await openReview(page, trampoline.artifactId, "Trampoline");
  await expect(page.getByRole("button", { name: "Select an element" })).toBeVisible();
  // The trampoline navigates 1.5 seconds after connecting. The viewer's `frame-src` allows only
  // artifact hosts, so the redirector on the other site is refused (Chromium shows an error page,
  // Firefox keeps the page) and the cross-site navigation the review cookie honors never happens.
  await page.waitForTimeout(4_000);
  const reached = (await contentRequests())
    .slice(before)
    .filter((r) => r.host.startsWith(secret.artifactId));
  expect(reached).toEqual([]);
  await expect(page.getByText("Private launch numbers")).toBeHidden();
});

test("a Markdown document is reviewed with the bridge allowed only by nonce", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "the bridge never runs in this configuration");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: "Release notes",
    files: { "notes.md": "# Release notes\n\nThe review bridge runs here.\n" },
  });
  await signIn(context, owner);
  await openReview(page, artifactId, "Release notes");
  const frame = await artifactFrame(page, artifactId);
  await expect(page.getByText("Connecting to the page")).toBeHidden();
  await expect(page.getByText("The page does not answer the review tools")).toBeHidden();
  // The document's own scripts stay blocked; only the bridge runs.
  expect(await frame.locator("script").count()).toBe(1);
  await frame.getByText("The review bridge runs here.").selectText();
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toBeVisible();
});
