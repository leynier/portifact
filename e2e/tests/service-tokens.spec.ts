// Service tokens end to end (premium plan T4 and T5, decision 0011): an admin creates a token on
// the workspace's Service tokens page and copies its secret, the real CLI publishes twice with
// PORTIFACT_TOKEN and --key (one artifact, two versions), deletes by key, and after the admin
// revokes the token in the dashboard the CLI is refused.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createCli } from "../shots/cli.ts";
import { axeViolations } from "../src/axe.ts";
import { createUser, createWorkspace, expect, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

async function open(page: Page, path: string) {
  await page.goto(`${APP_ORIGIN}${path}`);
  await page.getByRole("heading", { level: 1, name: "Service tokens" }).waitFor();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

test("a token from the dashboard publishes with the CLI by key, deletes by key and stops when revoked", async ({
  page,
  context,
}) => {
  const admin = await createUser("Admin");
  const slug = `t-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await createWorkspace({ slug, name: "Preview team", admin });
  await signIn(context, admin);
  await open(page, `/service-tokens?workspace=${slug}`);

  const form = page.getByRole("region", { name: "Create a token" });
  await form.getByRole("textbox", { name: /^Label/ }).fill("GitHub previews");
  await form.getByRole("checkbox", { name: /^Delete/ }).check();
  await form.getByRole("radio", { name: /^Artifacts with a key prefix/ }).check();
  await form.getByRole("textbox", { name: /^Key prefix/ }).fill("pr-");
  await form.getByRole("button", { name: "Create token" }).click();

  await expect(page.getByText("Copy the token now")).toBeVisible();
  const secret = (await page.getByText(/^pfst_/).textContent())?.trim() ?? "";
  expect(secret).toMatch(/^pfst_[A-Za-z0-9_-]{43}$/);
  await expect(page.getByRole("button", { name: "Copy token" })).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByText("Copy the token now")).toHaveCount(0);

  const folder = mkdtempSync(join(tmpdir(), "pf-e2e-token-"));
  const cli = createCli({ PORTIFACT_TOKEN: secret });
  try {
    writeFileSync(join(folder, "index.html"), "<h1>Preview one</h1>");
    const first = await cli.run(folder, "publish", ".", "--key", "pr-7", "--json");
    expect(first.code, first.output.map((c) => c.text).join("")).toBe(0);
    writeFileSync(join(folder, "index.html"), "<h1>Preview two</h1>");
    const second = await cli.run(folder, "publish", ".", "--key", "pr-7", "--json");
    expect(second.code).toBe(0);
    const a = JSON.parse(first.stdout) as { artifactId: string; versionNumber: number };
    const b = JSON.parse(second.stdout) as { artifactId: string; versionNumber: number };
    expect(b.artifactId).toBe(a.artifactId);
    expect([a.versionNumber, b.versionNumber]).toEqual([1, 2]);
    for (const run of [first, second]) {
      expect(run.output.map((chunk) => chunk.text).join("")).not.toContain(secret);
    }
    const rows = await sql<{ owner_id: string; external_key: string; created_by: string }>(
      "select owner_id, external_key, created_by from artifacts where id = ?",
      [a.artifactId],
    );
    expect(rows[0]?.owner_id).toBe(workspace.id);
    expect(rows[0]?.external_key).toBe("pr-7");
    expect(rows[0]?.created_by).toMatch(/^st_[0-9a-f]{32}$/);

    // A key outside the token's prefix is refused.
    const outside = await cli.run(folder, "publish", ".", "--key", "docs", "--json");
    expect(outside.code).toBe(5);

    const deleted = await cli.run(folder, "delete", "--key", "pr-7", "--yes", "--json");
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({ deleted: true, artifactId: a.artifactId });

    // The list shows when it was last used; revoking ends it at the next request.
    await page.reload();
    const card = page.getByRole("listitem").filter({ hasText: "GitHub previews" });
    await expect(card.getByText(/^Last used/)).toBeVisible();
    await card.getByRole("button", { name: "Revoke GitHub previews" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke GitHub previews?" });
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("No service tokens yet")).toBeVisible();

    const refused = await cli.run(folder, "list", "--json");
    expect(refused.code).toBe(3);
    expect(JSON.parse(refused.stdout)).toEqual({
      error: {
        code: "unauthenticated",
        message: "This service token is not valid. It may have been revoked.",
      },
    });
  } finally {
    cli.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
