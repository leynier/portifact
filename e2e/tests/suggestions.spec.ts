// Suggest mode end to end (decision 0027), in every engine configuration where review works: a
// reader selects text in the artifact's frame, types the new text in the viewer and saves a
// suggestion; the frame never receives what was typed. The owner checks what applies, sees the
// built preview, accepts, and the jobs Worker publishes the new version. A change that cannot be
// applied goes to the change list, where the owner marks it applied.

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

const NAME = "Release notes";
const TYPED = "The quick brown dog jumps.";

test.beforeEach(async () => {
  await sql("delete from rate_limits where key like 'suggestion-plan:%'");
  await sql("delete from rate_limits where key like 'suggestion_accept:%'");
});

/** A signed-in page of its own, for a second person in the same test. */
async function pageOf(browser: Browser, user: { cookie: string }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await signIn(context, user as Parameters<typeof signIn>[1]);
  return context.newPage();
}

/** Turns Suggest mode on once the bridge in the frame said it can edit. */
async function suggestMode(page: Page) {
  const mode = page.getByRole("button", { name: "Suggest mode" });
  await mode.click();
  await expect(mode).toHaveAttribute("aria-pressed", "true");
}

/** Every applied job of the given topics, as the jobs Worker runs them. */
function runJobs(topics: string[]) {
  return control<{ ran: { topic: string; acked: boolean }[] }>("/jobs", { topics });
}

test("a reader suggests an edit in the frame and the owner accepts it into a new version", async ({
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
    type: "markdown",
    name: NAME,
    files: { "index.md": `# Notes\n\nThe quick brown cat jumps.\n` },
    readers: [reader.email],
  });

  // The reader: Suggest mode, a selection in the frame, the new text typed in the viewer.
  await signIn(context, reader);
  await openReview(page, artifactId, NAME);
  await suggestMode(page);
  const frame = await artifactFrame(page, artifactId);
  // Everything the page itself could read: the messages the viewer posts into the frame.
  await frame.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    window.addEventListener("message", (event) => seen.push(JSON.stringify(event.data)));
  });
  await frame.getByText("The quick brown cat jumps.").selectText();
  await page.getByRole("button", { name: "Suggest edit" }).click();
  const editor = page.getByRole("region", { name: "Suggest an edit to the selection" });
  const field = editor.getByRole("textbox", { name: "New text" });
  await expect(field).toHaveValue("The quick brown cat jumps.");
  await field.fill(TYPED);
  await expect(editor.getByText(TYPED)).toBeVisible();
  await editor.getByRole("textbox", { name: "Note" }).fill("A dog fits the story better");
  await field.press("Enter");
  await expect(editor.getByRole("heading", { name: "Check your suggestion" })).toBeVisible();
  await editor.getByRole("button", { name: "Save suggestion" }).click();
  await expect(page.getByText("Suggestion saved.")).toBeVisible();
  const posted = await frame.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  expect(posted.join("\n")).not.toContain("dog");

  const [row] = await sql<{ id: string; state: string; edit: string }>(
    "select id, suggestion_state as state, edit from annotation_threads where author_id = ? and kind = 'suggestion'",
    [reader.userId],
  );
  expect(row?.state).toBe("pending");
  expect(JSON.parse(row?.edit ?? "{}").operations[0].after).toBe(TYPED);
  const reviewerBlock = page.getByRole("region", { name: "Suggested edit" });
  await expect(reviewerBlock.getByText("Waiting for a decision")).toBeVisible();
  await expect(reviewerBlock.getByRole("button", { name: "Accept" })).toHaveCount(0);

  // The owner: what applies, the built preview, then accept by the plan's digest.
  const ownerPage = await pageOf(browser, owner);
  await openReview(ownerPage, artifactId, NAME);
  const block = ownerPage.getByRole("region", { name: "Suggested edit" });
  await block.getByRole("button", { name: "Check what applies" }).click();
  await expect(block.getByText(/^1 change applies automatically/)).toBeVisible();
  await block.getByRole("tab", { name: "Preview" }).click();
  const preview = block.getByTitle("Preview of the suggested edit");
  await expect(preview).toHaveAttribute("sandbox", "");
  await expect(
    ownerPage.frameLocator('iframe[title="Preview of the suggested edit"]').getByText(TYPED),
  ).toBeVisible();
  await block.getByRole("button", { name: "Accept" }).click();
  const dialog = ownerPage.getByRole("dialog", { name: "Accept this suggestion?" });
  await dialog.getByRole("button", { name: "Accept and publish" }).click();
  await expect(block.getByText("Being applied")).toBeVisible();

  await runJobs(["suggestion_accept"]);
  const [after] = await sql<{ current: string; state: string }>(
    "select a.current_version_id as current, t.suggestion_state as state from artifacts a join annotation_threads t on t.artifact_id = a.id where a.id = ? and t.id = ?",
    [artifactId, row?.id ?? ""],
  );
  expect(after?.state).toBe("accepted");
  expect(after?.current).not.toBe(versionId);
  await ownerPage.context().close();
});

test("an edit that cannot be applied goes to the change list, where the owner marks it", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "suggesting needs the bridge in the frame");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: NAME,
    files: { "index.md": `# Notes\n\nShip the **new** release today.\n` },
  });
  await signIn(context, owner);
  await openReview(page, artifactId, NAME);
  await suggestMode(page);
  const frame = await artifactFrame(page, artifactId);
  // The selection crosses the bold text, so it maps to no single place in the source.
  await frame.getByText(/Ship the/).selectText();
  await page.getByRole("button", { name: "Suggest edit" }).click();
  const editor = page.getByRole("region", { name: "Suggest an edit to the selection" });
  await editor.getByRole("textbox", { name: "New text" }).fill("Ship the next release today.");
  await editor.getByRole("textbox", { name: "Note" }).fill("Rename it");
  await editor.getByRole("button", { name: "Review" }).click();
  await editor.getByRole("button", { name: "Save suggestion" }).click();
  await expect(page.getByText("Suggestion saved.")).toBeVisible();

  const block = page.getByRole("region", { name: "Suggested edit" });
  await block.getByRole("button", { name: "Check what applies" }).click();
  await expect(block.getByText(/^0 changes apply automatically; 1 goes/)).toBeVisible();
  await block.getByRole("tab", { name: "Preview" }).click();
  await expect(block.getByText("No preview:")).toBeVisible();
  await block.getByRole("button", { name: "Accept" }).click();
  await page
    .getByRole("dialog", { name: "Accept this suggestion?" })
    .getByRole("button", { name: "Accept and publish" })
    .click();
  await runJobs(["suggestion_accept"]);

  await openDisclosure(page.getByText("Change list", { exact: true }));
  const list = page.locator("details").filter({ hasText: "Change list" });
  const item = list.getByRole("listitem").filter({ hasText: "Ship the next release today." });
  await expect(item.getByText("Open", { exact: true })).toBeVisible();
  await item.getByRole("button", { name: "Mark applied" }).click();
  await expect(page.getByText("Change list updated.")).toBeVisible();
  const [state] = await sql<{ state: string }>(
    "select state from change_items where artifact_id = ?",
    [artifactId],
  );
  expect(state?.state).toBe("applied");
});
