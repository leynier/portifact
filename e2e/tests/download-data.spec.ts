// Download your data end to end (decision 0022, second delivery): an owner whose Pro plan was
// removed sees the grace notice on two pages, opens the download page from it, reads what goes on
// which date, and downloads a previous version that the free plan would no longer keep.

import { axeViolations } from "../src/axe.ts";
import {
  control,
  createUser,
  expect,
  publish,
  routeStorage,
  signIn,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const site = (text: string) => ({
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>${text}</h1></main></body></html>`,
  "notes.txt": `${text}\n`,
});

test("an owner in grace sees the notice, opens the download page and downloads an old version", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  await control("/operator", { argv: ["set-plan", owner.userId, "pro"] });
  const first = await publish({
    ownerId: owner.userId,
    name: "Roadmap",
    bar: false,
    files: site("One"),
  });
  const second = await publish({
    ownerId: owner.userId,
    name: "Roadmap",
    bar: false,
    files: site("Two"),
    update: { artifactId: first.artifactId, baseVersionId: first.versionId },
  });
  await publish({
    ownerId: owner.userId,
    name: "Roadmap",
    bar: false,
    files: site("Three"),
    update: { artifactId: first.artifactId, baseVersionId: second.versionId },
  });
  await control("/operator", { argv: ["remove-plan", owner.userId] });

  await signIn(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await routeStorage(page);

  // The notice is on every page of the space.
  for (const path of ["/", "/usage"]) {
    await page.goto(`${APP_ORIGIN}${path}`);
    // The visible notice (its live region, read by screen readers, holds the same words).
    await expect(
      page.locator("p.font-semibold", { hasText: /^What the Pro plan kept is held until / }),
    ).toBeVisible();
  }
  expect(await axeViolations(page)).toEqual([]);

  // From the notice to the download page, which says what goes on which date.
  await page.getByRole("link", { name: "Download your data" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Download your data" })).toBeVisible();
  const forecast = page.getByRole("table", {
    name: "What is deleted when the grace ends, and from when",
  });
  await expect(forecast.getByRole("rowheader", { name: "Previous versions" })).toBeVisible();
  await expect(forecast.getByRole("row").filter({ hasText: "Previous versions" })).toContainText(
    "2",
  );

  // The page is not in the side menu: Settings leads to it, and it leads back there.
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Download your data" }),
  ).toHaveCount(0);
  await page.getByRole("main").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const yourData = page.getByRole("region", { name: "Your data" });
  await expect(yourData).toContainText("To take out what your personal space holds");
  await yourData.getByRole("link", { name: "Download this space's data" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Download your data" })).toBeVisible();

  // A previous version, which the free plan would no longer keep, downloads as a checked ZIP.
  const roadmap = page.getByText("Roadmap: 3 retained versions");
  const version1 = page.getByRole("button", { name: "Download files of version 1" });
  await expect(async () => {
    await roadmap.click();
    await expect(version1).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const download = page.waitForEvent("download");
  await version1.click();
  expect((await download).suggestedFilename()).toBe("Roadmap-v1.zip");
  expect(await axeViolations(page)).toEqual([]);
});
