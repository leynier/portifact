// Cookies one artifact injects on the shared content domain (portifact.dev is not on the Public
// Suffix List): every other artifact still loads for the same visitor, the content Worker
// expires them once they grow, and none of them grants access. See "Injected cookies" in
// docs/security.md.
import { contentRequests, createUser, expect, publish, test } from "../src/fixtures.ts";
import { cookieInjectingPage } from "../src/hostile.ts";
import { APP_ORIGIN, artifactOrigin, CONTENT_SITE } from "../src/hosts.ts";

/** FOREIGN_COOKIE_LIMIT in apps/content/src/injected.ts. */
const FOREIGN_COOKIE_LIMIT = 8 * 1024;
const INJECTED = 150;

const NEIGHBOUR = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Neighbour</title></head><body><main><h1>Neighbour</h1></main></body></html>',
  "docs/index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Docs</title></head><body><main><h1>Docs</h1></main></body></html>',
};

test("an artifact that injects hundreds of shared-domain cookies breaks no other artifact and opens nothing", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  const attacker = await publish({
    ownerId: owner.userId,
    name: "Cookie jar",
    bar: false,
    files: { "index.html": cookieInjectingPage(INJECTED) },
    accessMode: "public",
  });
  const neighbour = await publish({
    ownerId: owner.userId,
    name: "Neighbour",
    bar: false,
    files: NEIGHBOUR,
    accessMode: "public",
  });
  const secret = await publish({
    ownerId: owner.userId,
    name: "Secret",
    bar: false,
    files: { "index.html": "<!doctype html><title>Secret</title><h1>Secret</h1>" },
  });

  // Live cookies on the shared domain. Firefox can still list a cookie a response just expired,
  // empty and past its expiry, though it no longer sends it.
  const shared = async () =>
    (await context.cookies()).filter(
      (cookie) =>
        cookie.domain.replace(/^\./, "") === CONTENT_SITE &&
        cookie.value !== "" &&
        (cookie.expires === -1 || cookie.expires * 1000 > Date.now()),
    );
  await page.goto(`${artifactOrigin(attacker.artifactId)}/`);
  await expect(page.locator("#state")).toHaveText("injected");
  const injected = await shared();
  expect(injected.length).toBeGreaterThanOrEqual(INJECTED);
  expect(injected.some((cookie) => cookie.path === "/docs")).toBe(true);

  // The neighbour receives all of them, still loads, and its answers expire them.
  const before = (await contentRequests()).length;
  await page.goto(`${artifactOrigin(neighbour.artifactId)}/docs/`);
  await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
  await page.goto(`${artifactOrigin(neighbour.artifactId)}/`);
  await expect(page.getByRole("heading", { name: "Neighbour" })).toBeVisible();
  const served = (await contentRequests())
    .slice(before)
    .filter((request) => request.host.startsWith(neighbour.artifactId));
  const first = served.find((request) => request.path === "/docs/");
  expect(first?.status).toBe(200);
  expect(first?.cookieNames).toContain("inj0");
  expect(first?.cookieNames).toContain("deep0");

  const left = await shared();
  const bytes = left.reduce((sum, cookie) => sum + cookie.name.length + cookie.value.length + 2, 0);
  expect(bytes).toBeLessThanOrEqual(FOREIGN_COOKIE_LIMIT);
  expect(left.filter((cookie) => cookie.path === "/docs")).toEqual([]);
  expect(left.map((cookie) => cookie.name)).not.toContain("pf_read");
  expect(left.map((cookie) => cookie.name)).not.toContain("__host-pf_read");

  // A protected artifact still sends the visitor to sign in: no injected cookie is a session.
  await page.goto(`${artifactOrigin(secret.artifactId)}/`);
  await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN}/login`));
});
