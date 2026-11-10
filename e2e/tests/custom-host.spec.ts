// Serving an artifact on its custom host in real browsers (decision 0006), with the stack's fake
// Cloudflare: the host serves the artifact itself with the bar off and ends in the viewer, which
// frames the custom host, with the bar on; an old `.dev` link goes to the custom host; a protected
// artifact signs a reader in and comes back to the custom host, with a host-only read cookie
// there. Third-party cookies are blocked in every project, as in the rest of the suite.

import { createUser, expect, fakeDomains, publish, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin, customHost } from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Handbook</title></head><body><h1>Handbook</h1><p id="where"></p><script>document.getElementById("where").textContent = location.host;</script></body></html>',
};

async function withDomain(accessMode: "public" | "restricted", bar: boolean) {
  const owner = await createUser("Owner");
  const published = await publish({
    ownerId: owner.userId,
    name: "Handbook",
    accessMode,
    bar,
    files: SITE,
  });
  const hostname = customHost(`h${published.artifactId}`);
  await fakeDomains({ attach: { hostname, artifactId: published.artifactId } });
  return { owner, ...published, hostname };
}

test("with the bar off the custom host serves the artifact itself, and old links go there", async ({
  page,
}) => {
  const { artifactId, hostname } = await withDomain("public", false);
  await page.goto(`https://${hostname}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Handbook" })).toBeVisible();
  await expect(page.locator("#where")).toHaveText(hostname);
  expect(new URL(page.url()).host).toBe(hostname);

  // The `.dev` address keeps working: a page visit goes to the same path on the custom host.
  await page.goto(`${artifactOrigin(artifactId)}/index.html?from=old`);
  expect(page.url()).toBe(`https://${hostname}/index.html?from=old`);
  await expect(page.locator("#where")).toHaveText(hostname);
});

test("with the bar on the custom host opens the viewer, which frames the custom host", async ({
  page,
}) => {
  const { artifactId, hostname } = await withDomain("public", true);
  await page.goto(`https://${hostname}/`);
  await page.waitForURL(`${APP_ORIGIN}/view/${artifactId}`);
  const frame = page.locator("iframe").first();
  await expect(frame).toHaveAttribute(
    "src",
    new RegExp(`^https://${hostname.replaceAll(".", "\\.")}/`),
  );
  await expect(
    page.frameLocator("iframe").first().getByRole("heading", { name: "Handbook" }),
  ).toBeVisible();
});

test("a reader of a protected artifact signs in and comes back to the custom host", async ({
  page,
  context,
}) => {
  const { artifactId, hostname, owner } = await withDomain("restricted", false);
  await signIn(context, owner);
  await page.goto(`https://${hostname}/`);
  await page.waitForURL(`https://${hostname}/`);
  await expect(page.locator("#where")).toHaveText(hostname);
  const cookies = await context.cookies(`https://${hostname}/`);
  const read = cookies.find((cookie) => cookie.name === "__Host-pf_read");
  expect(read?.domain).toBe(hostname);
  // The read session of the custom host is not the `.dev` origin's.
  expect(
    (await context.cookies(`${artifactOrigin(artifactId)}/`)).some(
      (c) => c.name === "__Host-pf_read",
    ),
  ).toBe(false);
  // The handoff the app stored went to that host and nowhere else.
  const handoffs = await sql<{ host: string }>(
    "SELECT host FROM read_handoffs WHERE artifact_id = ?",
    [artifactId],
  );
  expect(handoffs.map((row) => row.host)).toEqual([hostname]);
});

test("review mode runs in the viewer's frame on the custom host where the browser allows it", async ({
  page,
  context,
  engine,
}) => {
  const { artifactId, hostname, owner } = await withDomain("restricted", true);
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  await page.getByRole("heading", { level: 1, name: "Handbook" }).waitFor();
  const frameOf = () =>
    page
      .frames()
      .find(
        (f) => f.url().startsWith(`https://${hostname}/`) && !f.url().includes("/__portifact/"),
      );
  if (engine.reviewWorks) {
    await expect
      .poll(() => frameOf()?.url() ?? "", { timeout: 20_000 })
      .toBe(`https://${hostname}/`);
    const frame = frameOf();
    if (!frame) throw new Error("the viewer never framed the custom host");
    // The bridge is in the page: the review code redeemed on the custom host it was issued for.
    await expect(frame.locator('script[src^="/__portifact/bridge.js"]')).toHaveCount(1);
    await expect(frame.locator("#where")).toHaveText(hostname);
  } else {
    // Without partitioned cookies in frames the viewer falls back, as on `.dev`.
    await expect(page.getByRole("button", { name: /review tab/i }).first()).toBeVisible({
      timeout: 20_000,
    });
  }
  const issued = await sql<{ host: string }>(
    "SELECT host FROM review_handoffs WHERE artifact_id = ?",
    [artifactId],
  );
  expect(issued.length).toBeGreaterThan(0);
  expect(new Set(issued.map((row) => row.host))).toEqual(new Set([hostname]));
});
