// Pinning end to end (premium plan P2): an owner on a plan without `pin` reads that pinning is
// part of a paid plan and gets no control; on Pro they pin from the artifact page, the page and
// the list show it with no expiry, the artifact keeps serving long after its 30 days would have
// ended, and unpinning brings a fresh expiry back.

import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  expect,
  publish,
  setContentClock,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Roadmap</title></head><body><main><h1>Roadmap</h1></main></body></html>',
};

const DAY = 86_400_000;

test("an owner on Pro pins an artifact, which then never expires, and unpins it", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    name: "Roadmap",
    bar: false,
    files: SITE,
    accessMode: "public",
  });
  await signIn(context, owner);

  // Free: the page explains the plan and offers no pin.
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  const details = page.getByRole("region", { name: "Details" });
  await expect(
    details.getByText(
      "Pinning keeps an artifact online with no expiry. It is part of the Pro plan.",
    ),
  ).toBeVisible();
  await expect(details.getByRole("button", { name: "Pin" })).toHaveCount(0);

  // On Pro, granted as the operator tool would.
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'pro', 1, 'operator', ?)",
    [owner.userId, Date.now()],
  );
  await page.reload();
  await details.getByRole("button", { name: "Pin" }).click();
  await expect(page.getByText("Artifact pinned. It stays online with no expiry.")).toBeVisible();
  await expect(details.getByText("Never, it is pinned")).toBeVisible();
  await expect(details.getByRole("button", { name: "Unpin" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  expect(
    await sql<{ pinned: number; expires_at: number | null }>(
      "SELECT pinned, expires_at FROM artifacts WHERE id = ?",
      [artifactId],
    ),
  ).toEqual([{ pinned: 1, expires_at: null }]);

  // The list shows it pinned where the expiry would be.
  await page.goto(`${APP_ORIGIN}/`);
  const row = page.getByRole("row").filter({ hasText: "Roadmap" });
  await expect(row.getByText("Pinned", { exact: true })).toBeVisible();

  // A year on, it still serves.
  await setContentClock(artifactId, 365 * DAY);
  try {
    await page.goto(`${artifactOrigin(artifactId)}/`);
    await expect(page.getByRole("heading", { level: 1, name: "Roadmap" })).toBeVisible();
  } finally {
    await setContentClock(artifactId, 0);
  }

  // Unpinning gives it 30 days again.
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  await details.getByRole("button", { name: "Unpin" }).click();
  await expect(page.getByText(/^Artifact unpinned\. It now expires on /)).toBeVisible();
  await expect(details.getByRole("button", { name: "Pin" })).toBeVisible();
  const [after] = await sql<{ pinned: number; expires_at: number }>(
    "SELECT pinned, expires_at FROM artifacts WHERE id = ?",
    [artifactId],
  );
  expect(after?.pinned).toBe(0);
  expect(after?.expires_at).toBeGreaterThan(Date.now() + 29 * DAY);
});
