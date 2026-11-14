// Structure suggestions end to end (decision 0027, delivery 4): a reader picks an element in the
// artifact's frame, chooses to move it and picks the destination in the frame, sees the built
// preview with the element moved and saves the suggestion; the frame never receives the note. The
// owner accepts it, nothing is published, and the move waits on the change list.

import type { Browser, Page } from "@playwright/test";
import {
  artifactFrame,
  control,
  createUser,
  expect,
  openDisclosure,
  openReview,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";

const NAME = "Launch page";
const PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Launch</title></head><body><h1 id="title">Launch</h1><p id="lead">We ship on Monday.</p></body></html>';

test.beforeEach(async () => {
  await sql("delete from rate_limits where key like 'suggestion-plan:%'");
  await sql("delete from rate_limits where key like 'suggestion_accept:%'");
});

async function pageOf(browser: Browser, user: { cookie: string }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await signIn(context, user as Parameters<typeof signIn>[1]);
  return context.newPage();
}

async function suggestMode(page: Page) {
  const mode = page.getByRole("button", { name: "Suggest mode" });
  await mode.click();
  await expect(mode).toHaveAttribute("aria-pressed", "true");
}

test("a reader suggests moving an element, and the owner's acceptance lists it", async ({
  page,
  context,
  engine,
  browser,
}) => {
  test.skip(!engine.reviewWorks, "suggesting needs the bridge in the frame");
  const owner = await createUser("Owner");
  const reader = await createUser("Reader");
  const { artifactId, versionId } = await publish({
    ownerId: owner.userId,
    type: "site",
    name: NAME,
    files: { "index.html": PAGE },
    readers: [reader.email],
  });

  await signIn(context, reader);
  await openReview(page, artifactId, NAME);
  await suggestMode(page);
  const frame = await artifactFrame(page, artifactId);
  await frame.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    window.addEventListener("message", (event) => seen.push(JSON.stringify(event.data)));
  });
  await page.getByRole("button", { name: "Move, duplicate or remove" }).click();
  await frame.locator("#lead").click();
  const panel = page.getByRole("region", {
    name: "Suggest moving, duplicating or removing the element",
  });
  await expect(panel.getByText("No destination chosen yet.")).toBeVisible();
  await panel.getByRole("button", { name: "Pick the destination" }).click();
  await frame.locator("#title").click();
  await expect(panel.getByText("No destination chosen yet.")).toHaveCount(0);
  await panel.getByRole("radio", { name: "Before it" }).check();
  await panel.getByRole("textbox", { name: "Note" }).fill("Lead first");
  await panel.getByRole("button", { name: "Review" }).click();
  await expect(panel.getByText("Move it before:")).toBeVisible();
  await panel.getByRole("tab", { name: "Preview" }).click();
  const preview = page.frameLocator('iframe[title="Preview of the suggested edit"]');
  await expect(preview.locator("body > :first-child")).toHaveText("We ship on Monday.");
  await panel.getByRole("button", { name: "Save suggestion" }).click();
  await expect(page.getByText("Suggestion saved.")).toBeVisible();
  const posted = await frame.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  expect(posted.join("\n")).not.toContain("Lead first");

  const [row] = await sql<{ edit: string }>(
    "select edit from annotation_threads where author_id = ? and kind = 'suggestion'",
    [reader.userId],
  );
  expect(JSON.parse(row?.edit ?? "{}").operations[0]).toMatchObject({
    kind: "structure",
    action: "move",
    destination: { place: "before" },
  });

  const ownerPage = await pageOf(browser, owner);
  await openReview(ownerPage, artifactId, NAME);
  const block = ownerPage.getByRole("region", { name: "Suggested edit" });
  await block.getByRole("button", { name: "Check what applies" }).click();
  await expect(block.getByText(/^0 changes apply automatically; 1 goes/)).toBeVisible();
  await block.getByRole("button", { name: "Accept" }).click();
  await ownerPage
    .getByRole("dialog", { name: "Accept this suggestion?" })
    .getByRole("button", { name: "Accept and publish" })
    .click();
  await control("/jobs", { topics: ["suggestion_accept"] });
  const [after] = await sql<{ current: string }>(
    "select current_version_id as current from artifacts where id = ?",
    [artifactId],
  );
  expect(after?.current).toBe(versionId);
  await ownerPage.reload();
  await openDisclosure(ownerPage.getByText("Change list", { exact: true }));
  const list = ownerPage.locator("details").filter({ hasText: "Change list" });
  await expect(list.getByText("Move it before:")).toBeVisible();
  await ownerPage.context().close();
});
