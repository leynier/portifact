// Carry and closure are bounded per run (review of pull request #262, finding 9): one page held at
// a time, at most `readBytes` of stored files read per run with the rest continued in the next
// job, and an HTML page over the node budget proves nothing.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { runChangeListCheck, runSuggestionCarry } from "../src/suggestion-versions.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { DOMAIN, humanCheck, jobsOf, PAGE, runJobs, textOp, thread } from "./suggestion-support.ts";
import { publishVersion } from "./version-support.ts";

const OTHER = PAGE.replace("Title", "Other");
const LONGER = (page: string) => page.replace("<h1", "<p>Added first.</p><h1");

async function twoPages() {
  const owner = await user("Owner");
  const site = await publishVersion(
    owner.id,
    { "a.html": PAGE, "b.html": OTHER },
    { entrypoint: "a.html" },
  );
  await db()
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, site.artifactId));
  const ids: string[] = [];
  for (const path of ["a.html", "b.html"]) {
    const body = path === "a.html" ? PAGE : OTHER;
    const view = value(
      await submitSuggestion(db(), {
        userId: owner.id,
        artifactId: site.artifactId,
        now: NOW,
        versionId: site.versionId,
        edit: { operations: [textOp({ type: "site", path }, body, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    value(
      await planSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: site.artifactId,
        now: NOW + 10,
        threadId: view.id,
        contentDomain: DOMAIN,
      }),
    );
    ids.push(view.id);
  }
  const next = await publishVersion(
    owner.id,
    { "a.html": LONGER(PAGE), "b.html": LONGER(OTHER) },
    { base: site, now: NOW + 1_000, entrypoint: "a.html" },
  );
  return { owner, site, next, ids };
}

describe("bounded carry and closure runs", () => {
  it("carries one group per run when the read budget is spent, continuing in the next job", async () => {
    const { site, next, ids } = await twoPages();
    const [job] = await jobsOf("suggestion_carry", site.artifactId);
    expect(
      await runSuggestionCarry(db(), env.ARTIFACTS, job as never, NOW + 2_000, DOMAIN, 200, 1),
    ).toBe("done");
    const states = await Promise.all(ids.map(thread));
    // One group moved, the other untouched (not outdated), and a next job waits for it.
    expect(states.filter((row) => row?.versionId === next.versionId)).toHaveLength(1);
    expect(states.every((row) => row?.suggestionState === "pending")).toBe(true);
    expect(await jobsOf("suggestion_carry", site.artifactId)).toHaveLength(2);
    await db()
      .delete(schema.outbox)
      .where(eq(schema.outbox.id, job?.id ?? 0));
    await runJobs("suggestion_carry", site.artifactId);
    expect(
      (await Promise.all(ids.map(thread))).every((row) => row?.versionId === next.versionId),
    ).toBe(true);
  });

  it("checks one page's items per run when the read budget is spent, resuming after them", async () => {
    const { owner, site } = await twoPages();
    const proof = JSON.stringify({
      unit: "utf16",
      start: 0,
      end: 1,
      before: "x",
      after: "y",
      shownBefore: "x",
      shownAfter: "y",
      nodeLeft: "",
      nodeRight: "",
      identity: [],
    });
    for (const path of ["a.html", "b.html"]) {
      await db()
        .insert(schema.changeItems)
        .values({
          id: `${path}_${site.artifactId}`,
          artifactId: site.artifactId,
          ownerId: owner.id,
          origin: "draft",
          versionId: site.versionId,
          path,
          envelope: '{"format":1}',
          proof,
          bytes: 12 + proof.length,
          reason: "not_eligible",
        });
    }
    await publishVersion(
      owner.id,
      { "a.html": PAGE, "b.html": OTHER },
      {
        base: {
          artifactId: site.artifactId,
          versionId:
            (
              await db()
                .select()
                .from(schema.artifacts)
                .where(eq(schema.artifacts.id, site.artifactId))
            )[0]?.currentVersionId ?? "",
        },
        now: NOW + 3_000,
        entrypoint: "a.html",
      },
    );
    const jobs = await jobsOf("change_list_check", site.artifactId);
    const job = jobs.at(-1);
    expect(
      await runChangeListCheck(db(), env.ARTIFACTS, job as never, NOW + 4_000, DOMAIN, 200, 1),
    ).toBe("done");
    const after = await jobsOf("change_list_check", site.artifactId);
    expect(after).toHaveLength(jobs.length + 1);
    expect((after.at(-1)?.payload as { after?: string } | undefined)?.after).toBe(
      `a.html_${site.artifactId}`,
    );
  });

  it("proves nothing on an HTML page over the node budget", async () => {
    const { acceptSuggestion } = await import("../src/suggestion-accept.ts");
    const owner = await user("Owner");
    // Outside the subset (a script), so the edit is listed with its proven place.
    const scripted = PAGE.replace("</body>", "<script>1</script></body>");
    const site = await publishVersion(owner.id, { "index.html": scripted });
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, site.artifactId));
    const view = value(
      await submitSuggestion(db(), {
        userId: owner.id,
        artifactId: site.artifactId,
        now: NOW,
        versionId: site.versionId,
        edit: {
          operations: [textOp({ type: "site", path: "index.html" }, scripted, "Second", "Next")],
        },
        body: "Fix",
        humanCheck,
      }),
    );
    const input = {
      userId: owner.id,
      artifactId: site.artifactId,
      now: NOW + 10,
      threadId: view.id,
      contentDomain: DOMAIN,
    };
    const plan = value(await planSuggestion(db(), env.ARTIFACTS, input));
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...input, digest: plan.digest }));
    await runJobs("suggestion_accept", site.artifactId);
    const fixed = scripted.replace("Second", "Next");
    // The fix, on a page that also grew past the node budget: nothing is proved on it.
    const crowded = fixed.replace("</body>", `${"<b></b>".repeat(50_001)}</body>`);
    const current = (
      await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, site.artifactId))
    )[0];
    await publishVersion(
      owner.id,
      { "index.html": crowded },
      {
        base: { artifactId: site.artifactId, versionId: current?.currentVersionId ?? "" },
        now: NOW + 1_000,
      },
    );
    await runJobs("change_list_check", site.artifactId, NOW + 2_000);
    const [item] = await db()
      .select()
      .from(schema.changeItems)
      .where(eq(schema.changeItems.artifactId, site.artifactId));
    expect(item?.state).toBe("open");
    // The same fix on an ordinary page closes it.
    const crowdedVersion = (
      await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, site.artifactId))
    )[0];
    await publishVersion(
      owner.id,
      { "index.html": fixed },
      {
        base: { artifactId: site.artifactId, versionId: crowdedVersion?.currentVersionId ?? "" },
        now: NOW + 3_000,
      },
    );
    await runJobs("change_list_check", site.artifactId, NOW + 4_000);
    const [closed] = await db()
      .select()
      .from(schema.changeItems)
      .where(eq(schema.changeItems.artifactId, site.artifactId));
    expect(closed?.state).toBe("closed_by_version");
  });
});
