// Download your data end to end (decision 0022, second delivery): an owner whose Pro plan was
// removed sees the grace notice on two pages, opens the download page from it, reads what goes on
// which date, and downloads a previous version that the free plan would no longer keep.

import { readFile } from "node:fs/promises";
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

  // The artifact's records and the space's records come from the real read routes, as JSON.
  const records = page.waitForEvent("download");
  await page.getByRole("button", { name: "Records (JSON) of Roadmap" }).click();
  const recordsFile = await records;
  expect(recordsFile.suggestedFilename()).toBe(`${first.artifactId}-records.json`);
  const artifactRecords = JSON.parse(await readFile(await recordsFile.path(), "utf8"));
  expect(artifactRecords).toMatchObject({
    format: 1,
    kind: "artifact",
    artifact: { id: first.artifactId, name: "Roadmap" },
    access: { mode: "restricted" },
    commentHistory: [],
  });
  const space = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download the space's records (JSON)" }).click();
  const spaceFile = await space;
  expect(spaceFile.suggestedFilename()).toBe("personal-space-records.json");
  const spaceRecords = JSON.parse(await readFile(await spaceFile.path(), "utf8"));
  expect(spaceRecords).toMatchObject({
    kind: "space",
    space: { ownerId: owner.userId, slug: null },
    workspace: null,
  });
  expect(await axeViolations(page)).toEqual([]);
});

test("the account's export downloads under the server's name in every browser", async ({
  page,
  context,
}) => {
  const owner = await createUser("Exporter");
  await signIn(context, owner);
  const named = /^portifact-export-\d{4}-\d{2}-\d{2}\.json$/;

  // Settings: the name comes from the response's Content-Disposition, which WebKit ignores when
  // the link carries a `download` attribute.
  await page.goto(`${APP_ORIGIN}/settings`);
  const fromSettings = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download your account's data (JSON)" }).click();
  expect((await fromSettings).suggestedFilename()).toMatch(named);

  // The space's download page offers the same file.
  await page.goto(`${APP_ORIGIN}/data`);
  const fromData = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download your account's data" }).first().click();
  expect((await fromData).suggestedFilename()).toMatch(named);
});
