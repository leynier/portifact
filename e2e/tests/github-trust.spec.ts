// GitHub Actions OIDC trust rules end to end (decision 0024): an admin trusts a repository by its
// IDs on the workspace's Service tokens page, sees it listed with its namespace and the audience
// a workflow asks for, and removes it after a confirmation; the page passes axe in both themes.

import type { Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import { createUser, createWorkspace, expect, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

async function open(page: Page, path: string) {
  await page.goto(`${APP_ORIGIN}${path}`);
  await page.getByRole("heading", { level: 1, name: "Service tokens" }).waitFor();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

test("an admin trusts a GitHub repository, sees it listed and removes it", async ({
  page,
  context,
}) => {
  const admin = await createUser("Admin");
  const slug = `g-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await createWorkspace({ slug, name: "Preview team", admin });
  await signIn(context, admin);
  await open(page, `/service-tokens?workspace=${slug}`);

  const section = page.getByRole("region", { name: "GitHub Actions" });
  await expect(section.getByText("No trusted repositories")).toBeVisible();
  await expect(section.getByText(`/workspaces/${slug}/github`)).toBeVisible();
  await section.getByRole("textbox", { name: "Repository", exact: true }).fill("acme/site");
  await section.getByRole("textbox", { name: "Repository ID" }).fill("123456");
  await section.getByRole("textbox", { name: "Owner ID" }).fill("777");
  await expect(section.getByRole("checkbox", { name: "pull_request", exact: true })).toBeChecked();
  await expect(
    section.getByRole("checkbox", { name: "pull_request_target", exact: true }),
  ).not.toBeChecked();
  await section.getByRole("textbox", { name: /^Environment/ }).fill("preview");
  await section.getByRole("button", { name: "Trust repository" }).click();

  const card = section.getByRole("listitem").filter({ hasText: "acme/site" });
  await expect(card.getByRole("heading", { name: "acme/site" })).toBeVisible();
  await expect(card.getByText("Repository ID 123456, owner ID 777")).toBeVisible();
  await expect(card.getByText("Publishes only keys that start with gh-123456/")).toBeVisible();
  await expect(card.getByText("Environment: preview")).toBeVisible();
  const rows = await sql<{ repository_id: string; events: string }>(
    "select repository_id, events from github_trust_rules where workspace_id = ?",
    [workspace.id],
  );
  expect(rows).toEqual([{ repository_id: "123456", events: "push pull_request" }]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }

  await card.getByRole("button", { name: "Remove acme/site" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/credentials already issued/)).toBeVisible();
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(section.getByText("No trusted repositories")).toBeVisible();
  const left = await sql("select id from github_trust_rules where workspace_id = ?", [
    workspace.id,
  ]);
  expect(left).toEqual([]);
  const tombstones = await sql<{ kind: string }>(
    "select kind from tombstones where kind = 'github_trust_rule'",
  );
  expect(tombstones.length).toBeGreaterThan(0);
});
