// The viewer with the Portifact bar end to end (plan section 8, "Flujo", decision of 2026-11-08):
// opening an artifact by its own link lands in the viewer on the app, with the bar, the artifact
// in a sandboxed frame and the comments sidebar, for HTML sites, Markdown and plain text. See
// "The viewer" in docs/security.md.

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
import { APP_ORIGIN, artifactOrigin, REVIEW_COOKIE } from "../src/hosts.ts";

const QUOTE = "Hello brave new world";

const ARTIFACTS = [
  {
    type: "site" as const,
    name: "Launch site",
    files: {
      "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launch site</title></head><body><main><h1>Launch site</h1><p id="intro">${QUOTE}</p></main></body></html>`,
    },
  },
  {
    type: "markdown" as const,
    name: "Launch notes",
    files: { "notes.md": `# Launch notes\n\n${QUOTE}, and goodbye.\n` },
  },
  {
    type: "text" as const,
    name: "Launch log",
    files: { "log.txt": `${QUOTE}\nSecond line of the log.\n` },
  },
];

const SITE = ARTIFACTS[0] as (typeof ARTIFACTS)[number];

async function threadsBy(userId: string) {
  return sql<{ target: string }>("SELECT target FROM annotation_threads WHERE author_id = ?", [
    userId,
  ]);
}

for (const artifact of ARTIFACTS) {
  test(`a ${artifact.type} artifact opened by its link shows the bar, and selected text becomes a comment in the sidebar`, async ({
    page,
    context,
    engine,
  }) => {
    const owner = await createUser("Owner");
    const { artifactId } = await publish({ ownerId: owner.userId, ...artifact });
    await signIn(context, owner);

    await page.goto(`${artifactOrigin(artifactId)}/`);
    await expect(page).toHaveURL(`${APP_ORIGIN}/view/${artifactId}`);
    const bar = page.getByRole("banner");
    await expect(bar.getByRole("heading", { level: 1, name: artifact.name })).toBeVisible();
    await expect(bar.getByText("Version 1")).toBeVisible();
    await expect(bar.getByRole("link", { name: "Manage" })).toBeVisible();
    const sidebar = page.getByRole("complementary", { name: "Comments" });
    await expect(sidebar).toBeVisible();

    if (!engine.reviewWorks) {
      // The browser drops the frame's review cookie: general comments and the review tab remain.
      await expect(page.getByText("Review tools are not available in this browser")).toBeVisible();
      await sidebar.getByRole("button", { name: "Comment on the page" }).click();
      await sidebar.getByRole("textbox", { name: "Comment" }).fill("General note");
      await sidebar.getByRole("button", { name: "Post comment" }).click();
      await expect(sidebar.getByText("1 comment thread")).toBeVisible();
      return;
    }

    const frame = await artifactFrame(page, artifactId);
    await frame.getByText(QUOTE).first().waitFor();
    // Select the quote in the artifact itself; the sidebar offers a comment, nothing is posted.
    await frame.evaluate((quote) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(quote) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + quote.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
    }, QUOTE);
    await sidebar.getByRole("button", { name: "Comment on the selection" }).click();
    expect(await threadsBy(owner.userId)).toHaveLength(0);
    await sidebar.getByRole("textbox", { name: "Comment" }).fill("Say hello to the old world too");
    await sidebar.getByRole("button", { name: "Post comment" }).click();
    await expect(sidebar.getByText("1 comment thread")).toBeVisible();
    const [thread] = await threadsBy(owner.userId);
    expect(JSON.parse(thread?.target ?? "{}")).toMatchObject({
      anchor: { kind: "text", quote: { exact: QUOTE } },
    });
    // The thread is located in the artifact, so the sidebar can point at it.
    await expect(
      sidebar.getByRole("article", { name: "Thread 1" }).getByRole("button", {
        name: "Show in the artifact",
      }),
    ).toBeVisible();
  });
}

test("the viewer keeps the page, query and fragment of the link it was opened with", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "the frame shows the review notice in this configuration");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Two pages",
    files: {
      "index.html": "<!doctype html><title>Home</title><h1>Home</h1>",
      "docs/guide.html":
        '<!doctype html><title>Guide</title><h1>Guide</h1><p id="install">Install it</p>',
    },
  });
  await signIn(context, owner);
  await page.goto(`${artifactOrigin(artifactId)}/docs/guide.html?step=2#install`);
  await expect(page).toHaveURL(
    `${APP_ORIGIN}/view/${artifactId}?path=%2Fdocs%2Fguide.html%3Fstep%3D2#install`,
  );
  const frame = await artifactFrame(page, artifactId);
  expect(frame.url()).toBe(`${artifactOrigin(artifactId)}/docs/guide.html?step=2#install`);
  await expect(frame.getByRole("heading", { name: "Guide" })).toBeVisible();
});

test("an anonymous visitor of a public artifact reads it in the viewer and is asked to sign in to comment", async ({
  page,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    accessMode: "public",
    ...SITE,
    name: "Open plan",
  });
  const before = (await contentRequests()).length;
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page).toHaveURL(`${APP_ORIGIN}/view/${artifactId}`);
  const bar = page.getByRole("banner");
  await expect(bar.getByRole("heading", { level: 1, name: "Open plan" })).toBeVisible();
  await expect(bar.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(bar.getByRole("link", { name: "Manage" })).toHaveCount(0);

  // The artifact itself, without the bridge or a review session: nothing names the visitor.
  const frame = await artifactFrame(page, artifactId);
  await expect(frame.getByText(QUOTE)).toBeVisible();
  expect(await frame.locator('script[src*="/__portifact/bridge.js"]').count()).toBe(0);
  const sent = (await contentRequests()).slice(before).filter((r) => r.host.startsWith(artifactId));
  expect(sent.some((r) => r.cookieNames.includes(REVIEW_COOKIE))).toBe(false);

  const sidebar = page.getByRole("complementary", { name: "Comments" });
  const signInLink = sidebar.getByRole("link", { name: "Sign in to comment" });
  await expect(signInLink).toBeVisible();
  expect(await signInLink.getAttribute("href")).toBe(
    `/login?${new URLSearchParams({ next: `/view/${artifactId}` })}`,
  );
  await signInLink.click();
  await expect(page).toHaveURL(
    `${APP_ORIGIN}/login?${new URLSearchParams({ next: `/view/${artifactId}` })}`,
  );
});

test("a protected artifact opens in the viewer once the reader signed in, on the page of the link", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  const reader = await createUser("Reader");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    readers: [reader.email],
    ...SITE,
    name: "Board pack",
  });
  // Anonymous: sign-in first, and the viewer is never named before access is checked.
  await page.goto(`${artifactOrigin(artifactId)}/index.html?from=link`);
  await expect(page).toHaveURL(/\/login\?next=%2Fread%2F/);

  await signIn(context, reader);
  await page.goto(`${artifactOrigin(artifactId)}/index.html?from=link`);
  await expect(page).toHaveURL(`${APP_ORIGIN}/view/${artifactId}?path=%2Findex.html%3Ffrom%3Dlink`);
  await expect(page.getByRole("heading", { level: 1, name: "Board pack" })).toBeVisible();
  await expect(
    page.getByRole("banner").getByRole("link", { name: "Report this artifact" }),
  ).toBeVisible();
});

test("with the bar off, the artifact's link opens the artifact itself", async ({ page }) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    accessMode: "public",
    bar: false,
    ...SITE,
  });
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page).toHaveURL(`${artifactOrigin(artifactId)}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Launch site" })).toBeVisible();
  await expect(page.getByRole("banner")).toHaveCount(0);
});
