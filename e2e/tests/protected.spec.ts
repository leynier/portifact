// Entry to protected artifacts in real browsers ("Entry to protected artifacts" in
// docs/security.md): the anonymous redirect to sign in, the one-use handoff from
// app/read/<id> to /__portifact/callback, the host-only read cookie that loads the page and its
// subresources, the refusal of an account that is not a reader, and the end of access after a
// revocation or a sign-out within the documented 60 seconds.

import {
  changeAccess,
  contentRequests,
  createUser,
  expect,
  publish,
  setContentClock,
  signIn,
  test,
  type User,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const READ_COOKIE = "__Host-pf_read";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Board pack</title><link rel="stylesheet" href="style.css"></head><body><h1>Board pack</h1><p id="numbers">Quarterly numbers</p><img id="logo" src="logo.svg" alt="Logo" width="20" height="20"><script src="app.js"></script></body></html>',
  "style.css": "#numbers { color: rgb(0, 128, 0); }",
  "app.js": "document.documentElement.dataset.app = 'ran';",
  "logo.svg":
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>',
};

/** A restricted artifact of a new owner that lists `reader` as its only reader. */
async function restrictedFor(reader: User) {
  const owner = await createUser("Owner");
  const published = await publish({
    ownerId: owner.userId,
    name: "Board pack",
    accessMode: "restricted",
    readers: [reader.email],
    files: SITE,
  });
  return { owner, ...published };
}

/** Requests to one artifact host since `before`. */
async function requestsTo(artifactId: string, before: number) {
  return (await contentRequests()).slice(before).filter((r) => r.host.startsWith(artifactId));
}

/** The login page's `next`, when the page is the login page. */
function loginNext(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.origin !== APP_ORIGIN || parsed.pathname !== "/login") return null;
  return parsed.searchParams.get("next");
}

test("an anonymous visit signs in on the app and a reader comes back to the page and its files", async ({
  page,
  context,
}) => {
  const reader = await createUser("Reader");
  const { artifactId } = await restrictedFor(reader);
  const before = (await contentRequests()).length;

  // Anonymous: the artifact sends the visitor to the app, which asks them to sign in.
  await page.goto(`${artifactOrigin(artifactId)}/index.html?from=link`);
  await expect(page.getByRole("heading", { name: "Sign in to Portifact" })).toBeVisible();
  const next = loginNext(page.url());
  expect(next).toMatch(new RegExp(`^/read/${artifactId}\\?state=[A-Za-z0-9_-]+$`));
  // The requested path stays on the artifact origin; the app never sees it.
  expect(page.url()).not.toContain("from=link");
  const anonymous = await requestsTo(artifactId, before);
  expect(anonymous.map((r) => [r.path, r.status])).toEqual([["/index.html", 303]]);
  expect(await page.content()).not.toContain("Quarterly numbers");

  // Signed in, the login page continues to /read, which hands off to the artifact's callback.
  await signIn(context, reader);
  const signedIn = (await contentRequests()).length;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();
  expect(page.url()).toBe(`${artifactOrigin(artifactId)}/index.html?from=link`);
  await expect(page.locator("html")).toHaveAttribute("data-app", "ran");
  await expect(page.locator("#numbers")).toHaveCSS("color", "rgb(0, 128, 0)");
  await expect
    .poll(() => page.locator("#logo").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(20);

  const entry = await requestsTo(artifactId, signedIn);
  const callback = entry.find((r) => r.path === "/__portifact/callback");
  expect(callback?.status).toBe(303);
  expect(callback?.mode).toBe("navigate");
  for (const path of ["/index.html", "/style.css", "/app.js", "/logo.svg"]) {
    const served = entry.filter((r) => r.path === path && r.status === 200);
    expect(served.length, path).toBeGreaterThan(0);
    for (const request of served) expect(request.cookieNames, path).toContain(READ_COOKIE);
  }

  // The read cookie is host-only on the artifact origin and never readable by its scripts.
  const cookies = await context.cookies(artifactOrigin(artifactId));
  const read = cookies.find((c) => c.name === READ_COOKIE);
  expect(read).toMatchObject({
    domain: `${artifactId}.portifact-content.test`,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  expect(await page.evaluate(() => document.cookie)).not.toContain("pf_read");
  // Nothing of the app session reached the artifact origin.
  for (const request of entry) expect(request.cookieNames).not.toContain("__Host-pf.session_token");
});

test("a signed-in account that is not a reader is refused", async ({ page, context }) => {
  const reader = await createUser("Reader");
  const stranger = await createUser("Stranger");
  const { artifactId } = await restrictedFor(reader);
  await signIn(context, stranger);
  const before = (await contentRequests()).length;

  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.getByText("cannot be opened with this account")).toBeVisible();
  const url = new URL(page.url());
  expect(`${url.origin}${url.pathname}`).toBe(`${APP_ORIGIN}/login`);
  expect(url.searchParams.get("error")).toBe("artifact_unavailable");
  const sent = await requestsTo(artifactId, before);
  expect(sent.some((r) => r.status === 200)).toBe(false);
  expect(sent.some((r) => r.path === "/__portifact/callback")).toBe(false);
  const cookies = await context.cookies(artifactOrigin(artifactId));
  expect(cookies.some((c) => c.name === READ_COOKIE)).toBe(false);
});

test("removing a reader ends their access on the next request", async ({ page, context }) => {
  const reader = await createUser("Reader");
  const { owner, artifactId } = await restrictedFor(reader);
  await signIn(context, reader);
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();

  // The policy generation moves, so the claims in the cookie stop being trusted at once.
  expect(
    (await changeAccess({ ownerId: owner.userId, artifactId, removeReaders: [reader.email] })).ok,
  ).toBe(true);
  const before = (await contentRequests()).length;
  await page.reload();
  await expect(page.getByText("cannot be opened with this account")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("error")).toBe("artifact_unavailable");
  const sent = await requestsTo(artifactId, before);
  expect(sent.some((r) => r.status === 200)).toBe(false);
});

test("signing out of the app ends artifact access within 60 seconds", async ({ page, context }) => {
  const reader = await createUser("Reader");
  const { artifactId } = await restrictedFor(reader);
  await signIn(context, reader);
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();

  await page.goto(`${APP_ORIGIN}/`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect
    .poll(async () => (await context.cookies(APP_ORIGIN)).some((c) => c.name.includes("session")))
    .toBe(false);

  // Claims already issued are trusted for at most 60 seconds, and the cookie remains.
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.getByRole("heading", { name: "Board pack" })).toBeVisible();

  try {
    // Past the claims' 60 seconds the Worker rechecks D1: the dashboard session is gone, so it
    // clears the read cookie and starts the entry again, which needs a sign-in.
    await setContentClock(61_000);
    const before = (await contentRequests()).length;
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in to Portifact" })).toBeVisible();
    expect(loginNext(page.url())).toMatch(new RegExp(`^/read/${artifactId}\\?state=`));
    const sent = await requestsTo(artifactId, before);
    expect(sent.some((r) => r.status === 200)).toBe(false);
    const cookies = await context.cookies(artifactOrigin(artifactId));
    expect(cookies.some((c) => c.name === READ_COOKIE)).toBe(false);
  } finally {
    await setContentClock(0);
  }
});
