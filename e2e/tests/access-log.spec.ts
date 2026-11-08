// The owner's access log end to end: a signed-in reader opens a protected artifact through the
// real sign-in handoff, the content Worker records the opening after the response, and the owner
// sees the reader's email on the artifact page and exports the log. Anonymous visits of public
// artifacts are not recorded.

import { readFile } from "node:fs/promises";
import { accessSql, createUser, expect, publish, signIn, test } from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launch plan</title></head><body><main><h1>Launch plan</h1></main></body></html>',
};

/** Access log rows of an artifact; the content Worker writes them a few seconds after serving. */
function openings(artifactId: string) {
  return accessSql<{ user_id: string; email: string }>(
    "SELECT user_id, email FROM access_events WHERE artifact_id = ?",
    [artifactId],
  );
}

test("the owner sees who opened a protected artifact, and only signed-in openings", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  const reader = await createUser("Reader");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Launch plan",
    files: SITE,
    readers: [reader.email],
  });
  const open = await publish({
    ownerId: owner.userId,
    name: "Open plan",
    files: SITE,
    accessMode: "public",
  });

  await signIn(context, reader);
  await page.goto(`${artifactOrigin(artifactId)}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Launch plan" })).toBeVisible();
  await page.goto(`${artifactOrigin(open.artifactId)}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Launch plan" })).toBeVisible();

  await expect
    .poll(() => openings(artifactId), { timeout: 20_000 })
    .toEqual([{ user_id: reader.userId, email: reader.email }]);
  expect(await openings(open.artifactId)).toEqual([]);

  // The owner, signed in instead of the reader, sees the reader on the artifact page.
  await context.clearCookies();
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  const section = page.getByRole("region", { name: "Who opened it" });
  await expect(section.getByRole("cell", { name: reader.email })).toBeVisible();

  // The export downloads the whole log, started from the keyboard.
  const csv = page.waitForEvent("download");
  await section.getByRole("button", { name: "Export as CSV" }).focus();
  await page.keyboard.press("Enter");
  const csvFile = await csv;
  expect(csvFile.suggestedFilename()).toBe(`${artifactId}-access-log.csv`);
  const lines = (await readFile(await csvFile.path(), "utf8")).split("\r\n");
  expect(lines[0]).toBe("openedAt,email");
  const [openedAt, email] = (lines[1] ?? "").split(",");
  expect(Number.isNaN(Date.parse(openedAt ?? ""))).toBe(false);
  expect(email).toBe(reader.email);
  expect(lines.slice(2)).toEqual([""]);
  await expect(page.getByRole("status")).toHaveText("The access log was exported as CSV.");

  const json = page.waitForEvent("download");
  await section.getByRole("button", { name: "Export as JSON" }).click();
  const jsonFile = await json;
  expect(jsonFile.suggestedFilename()).toBe(`${artifactId}-access-log.json`);
  const exported = JSON.parse(await readFile(await jsonFile.path(), "utf8"));
  expect(exported).toMatchObject({ artifactId, nextCursor: null, retentionDays: 30 });
  expect(exported.entries.map((entry: { email: string }) => entry.email)).toEqual([reader.email]);
});
