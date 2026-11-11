// A workspace's maximum life of artifacts end to end (decision 0023): an admin sets one on the
// Policies page after confirming what it archives, and the page says when it takes effect. Before
// that date the maintenance runs archive nothing; past it, the artifact last published long ago
// is archived and the fresh one is not; and the archived one can be restored, with a new life.

import type { Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import {
  control,
  createUser,
  createWorkspace,
  expect,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const DAY = 86_400_000;

async function open(page: Page, path: string, title: string) {
  await page.goto(`${APP_ORIGIN}${path}`);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function axeInBothThemes(page: Page) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }
}

const site = (title: string) => ({
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`,
});

async function state(artifactId: string) {
  const [row] = await sql<{ state: string; expires_at: number | null }>(
    "select state, expires_at from artifacts where id = ?",
    [artifactId],
  );
  return row;
}

test("a maximum life archives only what reached it, after its notice period", async ({
  page,
  context,
}) => {
  // The scheduled runs below share the database with every other spec and archive at most 50
  // artifacts each, so waiting for this artifact's turn can take most of the default minute.
  test.slow();
  const admin = await createUser("Admin");
  const slug = `life-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await createWorkspace({ slug, name: "Retention team", admin });
  await sql("update owner_plans set plan = 'enterprise' where owner_id = ?", [workspace.id]);
  const old = await publish({
    ownerId: admin.userId,
    targetOwnerId: workspace.id,
    name: "Old plan",
    bar: false,
    files: site("Old plan"),
  });
  // Last published 60 days ago and renewed since.
  await sql("update versions set committed_at = ? where id = ?", [
    Date.now() - 60 * DAY,
    old.versionId,
  ]);
  await sql("update artifacts set expires_at = ? where id = ?", [
    Date.now() + 20 * DAY,
    old.artifactId,
  ]);
  const fresh = await publish({
    ownerId: admin.userId,
    targetOwnerId: workspace.id,
    name: "Fresh plan",
    bar: false,
    files: site("Fresh plan"),
  });
  await signIn(context, admin);
  await page.emulateMedia({ reducedMotion: "reduce" });

  await open(page, `/policies?workspace=${slug}`, "Policies");
  const life = page.getByRole("group", { name: "Maximum life of artifacts" });
  await life.getByRole("radio", { name: "Archive after a maximum life" }).check();
  await page.getByRole("textbox", { name: /Days after the last publish or restore/ }).fill("30");
  await axeInBothThemes(page);
  const dialog = page.getByRole("dialog");
  // The dialog opens once the preview answers; retry the click until it does.
  await expect(async () => {
    await page.getByRole("button", { name: "Save policies" }).click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await expect(dialog).toContainText(
    "1 active artifact is archived the day the maximum life takes effect",
  );
  await axeInBothThemes(page);
  await dialog.getByRole("button", { name: "Apply and save" }).click();
  await expect(page.getByText(/^A maximum life takes effect on /)).toBeVisible();
  await axeInBothThemes(page);

  // Before the effective date nothing is archived, though the old artifact has its deadline.
  for (const offsetMs of [0, DAY, 6 * DAY]) {
    await control("/maintenance", { offsetMs });
    expect((await state(old.artifactId))?.state).toBe("active");
  }
  const capped = await state(old.artifactId);
  expect(capped?.expires_at).toBeGreaterThan(Date.now() + 6 * DAY);
  expect(capped?.expires_at).toBeLessThanOrEqual(Date.now() + 7 * DAY);

  // Past it: the old one is archived, the fresh one is not. Each run archives at most 50 and
  // other tests share the database, so run it until this artifact's turn comes.
  await expect(async () => {
    await control("/maintenance", { offsetMs: 8 * DAY });
    expect((await state(old.artifactId))?.state).toBe("archived");
  }).toPass({ intervals: [0], timeout: 60_000 });
  expect((await state(fresh.artifactId))?.state).toBe("active");

  // The archived one can be restored, and gets a new life within the maximum.
  await open(page, `/artifacts/${old.artifactId}?workspace=${slug}`, "Old plan");
  const details = page.getByRole("region", { name: "Details" });
  // The press can land while the page settles, and the restore answers after it: press only
  // while the button is there, then wait for the state instead of reading it at once.
  await expect(async () => {
    const restore = details.getByRole("button", { name: "Restore" });
    if (await restore.isVisible()) await restore.click();
    await expect
      .poll(async () => (await state(old.artifactId))?.state, { timeout: 3_000 })
      .toBe("active");
  }).toPass({ timeout: 30_000 });
  const restored = await state(old.artifactId);
  expect(restored?.expires_at).toBeGreaterThan(Date.now() + 29 * DAY);
  await expect(
    details.getByText(
      "This workspace archives artifacts 30 days after their last publish or restore: the expiry includes it, and pinning is off.",
    ),
  ).toBeVisible();
  await axeInBothThemes(page);
});
