// Style suggestions end to end (decision 0027, delivery 3): a reader picks an element in the
// artifact's frame, chooses a property and a value from the allowlist in the viewer, sees the
// built preview and saves the suggestion; the frame never receives what was chosen. The owner
// accepts it, nothing is published, and the style waits on the change list.

import type { Browser, Page } from "@playwright/test";
import {
  artifactFrame,
  checkWhatApplies,
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

test("a reader suggests a style for an element, and the owner's acceptance lists it", async ({
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
  const pick = page.getByRole("button", { name: "Suggest a style" });
  await pick.click();
  await expect(pick).toHaveAttribute("aria-pressed", "true");
  await frame.locator("#lead").click();
  const panel = page.getByRole("region", { name: "Suggest a style for the element" });
  await expect(panel.getByText("We ship on Monday.")).toBeVisible();
  const value = panel.getByRole("textbox", { name: "New value of property 1" });
  await value.fill("transparent");
  await expect(panel.getByText("This value is not allowed for this property.")).toBeVisible();
  await value.fill("navy");
  await panel.getByRole("textbox", { name: "Note" }).fill("Calmer");
  await panel.getByRole("button", { name: "Review" }).click();
  await expect(panel.getByRole("heading", { name: "Check your suggestion" })).toBeVisible();
  await panel.getByRole("tab", { name: "Preview" }).click();
  await expect(panel.getByTitle("Preview of the suggested edit")).toHaveAttribute("sandbox", "");
  await expect(
    page.frameLocator('iframe[title="Preview of the suggested edit"]').locator("p"),
  ).toHaveCSS("color", "rgb(0, 0, 128)");
  await panel.getByRole("button", { name: "Save suggestion" }).click();
  await expect(page.getByText("Suggestion saved.")).toBeVisible();
  const posted = await frame.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  expect(posted.join("\n")).not.toContain("navy");
  expect(posted.join("\n")).not.toContain("Calmer");

  const [row] = await sql<{ id: string; edit: string }>(
    "select id, edit from annotation_threads where author_id = ? and kind = 'suggestion'",
    [reader.userId],
  );
  expect(JSON.parse(row?.edit ?? "{}").operations[0]).toMatchObject({
    kind: "style",
    changes: [{ property: "color", before: null, after: "navy" }],
  });

  const ownerPage = await pageOf(browser, owner);
  await openReview(ownerPage, artifactId, NAME);
  const block = ownerPage.getByRole("region", { name: "Suggested edit" });
  await checkWhatApplies(block, /^0 changes apply automatically; 1 goes/);
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
  await expect(list.locator("li li").filter({ hasText: "Text color to navy" })).toHaveCount(1);
  await ownerPage.context().close();
});
