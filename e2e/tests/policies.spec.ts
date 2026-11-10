// Workspace policies end to end (premium plan E4, decision 0015): an admin forbids public access
// and makes new artifacts start shared with the workspace on the Policies page; the artifact page
// keeps the public option visible but disabled, with a note naming the policy; and the real CLI,
// with a service token of the workspace, publishes an artifact that starts with the policy's
// default access and is refused when it tries to make it public.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createCli } from "../shots/cli.ts";
import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  createWorkspace,
  expect,
  publish,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

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

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A service token of the workspace, written as the dashboard's create route writes it. */
async function serviceToken(workspaceId: string, createdBy: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = `pfst_${Buffer.from(bytes).toString("base64url")}`;
  await sql(
    "insert into service_tokens (id, workspace_id, label, role, scopes, token_hash, created_by, created_at, expires_at) values (?, ?, 'CI', 'editor', 'artifacts:read artifacts:write artifacts:share', ?, ?, ?, ?)",
    [
      `st_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId,
      await sha256(secret),
      createdBy,
      Date.now(),
      Date.now() + 86_400_000,
    ],
  );
  return secret;
}

test("an admin forbids public access: the artifact page says so and the CLI is refused", async ({
  page,
  context,
}) => {
  const admin = await createUser("Admin");
  const slug = `pol-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await createWorkspace({ slug, name: "Policy team", admin });
  await sql("update owner_plans set plan = 'enterprise' where owner_id = ?", [workspace.id]);
  const artifact = await publish({
    ownerId: admin.userId,
    targetOwnerId: workspace.id,
    name: "Roadmap",
    files: { "index.html": "<!doctype html><title>Roadmap</title><h1>Roadmap</h1>" },
  });
  await signIn(context, admin);

  await open(page, `/policies?workspace=${slug}`, "Policies");
  await expect(page.getByText("These policies apply to admins too.")).toBeVisible();
  const publicAccess = page.getByRole("group", { name: "Public access" });
  await publicAccess.getByRole("radio", { name: "Forbidden" }).check();
  await page
    .getByRole("group", { name: "Access of new artifacts" })
    .getByRole("radio", { name: "Everyone in the workspace" })
    .check();
  await axeInBothThemes(page);
  await page.getByRole("button", { name: "Save policies" }).click();
  const stored = async () =>
    (
      await sql<{ policy: string | null }>("select policy from workspaces where id = ?", [
        workspace.id,
      ])
    )[0]?.policy ?? "";
  await expect.poll(stored).toContain('"publicAccess":"forbidden"');

  await open(page, `/artifacts/${artifact.artifactId}?workspace=${slug}`, "Roadmap");
  const access = page.getByRole("region", { name: "Access" });
  await expect(access.getByRole("radio", { name: "Public: anyone with the link" })).toBeDisabled();
  await expect(access.getByText("The workspace's policy forbids public access.")).toBeVisible();
  await axeInBothThemes(page);

  const folder = mkdtempSync(join(tmpdir(), "pf-e2e-policy-"));
  const cli = createCli({ PORTIFACT_TOKEN: await serviceToken(workspace.id, admin.userId) });
  try {
    const listed = await cli.run(folder, "workspaces");
    expect(listed.stdout).toContain(
      `Policies of ${slug}: public access forbidden; new artifacts start as workspace.`,
    );
    writeFileSync(join(folder, "index.html"), "<h1>From CI</h1>");
    const published = await cli.run(folder, "publish", ".", "--json");
    expect(published.code, published.output.map((c) => c.text).join("")).toBe(0);
    const { artifactId } = JSON.parse(published.stdout) as { artifactId: string };
    const rows = await sql<{ access_mode: string }>(
      "select access_mode from artifacts where id = ?",
      [artifactId],
    );
    expect(rows[0]?.access_mode).toBe("workspace");
    const refused = await cli.run(folder, "access", "set", artifactId, "public", "--json");
    expect(refused.code).toBe(7);
    expect(JSON.parse(refused.stdout)).toEqual({
      error: {
        code: "policy_refused",
        message:
          "The workspace's policy forbids public access. Share it with the workspace, an email domain or named readers instead.",
      },
    });
  } finally {
    cli.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
