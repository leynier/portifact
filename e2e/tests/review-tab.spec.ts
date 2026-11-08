// The review tab, the fallback where the viewer's frame cannot run review mode: in engines that
// drop the partitioned cookie (Firefox with all third-party cookies blocked, WebKit on Linux) and,
// in the others, for a page whose own policy blocks the bridge. See "Review mode" in
// docs/security.md and docs/decisions/0002-review-mode-cookies.md.
import {
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
import { navigatingPage, plantingPage } from "../src/hostile.ts";
import { artifactOrigin, bounced, REVIEW_COOKIE, REVIEW_TAB_COOKIE } from "../src/hosts.ts";

// The page's own policy blocks every script, the bridge included, so engines where the frame
// keeps the review cookie reach the fallback too.
const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"><title>Launch plan</title></head><body><main><h1>Launch plan</h1><p>Hello brave new world</p><a href="details.html">Details</a></main></body></html>',
  "details.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Details</title></head><body><main><h1>Details</h1></main></body></html>',
};

test("a review tab shows the version with a banner, comments stay in the viewer, and End review ends it", async ({
  page,
  context,
  engine,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({ ownerId: owner.userId, name: "Launch plan", files: SITE });
  await signIn(context, owner);
  await openReview(page, artifactId, "Launch plan");
  await expect(
    page.getByText(
      engine.reviewWorks
        ? "The page does not answer the review tools"
        : "Review tools are not available in this browser",
    ),
  ).toBeVisible();

  const sessions = () =>
    sql<{ id: string }>("SELECT id FROM review_sessions WHERE user_id = ? AND artifact_id = ?", [
      owner.userId,
      artifactId,
    ]);
  // Engines that keep the frame's cookie already hold the frame's own session.
  const frameSessions = await sessions();
  await page.getByRole("button", { name: "Prepare a review tab" }).click();
  const link = page.getByRole("link", { name: "Open the review tab" });
  await expect(link).toBeFocused();
  const before = (await contentRequests()).length;
  const [tab] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await tab.waitForLoadState("load");
  await expect(page.getByText(/The review tab opened/)).toBeVisible();

  // The tab shows the artifact on its own origin, in review mode, with the banner.
  await expect(tab.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  expect(new URL(tab.url()).origin).toBe(artifactOrigin(artifactId));
  const banner = tab.getByRole("region", { name: "Portifact review" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Write comments in the review viewer");
  expect(await sessions()).toHaveLength(frameSessions.length + 1);
  // It cannot reach the viewer that opened it.
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  const opened = (await contentRequests())
    .slice(before)
    .filter((r) => r.host.startsWith(artifactId));
  const exchange = opened.find((r) => r.path === "/__portifact/review/tab");
  expect(exchange).toMatchObject({ status: 303, site: "cross-site", dest: "document" });
  const root = opened.filter((r) => r.path === "/");
  expect(root.length).toBeGreaterThan(0);
  for (const request of root) {
    expect(request.cookieNames).toContain(REVIEW_TAB_COOKIE);
    expect(request.status).toBe(200);
  }

  // Links inside the tab stay in review mode.
  await tab.getByRole("link", { name: "Details" }).click();
  await expect(tab.getByRole("heading", { name: "Details" })).toBeVisible();
  await expect(tab.getByRole("region", { name: "Portifact review" })).toBeVisible();

  // Comments are written and posted in the viewer, never in the tab.
  await page.getByRole("button", { name: "Comment on the page" }).click();
  await page.getByRole("textbox", { name: "Comment" }).fill("Seen in the review tab");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText("1 comment thread")).toBeVisible();
  expect(
    await sql("SELECT id FROM annotation_threads WHERE author_id = ?", [owner.userId]),
  ).toHaveLength(1);

  // End review deletes the session and clears the cookie; the next visit is a normal one.
  await tab.getByRole("link", { name: "End review" }).click();
  await expect(tab.getByRole("heading", { name: /Review ended/ })).toBeVisible();
  expect(await sessions()).toEqual(frameSessions);
  const after = (await contentRequests()).length;
  await tab.goto(`${artifactOrigin(artifactId)}/details.html`);
  await expect(tab.getByRole("heading", { name: "Details" })).toBeVisible();
  await expect(tab.getByRole("region", { name: "Portifact review" })).toBeHidden();
  const later = (await contentRequests()).slice(after).filter((r) => r.host.startsWith(artifactId));
  expect(later.length).toBeGreaterThan(0);
  expect(later.some((r) => r.cookieNames.includes(REVIEW_TAB_COOKIE))).toBe(false);
});

test("an artifact cannot open a review tab session in a visitor's browser", async ({
  page,
  context,
}) => {
  const victim = await createUser("Victim");
  const attacker = await createUser("Attacker");
  const reviewed = await publish({
    ownerId: attacker.userId,
    name: "Launch plan",
    accessMode: "public",
    files: SITE,
  });
  const codes = await Promise.all(
    [0, 1].map(() =>
      control<{ code: string }>("/review-code", {
        userId: attacker.userId,
        sessionId: attacker.sessionId,
        artifactId: reviewed.artifactId,
        kind: "tab",
      }),
    ),
  );
  const tabLink = (code: string) =>
    `${artifactOrigin(reviewed.artifactId)}/__portifact/review/tab?code=${code}`;
  await signIn(context, victim);

  // Straight from a sibling artifact (same-site), and bounced through another site so it
  // arrives cross-site: neither carries the app's origin as Referer.
  for (const url of [tabLink(codes[0]?.code ?? ""), bounced(tabLink(codes[1]?.code ?? ""))]) {
    const planter = await publish({
      ownerId: attacker.userId,
      name: "Navigator",
      accessMode: "public",
      files: { "index.html": navigatingPage(url) },
    });
    const before = (await contentRequests()).length;
    await page.goto(`${artifactOrigin(planter.artifactId)}/`);
    await expect
      .poll(async () =>
        (await contentRequests())
          .slice(before)
          .some(
            (r) => r.host.startsWith(reviewed.artifactId) && r.path === "/__portifact/review/tab",
          ),
      )
      .toBe(true);
    const exchange = (await contentRequests())
      .slice(before)
      .find((r) => r.host.startsWith(reviewed.artifactId) && r.path === "/__portifact/review/tab");
    expect(exchange?.status).toBe(400);
  }

  const before = (await contentRequests()).length;
  await page.goto(`${artifactOrigin(reviewed.artifactId)}/`);
  await expect(page.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Portifact review" })).toBeHidden();
  const visit = (await contentRequests())
    .slice(before)
    .filter((r) => r.host.startsWith(reviewed.artifactId));
  expect(visit.some((r) => r.cookieNames.includes(REVIEW_TAB_COOKIE))).toBe(false);
  expect(await sql("SELECT id FROM review_sessions WHERE user_id = ?", [attacker.userId])).toEqual(
    [],
  );
});

test("a frame session a sibling plants in the artifact's own partition is never honored at top level", async ({
  page,
  context,
}, testInfo) => {
  const victim = await createUser("Victim");
  const attacker = await createUser("Attacker");
  // Any artifact the attacker can read: here a public one of the victim's.
  const reviewed = await publish({
    ownerId: victim.userId,
    name: "Launch plan",
    accessMode: "public",
    files: SITE,
  });
  const origin = artifactOrigin(reviewed.artifactId);
  const exchangeHit = async (since: number) =>
    (await contentRequests())
      .slice(since)
      .some(
        (r) =>
          r.host.startsWith(reviewed.artifactId) &&
          r.path === "/__portifact/review" &&
          r.status === 303,
      );
  /** A sibling frames a redirector on another site that lands on the exchange with its code. */
  const plant = async () => {
    const { code } = await control<{ code: string }>("/review-code", {
      userId: attacker.userId,
      sessionId: attacker.sessionId,
      artifactId: reviewed.artifactId,
    });
    const sibling = await publish({
      ownerId: attacker.userId,
      name: "Cute cats",
      accessMode: "public",
      files: {
        "index.html": plantingPage(bounced(`${origin}/__portifact/review?code=${code}`)),
      },
    });
    const since = (await contentRequests()).length;
    await page.goto(`${artifactOrigin(sibling.artifactId)}/`);
    await expect.poll(() => exchangeHit(since)).toBe(true);
  };
  /** Whether this engine stores a partitioned cookie set in a same-site frame at all. */
  const keepsPartitioned =
    !testInfo.project.name.startsWith("webkit") || process.platform === "darwin";
  const requestsSince = async (since: number) =>
    (await contentRequests()).slice(since).filter((r) => r.host.startsWith(reviewed.artifactId));
  const bridge = (target: typeof page) => target.locator('script[src*="/__portifact/bridge.js"]');

  await signIn(context, victim);
  await plant();

  // A top-level visit carries the planted cookie, is served normally and clears it.
  let since = (await contentRequests()).length;
  await page.goto(`${origin}/`);
  await expect(page.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  expect(await bridge(page).count()).toBe(0);
  const first = await requestsSince(since);
  if (keepsPartitioned) {
    expect(first.find((r) => r.path === "/")?.cookieNames).toContain(REVIEW_COOKIE);
  }
  since = (await contentRequests()).length;
  await page.goto(`${origin}/details.html`);
  await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
  const second = await requestsSince(since);
  expect(second.length).toBeGreaterThan(0);
  expect(second.some((r) => r.cookieNames.includes(REVIEW_COOKIE))).toBe(false);

  // Planted again, it does not outrank the visitor's own review tab either.
  await plant();
  await openReview(page, reviewed.artifactId, "Launch plan");
  await page.getByRole("button", { name: "Prepare a review tab" }).click();
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: "Open the review tab" }).click(),
  ]);
  await tab.waitForLoadState("load");
  await expect(tab.getByRole("region", { name: "Portifact review" })).toBeVisible();
  expect(await bridge(tab).count()).toBe(0);
  await tab.getByRole("link", { name: "Details" }).click();
  await expect(tab.getByRole("heading", { name: "Details" })).toBeVisible();
  await expect(tab.getByRole("region", { name: "Portifact review" })).toBeVisible();
  expect(await bridge(tab).count()).toBe(0);

  // End review leaves no review cookie of either kind behind.
  await tab.getByRole("link", { name: "End review" }).click();
  await expect(tab.getByRole("heading", { name: /Review ended/ })).toBeVisible();
  since = (await contentRequests()).length;
  await tab.goto(`${origin}/details.html`);
  await expect(tab.getByRole("heading", { name: "Details" })).toBeVisible();
  await expect(tab.getByRole("region", { name: "Portifact review" })).toBeHidden();
  expect(await bridge(tab).count()).toBe(0);
  const after = await requestsSince(since);
  expect(after.length).toBeGreaterThan(0);
  for (const request of after) {
    expect(request.cookieNames).not.toContain(REVIEW_COOKIE);
    expect(request.cookieNames).not.toContain(REVIEW_TAB_COOKIE);
  }
});
