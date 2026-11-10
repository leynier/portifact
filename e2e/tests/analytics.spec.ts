// Analytics end to end (premium plan P8, decision 0007): an anonymous visit of a public artifact
// with the Portifact bar goes through the viewer and counts once (the frame's load, not the
// redirect), the counters are written after the response,
// and the owner on Pro reads the series on the artifact page. An owner on the free plan gets no
// counters and reads that analytics are part of a paid plan.

import { axeViolations } from "../src/axe.ts";
import {
  accessSql,
  artifactFrame,
  createUser,
  expect,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Quarterly plan</h1></main></body></html>',
  "style.css": "h1 { font-weight: 600; }",
};

function views(artifactId: string) {
  return accessSql<{ views: number; signed_in_views: number }>(
    "SELECT views, signed_in_views FROM artifact_views WHERE artifact_id = ?",
    [artifactId],
  );
}

test("one visit through the viewer is one view, and the owner on Pro reads it", async ({
  page,
  browser,
}) => {
  const owner = await createUser("Owner");
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'pro', 1, 'operator', ?)",
    [owner.userId, Date.now()],
  );
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Quarterly plan",
    files: SITE,
    accessMode: "public",
  });

  // An anonymous visitor follows the artifact's own link: redirect, viewer, frame.
  const visitor = await browser.newContext();
  const visit = await visitor.newPage();
  await visit.goto(`${artifactOrigin(artifactId)}/`);
  await expect(visit).toHaveURL(`${APP_ORIGIN}/view/${artifactId}`);
  const frame = await artifactFrame(visit, artifactId);
  await expect(frame.getByRole("heading", { level: 1, name: "Quarterly plan" })).toBeVisible();
  await visitor.close();

  await expect
    .poll(() => views(artifactId), { timeout: 20_000 })
    .toEqual([{ views: 1, signed_in_views: 0 }]);

  // The redirect added nothing: still one after the next window could have landed. (The owner's
  // own visit is covered by unit tests: where third-party cookies are blocked the viewer's frame
  // has no session, so an owner visit in the viewer counts as anonymous, as decision 0007 says.)
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  expect(await views(artifactId)).toEqual([{ views: 1, signed_in_views: 0 }]);

  await signIn(page.context(), owner);
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  const section = page.getByRole("region", { name: "Analytics" });
  const chart = section.getByRole("group", { name: "Views per day" });
  await expect(chart).toBeVisible();
  await expect(section.getByText("Views: 1. Signed in: 0.")).toBeVisible();
  // Public artifacts never count distinct visitors.
  await expect(
    section.getByText("Only counted for artifacts restricted to the people you list"),
  ).toBeVisible();
  // Reachable from the keyboard: the chart moves to the first day of the period.
  await chart.focus();
  await page.keyboard.press("Home");
  await expect(section.getByText("Views: 0. Signed in: 0.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("an owner on the free plan gets no counters and reads that analytics are a paid feature", async ({
  page,
  browser,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Free plan",
    bar: false,
    files: SITE,
    accessMode: "public",
  });
  const visitor = await browser.newContext();
  const visit = await visitor.newPage();
  await visit.goto(`${artifactOrigin(artifactId)}/`);
  await expect(visit.getByRole("heading", { level: 1, name: "Quarterly plan" })).toBeVisible();
  await visitor.close();

  await signIn(page.context(), owner);
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  const section = page.getByRole("region", { name: "Analytics" });
  await expect(
    section.getByText("Analytics per artifact and a one-year access log are part of the Pro plan."),
  ).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
  await page.waitForTimeout(6_000);
  expect(await views(artifactId)).toEqual([]);
});
