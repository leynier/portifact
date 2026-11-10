// Approval reviews end to end (premium plan T6, decision 0013; not review mode): the owner asks a
// reader to review from the artifact page, the reader approves in the viewer with a note, the
// owner sees the verdict, and a new version starts the review again with no verdicts.

import type { Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import { createUser, expect, publish, signIn, sql, test, type User } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const SITE = (text: string) => ({
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launch plan</title></head><body><main><h1>Launch plan</h1><p>${text}</p></main></body></html>`,
});

async function as(page: Page, user: User) {
  await page.goto("about:blank");
  await page.context().clearCookies();
  await signIn(page.context(), user);
}

test("a reader approves the version they were asked to review, and a new version starts again", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const owner = await createUser("Owner");
  const ana = await createUser("Ana");
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'team', 1, 'operator', ?)",
    [owner.userId, Date.now()],
  );
  const first = await publish({
    ownerId: owner.userId,
    name: "Launch plan",
    files: SITE("First draft"),
    readers: [ana.email],
    annotations: "open",
  });

  // The owner asks Ana from the artifact page.
  await as(page, owner);
  await page.goto(`${APP_ORIGIN}/artifacts/${first.artifactId}`);
  const reviews = page.getByRole("region", { name: "Approval reviews" });
  await reviews.getByRole("textbox", { name: "Reviewers" }).fill(ana.email);
  await reviews.getByRole("button", { name: "Request review" }).click();
  await expect(page.getByText("Review requested").first()).toBeVisible();
  await expect(reviews.getByRole("list", { name: "Reviewers and their verdicts" })).toContainText(
    "No verdict yet",
  );
  expect(await axeViolations(page)).toEqual([]);

  // Ana approves in the viewer, with a note the owner sees as text.
  await as(page, ana);
  await page.goto(`${APP_ORIGIN}/view/${first.artifactId}`);
  const panel = page.getByRole("region", { name: "Your review" });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("banner").getByText("Review pending")).toBeVisible();
  await panel.getByRole("textbox", { name: "Note (optional)" }).fill("<b>Ship it</b>");
  await panel.getByRole("button", { name: "Approve" }).click();
  await expect(panel).toContainText("Your verdict: Approved");
  await expect(page.getByRole("banner").getByText("Approved")).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page)).toEqual([]);
  }

  await as(page, owner);
  await page.goto(`${APP_ORIGIN}/artifacts/${first.artifactId}`);
  const list = reviews.getByRole("list", { name: "Reviewers and their verdicts" });
  await expect(list).toContainText("Approved");
  await expect(list).toContainText("<b>Ship it</b>");

  // A new version: the request carries over as pending with no verdicts, the old one is history.
  await publish({
    ownerId: owner.userId,
    name: "Launch plan",
    files: SITE("Second draft"),
    update: { artifactId: first.artifactId, baseVersionId: first.versionId },
  });
  await page.reload();
  await expect(list).toContainText("No verdict yet");
  await expect(reviews).toContainText("Earlier versions");
  await expect(reviews).toContainText("Review pending");
});
