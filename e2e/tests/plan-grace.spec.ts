// Plan grace end to end (decision 0022): a Pro owner with previous versions and a pinned artifact
// loses the plan. During the grace the Plan page says until when what Pro kept is held, the
// history still lists and downloads the previous versions, and a new pin is refused. Past the
// grace, the usual maintenance prunes the extra versions and unpins the artifact with an expiry.

import { axeViolations } from "../src/axe.ts";
import {
  control,
  createUser,
  expect,
  publish,
  routeStorage,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const DAY = 86_400_000;
const site = (text: string) => ({
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>${text}</h1></main></body></html>`,
});

test("a lapsed Pro owner keeps its versions and pins for the grace, then the scans prune", async ({
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
  const other = await publish({
    ownerId: owner.userId,
    name: "Notes",
    bar: false,
    files: site("Notes"),
  });
  await sql("UPDATE artifacts SET pinned = 1, expires_at = NULL WHERE id = ?", [first.artifactId]);
  await control("/operator", { argv: ["remove-plan", owner.userId] });

  await signIn(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });

  // The Plan page says what is held and until when.
  await page.goto(`${APP_ORIGIN}/plan`);
  // The visible title (the space's live region holds the same words for screen readers).
  await expect(
    page.locator("p.font-semibold", { hasText: /^What the Pro plan kept is held until / }),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The history still keeps Pro's versions, and a previous one downloads.
  await routeStorage(page);
  await page.goto(`${APP_ORIGIN}/artifacts/${first.artifactId}/history`);
  await expect(
    page.getByText(
      "The owner's plan keeps 50 previous versions for 90 days after each one is replaced.",
    ),
  ).toBeVisible();
  const download = page.getByRole("button", { name: "Download files of version 1" });
  await expect(async () => {
    await download.click();
    await expect(page.getByText(/is ready\.$/)).toBeVisible({ timeout: 2_000 });
  }).toPass();

  // A new pin is refused: the plan the owner has now is free.
  await page.goto(`${APP_ORIGIN}/artifacts/${other.artifactId}`);
  const details = page.getByRole("region", { name: "Details" });
  await expect(
    details.getByText(
      "Pinning keeps an artifact online with no expiry. It is part of the Pro plan.",
    ),
  ).toBeVisible();
  await expect(details.getByRole("button", { name: "Pin" })).toHaveCount(0);
  expect(
    await sql<{ pinned: number }>("SELECT pinned FROM artifacts WHERE id = ?", [first.artifactId]),
  ).toEqual([{ pinned: 1 }]);

  // Day 59: the maintenance keeps everything.
  await control("/maintenance", { offsetMs: 59 * DAY });
  const versions = () =>
    sql<{ n: number }>(
      "SELECT count(*) AS n FROM versions WHERE artifact_id = ? AND state = 'committed'",
      [first.artifactId],
    );
  expect(await versions()).toEqual([{ n: 3 }]);

  // Day 61: the grace is over; the extra versions go and the pin lapses with an expiry.
  // Each run is bounded (50 versions, 50 unpins), and other tests' owners share the database:
  // run it until this owner's turn comes, as the 15-minute schedule would.
  await expect(async () => {
    await control("/maintenance", { offsetMs: 61 * DAY });
    expect(await versions()).toEqual([{ n: 1 }]);
    expect(
      await sql<{ pinned: number }>("SELECT pinned FROM artifacts WHERE id = ?", [
        first.artifactId,
      ]),
    ).toEqual([{ pinned: 0 }]);
  }).toPass({ intervals: [0], timeout: 60_000 });
  const [after] = await sql<{ pinned: number; expires_at: number | null }>(
    "SELECT pinned, expires_at FROM artifacts WHERE id = ?",
    [first.artifactId],
  );
  expect(after?.pinned).toBe(0);
  expect(after?.expires_at).toBeGreaterThan(Date.now() + 61 * DAY);
});
