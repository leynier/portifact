// The screen reader pass of Suggest mode (decision 0027, release checks), done with the keyboard
// alone and checked on the accessibility tree the browser exposes to assistive technology: names,
// roles and states (`toMatchAriaSnapshot`), where focus goes, and what the polite live regions
// announce. It walks the path a person who cannot select in the frame takes: the mode switch, the
// sidebar's text search, the editor, its review tabs and Save, for the owner on a site and for a
// reviewer on a site and on a document; then the owner's draft panel.

import { expect as baseExpect, type Page } from "@playwright/test";
import {
  artifactFrame,
  createUser,
  expect,
  openReview,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";

const NAME = "Release notes";
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title></head><body><main><h1>Notes</h1><p>The quick brown cat jumps.</p></main></body></html>`;

test.beforeEach(async () => {
  await sql("delete from rate_limits where key like 'suggestion-plan:%'");
});

/** The text a polite live region announced last, among the page's status regions. */
async function announced(page: Page, text: string | RegExp) {
  await baseExpect(page.getByRole("status").filter({ hasText: text }).first()).toBeAttached();
}

/** The accessible name of the focused element, as the browser computes it. */
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLInputElement | null;
    return (
      element?.getAttribute("aria-label") ??
      element?.labels?.[0]?.textContent ??
      element?.textContent ??
      ""
    );
  });

test("Suggest mode works from the keyboard alone, with names, states and announcements", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "Suggest mode needs the bridge in the frame");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: NAME,
    files: { "index.html": PAGE },
  });
  await signIn(context, owner);
  await openReview(page, artifactId, NAME);
  await artifactFrame(page, artifactId);

  // The mode switch: a labelled group of toggle buttons whose pressed state is announced.
  const group = page.getByRole("group", { name: "Review mode" });
  await expect(group).toMatchAriaSnapshot(`
    - group "Review mode":
      - button "Comment mode" [pressed]
      - button "Suggest mode"
      - button "Edit mode"
  `);
  await group.getByRole("button", { name: "Suggest mode" }).focus();
  await page.keyboard.press("Enter");
  await expect(group.getByRole("button", { name: "Suggest mode" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await announced(page, /Suggest mode is on/);

  // The text search: a landmark with a labelled field, results announced politely.
  const search = page.getByRole("region", { name: "Suggest a text change" });
  await expect(search.getByRole("search")).toBeVisible();
  await search.getByRole("textbox", { name: "Text to find" }).focus();
  await page.keyboard.type("brown cat");
  await page.keyboard.press("Enter");
  await announced(page, "1 place found.");
  await expect(search.getByRole("list", { name: "Places with the text" })).toMatchAriaSnapshot(`
    - list "Places with the text":
      - listitem:
        - paragraph:
          - text: Notes The quick
          - mark: brown cat
          - text: jumps.
        - button "Change the text at place 1"
  `);
  await search.getByRole("button", { name: "Change the text at place 1" }).focus();
  await page.keyboard.press("Enter");

  // The editor: a labelled region; focus lands in its field, named by its visible label.
  const editor = page.getByRole("region", { name: "Suggest an edit to the selection" });
  await expect(editor.getByRole("heading", { name: "Suggest an edit" })).toBeVisible();
  await expect.poll(() => focusedName(page)).toContain("New text");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("quick brown dog");
  // The change is text with labels, never color alone.
  await expect(editor.getByRole("definition").first()).toHaveText("brown cat");
  await expect(editor.getByRole("term").first()).toHaveText(/Removed/);
  await page.keyboard.press("Tab");
  await expect.poll(() => focusedName(page)).toContain("Note");
  await page.keyboard.type("A dog fits better");
  await editor.getByRole("textbox", { name: "New text" }).focus();
  await page.keyboard.press("Enter");

  // The review: a heading, then a labelled tab list moved with the arrow keys.
  await expect(editor.getByRole("heading", { name: "Check your suggestion" })).toBeVisible();
  const tabs = editor.getByRole("tablist", { name: "Your change" });
  await expect(tabs).toMatchAriaSnapshot(`
    - tablist "Your change":
      - tab "Change" [selected]
      - tab "Preview"
  `);
  await tabs.getByRole("tab", { name: "Change" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
  await expect(editor.getByRole("tabpanel", { name: "Preview" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await editor.getByRole("button", { name: "Save suggestion" }).focus();
  await page.keyboard.press("Enter");
  await announced(page, "Suggestion saved.");

  // The thread says it is a suggestion and its state in words.
  const block = page.getByRole("region", { name: "Suggested edit" });
  await expect(block.getByText("Suggestion", { exact: true })).toBeVisible();
  await expect(block.getByText("Waiting for a decision")).toBeVisible();
});

for (const kind of ["site", "document"] as const) {
  test(`a reviewer finds and changes text on a ${kind} from the keyboard alone`, async ({
    page,
    context,
    engine,
  }) => {
    test.skip(!engine.reviewWorks, "Suggest mode needs the bridge in the frame");
    // The page's text comes from the server to whoever may suggest, so a reader who may comment
    // searches a site they may not download and a document's rendered page alike.
    const owner = await createUser("Owner");
    const reader = await createUser("Reader");
    const { artifactId } = await publish({
      ownerId: owner.userId,
      name: NAME,
      ...(kind === "site"
        ? { files: { "index.html": PAGE } }
        : {
            type: "markdown" as const,
            files: { "index.md": "# Notes\n\nThe quick brown cat jumps.\n" },
          }),
      readers: [reader.email],
    });
    await signIn(context, reader);
    await openReview(page, artifactId, NAME);
    await artifactFrame(page, artifactId);

    const group = page.getByRole("group", { name: "Review mode" });
    await group.getByRole("button", { name: "Suggest mode" }).focus();
    await page.keyboard.press("Enter");
    await announced(page, /Suggest mode is on/);
    const search = page.getByRole("region", { name: "Suggest a text change" });
    await search.getByRole("textbox", { name: "Text to find" }).focus();
    await page.keyboard.type("brown cat");
    await page.keyboard.press("Enter");
    await announced(page, "1 place found.");
    await expect(search.getByRole("list", { name: "Places with the text" })).toMatchAriaSnapshot(`
      - list "Places with the text":
        - listitem:
          - paragraph:
            - text: /The quick/
            - mark: brown cat
            - text: jumps.
          - button "Change the text at place 1"
    `);
    await search.getByRole("button", { name: "Change the text at place 1" }).focus();
    await page.keyboard.press("Enter");

    const editor = page.getByRole("region", { name: "Suggest an edit to the selection" });
    await expect.poll(() => focusedName(page)).toContain("New text");
    await expect(editor.getByRole("textbox", { name: "New text" })).toHaveValue("brown cat");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("brown dog");
    await page.keyboard.press("Tab");
    await page.keyboard.type("A dog fits better");
    await editor.getByRole("textbox", { name: "New text" }).focus();
    await page.keyboard.press("Enter");
    await editor.getByRole("button", { name: "Save suggestion" }).focus();
    await page.keyboard.press("Enter");
    await announced(page, "Suggestion saved.");
    const block = page.getByRole("region", { name: "Suggested edit" });
    await expect(block.getByText("Waiting for a decision")).toBeVisible();
    // A reviewer decides nothing.
    await expect(block.getByRole("button", { name: "Accept" })).toHaveCount(0);
  });
}

test("the owner's draft is reachable and announced from the keyboard", async ({
  page,
  context,
  engine,
}) => {
  test.skip(!engine.reviewWorks, "Edit mode needs the bridge in the frame");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: NAME,
    files: { "index.html": PAGE },
  });
  await signIn(context, owner);
  await openReview(page, artifactId, NAME);
  await artifactFrame(page, artifactId);
  const group = page.getByRole("group", { name: "Review mode" });
  await expect(group).toMatchAriaSnapshot(`
    - group "Review mode":
      - button "Comment mode" [pressed]
      - button "Suggest mode"
      - button "Edit mode"
  `);
  await group.getByRole("button", { name: "Edit mode" }).focus();
  await page.keyboard.press("Enter");
  await announced(page, /Edit mode is on/);

  const search = page.getByRole("region", { name: "Suggest a text change" });
  await search.getByRole("textbox", { name: "Text to find" }).focus();
  await page.keyboard.type("quick");
  await page.keyboard.press("Enter");
  await search.getByRole("button", { name: "Change the text at place 1" }).click();
  const editor = page.getByRole("region", { name: "Suggest an edit to the selection" });
  await expect(editor.getByRole("heading", { name: "Change the text" })).toBeVisible();
  // No note in Edit mode.
  await expect(editor.getByRole("textbox", { name: "Note" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("slow");
  await page.keyboard.press("Enter");
  await editor.getByRole("button", { name: "Add to draft" }).focus();
  await page.keyboard.press("Enter");
  await announced(page, "Added to your draft.");

  const panel = page.getByRole("region", { name: "Your draft" });
  await expect(panel).toMatchAriaSnapshot(`
    - region "Your draft":
      - heading "Your draft" [level=3]
      - text: 1 change
      - list "Changes in your draft":
        - listitem:
          - term: /Removed/
          - definition: quick
          - term: /Added/
          - definition: slow
          - button "Remove change 1"
      - button "Check what applies"
      - button "Discard"
  `);
  await panel.getByRole("button", { name: "Discard" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Discard this draft?" });
  await expect(dialog).toBeVisible();
  // The dialog takes focus; Escape cancels it and focus returns to the control that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(panel.getByRole("button", { name: "Discard" })).toBeFocused();
});
