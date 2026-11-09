// The viewer with the Portifact bar end to end (plan section 8, "Flujo", decision of 2026-11-08):
// opening an artifact by its own link lands in the viewer on the app, with the bar, the artifact
// in a sandboxed frame and the comments sidebar, for HTML sites, Markdown and plain text. See
// "The viewer" in docs/security.md.

import { mkdir } from "node:fs/promises";
import type { Frame, Page } from "@playwright/test";
import {
  artifactFrame,
  contentRequests,
  createUser,
  expect,
  lastEmail,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_HOST, APP_ORIGIN, artifactOrigin, REVIEW_COOKIE } from "../src/hosts.ts";
import { TURNSTILE_MODE_COOKIE } from "../src/turnstile-fake.ts";

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
  test(`a ${artifact.type} artifact opened by its link shows the bar, and selected text is commented inline and edited`, async ({
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
    await expect(bar.getByRole("link", { name: "Manage" })).toBeVisible();
    // The bar names the artifact and its version and copies its link; no caption row remains.
    await expect(bar.getByRole("heading", { level: 1, name: artifact.name })).toBeVisible();
    await expect(bar.getByText("Version 1")).toBeVisible();
    await expect(bar.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(page.getByText(`${artifactId}.portifact-content.test`)).toHaveCount(0);
    await expect(page.getByText("Published by a user, not by Portifact")).toHaveCount(0);
    const sidebar = page.getByRole("complementary", { name: "Comments" });
    await expect(sidebar).toBeVisible();

    if (!engine.reviewWorks) {
      // The browser drops the frame's review cookie: general comments and the review tab remain.
      await expect(page.getByText("Review tools are not available in this browser")).toBeVisible();
      await sidebar.getByRole("button", { name: "Comment on the page" }).click();
      await sidebar.getByRole("textbox", { name: "Comment" }).fill("General note");
      await sidebar.getByRole("button", { name: "Post comment" }).click();
      await expect(sidebar.getByText("1 comment thread")).toBeVisible();
      // The artifact itself stays one click away, without the bar.
      await page.getByRole("link", { name: "Open without the Portifact bar" }).click();
      await expect(page).toHaveURL(`${artifactOrigin(artifactId)}/`);
      await expect(page.getByText(QUOTE).first()).toBeVisible();
      return;
    }

    const frame = await artifactFrame(page, artifactId);
    await expect(frame.getByText(QUOTE).first()).toBeVisible();
    // Select the quote in the artifact itself; a Comment control appears next to it, drawn by the
    // viewer over the frame, and nothing is posted.
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
    const offer = page.getByRole("button", { name: "Comment", exact: true });
    await expect(offer).toBeVisible();
    const offerBox = await offer.boundingBox();
    const frameBox = await page.locator("iframe").boundingBox();
    // In the page's coordinates, like the others: Playwright maps boxes out of frames.
    const quoteBox = await frame.getByText(QUOTE).first().boundingBox();
    if (!offerBox || !frameBox || !quoteBox) throw new Error("no layout");
    // Next to the selection, inside the frame: just below the quote's line.
    expect(offerBox.y).toBeGreaterThan(quoteBox.y);
    expect(offerBox.y).toBeLessThan(quoteBox.y + quoteBox.height + 60);
    expect(offerBox.x).toBeGreaterThanOrEqual(frameBox.x);
    expect(offerBox.x + offerBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width);
    expect(await threadsBy(owner.userId)).toHaveLength(0);
    await offer.click();
    const composer = page.getByRole("region", { name: "Comment on the selection" });
    const box = composer.getByRole("textbox", { name: "Comment" });
    await expect(box).toBeFocused();
    await box.fill("Say hello to the old world too");
    await box.press("Enter");
    await expect(sidebar.getByText("1 comment thread")).toBeVisible();
    await expect(composer).toBeHidden();
    const [thread] = await threadsBy(owner.userId);
    expect(JSON.parse(thread?.target ?? "{}")).toMatchObject({
      anchor: { kind: "text", quote: { exact: QUOTE } },
    });

    // Edit the comment from the sidebar, through the message's menu.
    const article = sidebar.getByRole("article", { name: "Thread 1" });
    await article.getByRole("button", { name: "More actions for the message from You" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await article.getByRole("textbox", { name: "Message" }).fill("Say hello to the old world");
    await article.getByRole("button", { name: "Save" }).click();
    await expect(article.getByText("Say hello to the old world", { exact: true })).toBeVisible();
    await expect(article.getByText(/Edited/)).toBeVisible();
    const [message] = await sql<{ body: string; revision: number }>(
      "SELECT body, revision FROM annotation_messages WHERE author_id = ?",
      [owner.userId],
    );
    expect(message).toEqual({ body: "Say hello to the old world", revision: 2 });
    // The thread is located in the artifact, so the sidebar can point at it.
    await expect(
      sidebar.getByRole("article", { name: "Thread 1" }).getByRole("button", {
        name: "Show in the artifact",
      }),
    ).toBeVisible();
  });
}

/** Selects `quote` in the frame's page as a reader would, so the bridge reports it. */
async function selectQuote(frame: Awaited<ReturnType<typeof artifactFrame>>, quote: string) {
  await frame.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
  }, quote);
}

test("a visitor's first inline comments pass the human check invisibly, or in the composer when asked", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "the frame keeps no review session in this configuration");
  const owner = await createUser("Owner");
  const visitor = await createUser("Visitor");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    accessMode: "public",
    ...SITE,
  });
  await signIn(context, visitor);
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  const frame = await artifactFrame(page, artifactId);
  await expect(frame.getByText(QUOTE).first()).toBeVisible();
  await expect(page.getByText("Connecting to the page")).toBeHidden();
  const composer = page.getByRole("region", { name: "Comment on the selection" });

  // Most visitors never see the check: it ran while they wrote, and Save posts at once.
  await selectQuote(frame, QUOTE);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await composer.getByRole("textbox", { name: "Comment" }).fill("First thought");
  await composer.getByRole("button", { name: "Save" }).click();
  await expect(composer).toBeHidden();
  await expect(page.getByText("Verify you are human")).toHaveCount(0);
  await expect(page.getByText("1 comment thread")).toBeVisible();

  // When Cloudflare asks for an interaction, the challenge shows inside the composer, and the
  // comment is posted as soon as it is solved.
  await context.addCookies([
    { name: TURNSTILE_MODE_COOKIE, value: "interactive", domain: APP_HOST, path: "/" },
  ]);
  await selectQuote(frame, QUOTE);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Second thought");
  await expect(composer.getByText(/quick check that you are human/)).toBeVisible();
  await composer.getByRole("button", { name: "Save" }).click();
  // Solving it posts the comment, which closes the composer at once.
  await composer.getByRole("checkbox", { name: /Verify you are human/ }).click();
  await expect(composer).toBeHidden();
  await expect(page.getByText("2 comment threads")).toBeVisible();
  const posted = await sql<{ id: string }>(
    "SELECT id FROM annotation_threads WHERE author_id = ?",
    [visitor.userId],
  );
  expect(posted).toHaveLength(2);
});

/** Where `text` is drawn in the frame, in the page's coordinates. */
async function textBox(page: Page, frame: Frame, text: string) {
  const inFrame = await frame.evaluate((quote) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(quote) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + quote.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    return null;
  }, text);
  const frameBox = await page.locator("iframe").boundingBox();
  if (!inFrame || !frameBox) throw new Error("no layout");
  return { ...inFrame, x: frameBox.x + inFrame.x, y: frameBox.y + inFrame.y };
}

/** Comments inline on `quote`, as the reader would: select it, Comment, type and save. */
async function commentOn(page: Page, frame: Frame, quote: string, body: string) {
  await selectQuote(frame, quote);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const composer = page.getByRole("region", { name: "Comment on the selection" });
  await composer.getByRole("textbox", { name: "Comment" }).fill(body);
  await composer.getByRole("button", { name: "Save" }).click();
  await expect(composer).toBeHidden();
}

/** Screenshots for review, only when PORTIFACT_SHOTS names a folder. */
async function shoot(page: Page, name: string) {
  const folder = process.env.PORTIFACT_SHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  // Colors ease for 150 ms after a theme change.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${folder}/${name}.png` });
}

test("overlapping comments are layered highlights: a click selects every thread under it, which are replied to, resolved and edited", async ({
  page,
  context,
  engine,
  browserName,
}) => {
  test.skip(!engine.reviewWorks, "the frame keeps no review session in this configuration");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({ ownerId: owner.userId, ...SITE });
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  const frame = await artifactFrame(page, artifactId);
  await expect(frame.getByText(QUOTE).first()).toBeVisible();
  await expect(page.getByText("Connecting to the page")).toBeHidden();
  const sidebar = page.getByRole("complementary", { name: "Comments" });

  // Two threads on the same text: the whole sentence, and one word inside it.
  await commentOn(page, frame, "brave new world", "The whole phrase reads well");
  await commentOn(page, frame, "new", "Is new the right word?");
  await expect(sidebar.getByText("2 comment threads")).toBeVisible();
  // No numbered markers over the text: nothing of Portifact's to tab to in the artifact.
  await expect(frame.locator("portifact-review")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Open thread/ })).toHaveCount(0);

  // A click on the overlap selects both threads, shown together, the inner one first.
  const word = await textBox(page, frame, "new");
  await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2);
  const group = sidebar.getByRole("region", { name: "2 threads on the text you clicked" });
  await expect(group).toBeVisible();
  const cards = group.getByRole("article");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("aria-labelledby", /title$/);
  await expect(cards.nth(0)).toHaveAccessibleName("Thread 2");
  await expect(cards.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(cards.nth(1)).toHaveAccessibleName("Thread 1");
  await shoot(page, `${browserName}-desktop-light-overlap`);
  await page.emulateMedia({ colorScheme: "dark" });
  await shoot(page, `${browserName}-desktop-dark-overlap`);
  await page.emulateMedia({ colorScheme: "light" });

  // A click on the sentence outside the word selects only the outer thread.
  const brave = await textBox(page, frame, "brave");
  await page.mouse.click(brave.x + brave.width / 2, brave.y + brave.height / 2);
  await expect(group).toBeHidden();
  await expect(sidebar.getByRole("article", { name: "Thread 1" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  // Reply in the outer thread from its reply field.
  const outer = sidebar.getByRole("article", { name: "Thread 1" });
  await outer.getByRole("button", { name: "Reply" }).click();
  await outer.getByRole("textbox", { name: "Reply" }).fill("Agreed");
  await outer.getByRole("button", { name: "Post reply" }).click();
  await expect(outer.getByText("Agreed", { exact: true })).toBeVisible();

  // Resolve the inner thread from its icon button; it folds.
  const inner = sidebar.getByRole("article", { name: "Thread 2" });
  await inner.getByRole("button", { name: "Resolve" }).click();
  await expect(inner.getByText("Resolved")).toBeVisible();
  await expect(inner.getByRole("button", { name: "Reopen" })).toBeVisible();

  // Edit the outer thread's first message through its menu.
  await outer
    .getByRole("button", { name: "More actions for the message from You" })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await outer.getByRole("textbox", { name: "Message" }).fill("The whole phrase reads very well");
  await outer.getByRole("button", { name: "Save" }).click();
  await expect(outer.getByText("The whole phrase reads very well")).toBeVisible();
  await expect(outer.getByText(/Edited/)).toBeVisible();
  const bodies = await sql<{ body: string }>(
    "SELECT body FROM annotation_messages WHERE author_id = ? ORDER BY created_at",
    [owner.userId],
  );
  expect(bodies.map((row) => row.body)).toEqual([
    "The whole phrase reads very well",
    "Is new the right word?",
    "Agreed",
  ]);

  // On a phone, the bar keeps the toggle and a menu, and comments open over the artifact.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  const phoneFrame = await artifactFrame(page, artifactId);
  await expect(page.getByText("Connecting to the page")).toBeHidden();
  const bar = page.getByRole("banner");
  await expect(bar.getByRole("button", { name: /^Comments/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: "More" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Copy link" })).toBeHidden();
  await expect(sidebar).toBeHidden();
  await shoot(page, `${browserName}-mobile-light-artifact`);
  // A click on the overlap opens the comments over the artifact, with both threads together.
  const phoneWord = await textBox(page, phoneFrame, "new");
  await page.mouse.click(phoneWord.x + phoneWord.width / 2, phoneWord.y + phoneWord.height / 2);
  await expect(sidebar).toBeVisible();
  await expect(
    sidebar.getByRole("region", { name: "2 threads on the text you clicked" }),
  ).toBeVisible();
  await shoot(page, `${browserName}-mobile-light-overlap`);
  await page.emulateMedia({ colorScheme: "dark" });
  await shoot(page, `${browserName}-mobile-dark-overlap`);
  await page.emulateMedia({ colorScheme: "light" });
  await sidebar.getByRole("button", { name: "Close comments" }).click();
  await expect(sidebar).toBeHidden();
  await expect(bar.getByRole("button", { name: /^Comments/ })).toBeFocused();
});

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
  await expect(frame.getByText("Install it")).toBeVisible();
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
  await expect(page.getByRole("heading", { level: 1, name: "Open plan" })).toBeVisible();
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

  // Signing in with an email code on the login page comes back to the same view, now with the
  // comments and a review session in the frame.
  const reader = await createUser("Reader");
  await page.getByLabel("Email address").fill(reader.email);
  await page.getByLabel("Email address").press("Enter");
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  const code = /^\d{6}$/m.exec((await lastEmail(reader.email)).text)?.[0] ?? "";
  await page.getByLabel("6-digit code").fill(code);
  await page.getByLabel("6-digit code").press("Enter");
  await expect(page).toHaveURL(`${APP_ORIGIN}/view/${artifactId}`);
  await expect(
    page.getByRole("banner").getByRole("link", { name: "Your artifacts" }),
  ).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Comment on the page" })).toBeVisible();
});

test("a protected artifact opens in the viewer once the reader signed in, on the page of the link", async ({
  page,
  context,
  engine,
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
  if (engine.reviewWorks) {
    const frame = await artifactFrame(page, artifactId);
    await expect(frame.getByText(QUOTE)).toBeVisible();
  } else {
    // No session in the frame: the reader still reaches the content without the bar, through
    // the usual read handoff.
    await page.getByRole("link", { name: "Open without the Portifact bar" }).click();
    await expect(page).toHaveURL(`${artifactOrigin(artifactId)}/index.html?from=link`);
    await expect(page.getByText(QUOTE)).toBeVisible();
  }
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
