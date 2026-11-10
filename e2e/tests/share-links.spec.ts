// Share links in real browsers (decision 0008, "Share links" in docs/security.md): the entry page
// on the app takes the token from the fragment, removes it from the address bar and hands the
// visitor to the artifact origin with a one-use code; the host-only link cookie then loads the
// artifact itself, without the viewer. Passwords, the lockout, expiry, revocation, suspension and
// the owner's plan are checked end to end, with third-party cookies blocked in every project.

import {
  contentRequests,
  createShareLink,
  createUser,
  expect,
  grantPlan,
  publish,
  revokeShareLink,
  setContentClock,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const LINK_COOKIE = "__Host-pf_link";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Board pack</title><link rel="stylesheet" href="style.css"></head><body><h1>Board pack</h1><p id="numbers">Quarterly numbers</p><script src="app.js"></script></body></html>',
  "style.css": "#numbers { color: rgb(0, 128, 0); }",
  "app.js": "document.documentElement.dataset.referrer = document.referrer || 'none';",
};

// Every browser of the stack shares one address: start each test with fresh entry counters.
test.beforeEach(async () => {
  await sql("delete from rate_limits where key like 'share:%'");
});

/** A restricted artifact of a Pro owner, with the Portifact bar on, and one link to it. */
async function shared(link: { password?: string; expiresAt?: number } = {}) {
  const owner = await createUser("Owner");
  await grantPlan(owner.userId, "pro");
  const published = await publish({
    ownerId: owner.userId,
    name: "Board pack",
    accessMode: "restricted",
    files: SITE,
  });
  const created = await createShareLink({
    ownerId: owner.userId,
    artifactId: published.artifactId,
    ...link,
  });
  return { owner, ...published, link: created };
}

test("a link without a password opens the artifact itself, without an account or the viewer", async ({
  page,
  context,
}) => {
  const { artifactId, link } = await shared();
  const before = (await contentRequests()).length;
  await page.goto(link.url);
  await page.waitForURL(`${artifactOrigin(artifactId)}/`);
  await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();
  await expect(page.locator("#numbers")).toHaveCSS("color", "rgb(0, 128, 0)");
  // The artifact got no referrer: neither the entry page nor the token reached it.
  await expect(page.locator("html")).toHaveAttribute("data-referrer", "none");

  const sent = (await contentRequests()).slice(before).filter((r) => r.host.startsWith(artifactId));
  const handoff = sent.find((r) => r.path === "/__portifact/link");
  expect(handoff).toMatchObject({
    status: 303,
    site: "cross-site",
    mode: "navigate",
    dest: "document",
  });
  for (const request of sent) expect(request.path).not.toContain(link.token);
  expect(sent.some((r) => r.path.startsWith("/view"))).toBe(false);

  const cookie = (await context.cookies(artifactOrigin(artifactId))).find(
    (c) => c.name === LINK_COOKIE,
  );
  expect(cookie).toMatchObject({
    domain: `${artifactId}.portifact-content.test`,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  expect(await page.evaluate(() => document.cookie)).not.toContain("pf_link");
  // Nothing of the token is left in the app's history entry either.
  await page.goBack();
  expect(page.url()).not.toContain("#");
});

test("a password link asks for the password, refuses a wrong one and opens with the right one", async ({
  page,
}) => {
  const { artifactId, link } = await shared({ password: "correct horse" });
  await page.goto(link.url);
  const password = page.getByLabel("Password");
  await expect(password).toBeFocused();
  expect(page.url()).toBe(`${APP_ORIGIN}/s`);
  await password.fill("wrong horse");
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The password is wrong, or the link expired or was revoked.",
  );
  await password.fill("correct horse");
  await page.getByRole("button", { name: "Open" }).click();
  await page.waitForURL(`${artifactOrigin(artifactId)}/`);
  await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();
});

test("repeated wrong passwords need the human check, then lock the link", async ({ page }) => {
  const { link } = await shared({ password: "correct horse" });
  await page.goto(link.url);
  const password = page.getByLabel("Password");
  const open = page.getByRole("button", { name: "Open" });
  for (let i = 0; i < 3; i += 1) {
    await password.fill(`wrong ${i}`);
    await open.click();
    await expect(page.getByRole("alert")).toContainText("The password is wrong");
  }
  // From the fourth try a human check runs (solved invisibly by the fake) and the try goes on.
  for (let i = 3; i < 10; i += 1) {
    await password.fill(`wrong ${i}`);
    await open.click();
    await expect(page.getByText("Confirm below that you are human")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("The password is wrong");
  }
  await password.fill("correct horse");
  await open.click();
  await expect(page.getByRole("alert")).toContainText("Too many attempts");
  expect(page.url()).toBe(`${APP_ORIGIN}/s`);
});

test("an expired link shows one clear page, the same as an unknown one", async ({ page }) => {
  const { link } = await shared({ expiresAt: Date.now() + 1500 });
  await page.waitForTimeout(2000);
  await page.goto(link.url);
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible();
  await page.goto(`${APP_ORIGIN}/s#${"A".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible();
  await page.goto(`${APP_ORIGIN}/s`);
  await expect(page.getByRole("heading", { name: "Open the link again" })).toBeVisible();
});

test("revoking a link ends an open session within the claims' minute", async ({ page }) => {
  const { owner, artifactId, link } = await shared();
  await page.goto(link.url);
  await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();
  await revokeShareLink({ ownerId: owner.userId, artifactId, linkId: link.id });
  try {
    await setContentClock(artifactId, 61_000);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "This share link has expired or was revoked" }),
    ).toBeVisible();
    // The page offers to start again, which now goes through sign-in like any visitor.
    await page.getByRole("link", { name: "Open the artifact again" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Portifact" })).toBeVisible();
  } finally {
    await setContentClock(artifactId, 0);
  }
  await page.goto(link.url);
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible();
});

test("suspending or archiving the artifact ends the link at once", async ({ page }) => {
  for (const state of ["suspended", "archived"] as const) {
    const { artifactId, link } = await shared();
    await page.goto(link.url);
    await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();
    await sql(
      `update artifacts set state = ?, archived_at = ${state === "archived" ? Date.now() : "null"} where id = ?`,
      [state, artifactId],
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Board pack" })).toBeHidden();
    await page.goto(link.url);
    await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible();
  }
});

test("a plan without share links pauses the link, and it works again when the plan returns", async ({
  page,
}) => {
  const { owner, link } = await shared();
  await grantPlan(owner.userId, "free");
  await page.goto(link.url);
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible();
  await grantPlan(owner.userId, "pro");
  await page.goto(link.url);
  await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();
});
