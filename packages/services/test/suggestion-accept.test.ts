// Accepting suggestions (decision 0027, "Producing the new version", "The acceptance claim"): the
// route confirms a plan by its digest and starts an attempt; the job publishes the plan's new file
// through the publish path, lists what did not apply and completes the suggestion, all on one
// claim. Every row of the record's recovery table has a test here: a failure is injected between
// two steps, the job or the scan runs again, and the state is asserted.
import { env } from "cloudflare:test";
import { CHANGE_LIST_LIMITS, SUGGESTION_LIMITS } from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clearBudgetOverride, setBudgetOverride } from "../src/budget.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { runJob } from "../src/outbox.ts";
import { acceptSuggestion } from "../src/suggestion-accept.ts";
import { expireAcceptAttempts } from "../src/suggestion-maintenance.ts";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { submitSuggestion, withdrawSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { raceBeforeBatchWith, raceBeforeFirstWrite } from "./race.ts";
import {
  artifactOf,
  attempts,
  auditKinds,
  currentText,
  DOC,
  DOMAIN,
  type Doc,
  humanCheck,
  items,
  JOB_DEPS,
  jobsOf,
  PAGE,
  publishDoc,
  republish,
  runJobs,
  textOp,
  thread,
} from "./suggestion-support.ts";
import { workspace } from "./version-support.ts";

const MD = { type: "markdown" as const, path: "index.md" };
const SECOND = () => textOp(MD, DOC, "Second", "Next");
/** Crosses the link, so it is listed (`spans_nodes`). */
const CROSSING = () => textOp(MD, DOC, "A linked", "One linked");

interface Setup {
  owner: { id: string };
  doc: Doc;
  threadId: string;
  digest: string;
  input: { userId: string; artifactId: string; now: number };
  accept: (handle?: RegionalDb) => ReturnType<typeof acceptSuggestion>;
}

async function setup(
  operations: () => ReturnType<typeof textOp>[] = () => [SECOND()],
  options: { type?: "markdown" | "site"; owner?: { id: string }; ownerId?: string } = {},
): Promise<Setup> {
  const owner = options.owner ?? (await user("Owner"));
  const doc = await publishDoc(owner.id, {
    ...(options.type ? { type: options.type } : {}),
    ...(options.ownerId ? { ownerId: options.ownerId } : {}),
  });
  const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 100 };
  const view = value(
    await submitSuggestion(db(), {
      ...input,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: operations() },
      body: "Please fix",
      humanCheck,
    }),
  );
  const plan = value(
    await planSuggestion(db(), env.ARTIFACTS, {
      ...input,
      threadId: view.id,
      contentDomain: DOMAIN,
    }),
  );
  return {
    owner,
    doc,
    threadId: view.id,
    digest: plan.digest,
    input,
    accept: (handle = db()) =>
      acceptSuggestion(handle, env.ARTIFACTS, {
        ...input,
        threadId: view.id,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
  };
}

/** A bucket whose first `put` fails, as a crash right before the new file is written. */
function failingPut(): R2Bucket {
  let failed = false;
  return new Proxy(env.ARTIFACTS, {
    get(target, prop) {
      if (prop === "put" && !failed) {
        return async () => {
          failed = true;
          throw new Error("crash before the R2 write");
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const crash = async () => {
  throw new Error("crash");
};

async function uploadState(attemptId: string) {
  const [row] = await db()
    .select({ state: schema.uploadSessions.state })
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, `upl_${attemptId.slice(4)}`));
  return row?.state;
}

async function versionCount(artifactId: string) {
  const rows = await db()
    .select({ id: schema.versions.id })
    .from(schema.versions)
    .where(and(eq(schema.versions.artifactId, artifactId), eq(schema.versions.state, "committed")));
  return rows.length;
}

describe("accepting a suggestion", () => {
  it("publishes the change as a new version through the publish path", async () => {
    const s = await setup();
    const started = value(await s.accept());
    expect(started.state).toBe("applying");
    expect((await thread(s.threadId))?.suggestionState).toBe("applying");
    expect(await runJobs("suggestion_accept", s.doc.artifactId)).toEqual(["done"]);
    const after = await thread(s.threadId);
    expect(after).toMatchObject({
      suggestionState: "accepted",
      state: "resolved",
      decidedBy: s.owner.id,
      attemptId: null,
    });
    const current = await artifactOf(s.doc.artifactId);
    expect(current?.currentVersionId).toBe(after?.resultVersionId);
    expect(await currentText(s.doc.artifactId, "index.md")).toBe(DOC.replace("Second", "Next"));
    // The commit rendered the document again, as for any publish.
    const files = await db()
      .select({ kind: schema.versionFiles.kind })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, current?.currentVersionId ?? ""));
    expect(files.map((file) => file.kind).sort()).toEqual(["block_map", "published", "rendered"]);
    const audit = await db()
      .select({ kind: schema.auditEvents.kind, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.artifactId, s.doc.artifactId));
    expect(audit).toEqual(
      expect.arrayContaining([
        { kind: "artifact.published", detail: { version: 2, first: false, via: "suggestion" } },
        {
          kind: "suggestion.accepted",
          detail: { origin: "suggestion", applied: 1, listed: 0, version: 2 },
        },
      ]),
    );
    expect((await attempts(s.doc.artifactId))[0]).toMatchObject({ state: "done" });
    expect(await items(s.doc.artifactId)).toEqual([]);
    // A second delivery of the same job finds the attempt done and changes nothing.
    expect(await versionCount(s.doc.artifactId)).toBe(2);
  });

  it("applies an HTML page in the subset", async () => {
    const s = await setup(
      () => [textOp({ type: "site", path: "index.html" }, PAGE, "Second", "Next")],
      {
        type: "site",
      },
    );
    value(await s.accept());
    await runJobs("suggestion_accept", s.doc.artifactId);
    expect(await currentText(s.doc.artifactId, "index.html")).toBe(PAGE.replace("Second", "Next"));
  });

  it("lists what does not apply with the people beside it, and publishes the rest", async () => {
    const s = await setup(() => [SECOND(), CROSSING()]);
    value(await s.accept());
    await runJobs("suggestion_accept", s.doc.artifactId);
    const [item] = await items(s.doc.artifactId);
    expect(item).toMatchObject({
      origin: "suggestion",
      threadId: s.threadId,
      state: "open",
      reason: "spans_nodes",
      createdBy: s.owner.id,
      submittedBy: s.owner.id,
      path: "index.md",
    });
    expect(JSON.parse(item?.envelope ?? "{}")).toMatchObject({ status: "listed", format: 1 });
    expect(item?.envelope).not.toContain(s.owner.id);
    expect(await currentText(s.doc.artifactId, "index.md")).toBe(DOC.replace("Second", "Next"));
  });

  it("accepts with no version when nothing applies, exactly once", async () => {
    const s = await setup(() => [CROSSING()]);
    value(await s.accept());
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    // A duplicate row, as a second delivery of the same job.
    await db()
      .insert(schema.outbox)
      .values({ ...job, id: undefined } as never);
    expect(await runJobs("suggestion_accept", s.doc.artifactId)).toEqual(["done", "done"]);
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "accepted",
      resultVersionId: null,
      state: "resolved",
    });
    expect(await items(s.doc.artifactId)).toHaveLength(1);
    expect(await versionCount(s.doc.artifactId)).toBe(1);
    const accepted = (await auditKinds(s.doc.artifactId)).filter(
      (k) => k === "suggestion.accepted",
    );
    expect(accepted).toHaveLength(1);
  });
});

describe("refusals at the route", () => {
  it("refuses a digest that is not the plan's, changing nothing", async () => {
    const s = await setup();
    const refused = await acceptSuggestion(db(), env.ARTIFACTS, {
      ...s.input,
      threadId: s.threadId,
      digest: "0".repeat(64),
      contentDomain: DOMAIN,
    });
    expect(refused).toMatchObject({ ok: false, code: "version_conflict", detail: "plan_changed" });
    expect((await thread(s.threadId))?.suggestionState).toBe("pending");
    expect(await attempts(s.doc.artifactId)).toEqual([]);
  });

  it("answers anyone but the owner side, a token or a stranger without starting anything", async () => {
    const s = await setup();
    const reader = await user("Reader");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: s.doc.artifactId, email: reader.email });
    const as = (userId: string) =>
      acceptSuggestion(db(), env.ARTIFACTS, {
        ...s.input,
        userId,
        threadId: s.threadId,
        digest: s.digest,
        contentDomain: DOMAIN,
      });
    expect(await as(reader.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await as((await user("Stranger")).id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await as("st_0000000000000000000000")).toMatchObject({ ok: false, code: "not_found" });
    expect(await attempts(s.doc.artifactId)).toEqual([]);
  });

  it("refuses a decided suggestion and one on an earlier version", async () => {
    const s = await setup();
    await republish(s.owner.id, s.doc, DOC.replace("First", "Opening"));
    expect(await s.accept()).toMatchObject({ ok: false, code: "version_conflict" });
    const w = await setup();
    value(await withdrawSuggestion(db(), { ...w.input, threadId: w.threadId, revision: 1 }));
    expect(await w.accept()).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("refuses when budget protection blocks uploads, and lets a no-version acceptance through", async () => {
    const s = await setup();
    const n = await setup(() => [CROSSING()]);
    await setBudgetOverride(db().global, {
      level: "protect100",
      steps: 2,
      until: null,
      note: null,
      now: NOW,
    });
    try {
      expect(await s.accept()).toMatchObject({ ok: false, code: "capacity_unavailable" });
      expect((await n.accept()).ok).toBe(true);
    } finally {
      await clearBudgetOverride(db().global, NOW);
    }
  });

  it("refuses when the change list has no room for every listed item", async () => {
    const s = await setup(() => [CROSSING()]);
    await fillChangeList(s.doc, s.owner.id, CHANGE_LIST_LIMITS.openPerArtifact);
    expect(await s.accept()).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("limits acceptances per owner per day", async () => {
    const s = await setup();
    await db()
      .insert(schema.rateLimits)
      .values({
        key: `suggestion_accept:owner:${s.owner.id}`,
        windowStart: NOW,
        count: SUGGESTION_LIMITS.acceptsPerOwner,
      });
    expect(await s.accept()).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

/** Fills the change list with `count` open items, as earlier acceptances would. */
async function fillChangeList(doc: Doc, ownerId: string, count: number) {
  const envelope = '{"format":1}';
  await db().run(
    sql`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${count}) insert into ${schema.changeItems} (id, artifact_id, owner_id, origin, version_id, path, envelope, bytes, reason, state, created_at, revision) select 'fill_' || ${doc.artifactId} || '_' || i, ${doc.artifactId}, ${ownerId}, 'draft', ${doc.versionId}, 'index.md', ${envelope}, ${envelope.length}, 'spans_nodes', 'open', ${NOW}, 1 from n`,
  );
}

describe("races", () => {
  it("lets one of two acceptances start", async () => {
    const s = await setup();
    const raced = raceBeforeFirstWrite(async () => {
      value(await s.accept());
    });
    expect(await s.accept(raced)).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await attempts(s.doc.artifactId)).toHaveLength(1);
  });

  it("refuses withdrawing while applying, and an acceptance that a withdrawal beat", async () => {
    const s = await setup();
    value(await s.accept());
    expect(
      await withdrawSuggestion(db(), { ...s.input, threadId: s.threadId, revision: 1 }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    const w = await setup();
    const raced = raceBeforeFirstWrite(async () => {
      value(await withdrawSuggestion(db(), { ...w.input, threadId: w.threadId, revision: 1 }));
    });
    expect(await w.accept(raced)).toMatchObject({ ok: false, code: "version_conflict" });
    expect((await thread(w.threadId))?.suggestionState).toBe("withdrawn");
    expect(await attempts(w.doc.artifactId)).toEqual([]);
  });

  it("ends the attempt when a publish lands before the commit (recovery: commit loses its guard)", async () => {
    const s = await setup();
    value(await s.accept());
    const raced = raceBeforeBatchWith(/acceptance_claims/, async () => {
      await republish(s.owner.id, s.doc, DOC.replace("First", "Opening"));
    });
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    expect(
      await runJob(
        raced,
        env.ARTIFACTS,
        { id: job?.id ?? 0, topic: "suggestion_accept" },
        NOW + 2_000,
        JOB_DEPS,
      ),
    ).toBe("done");
    const [attempt] = await attempts(s.doc.artifactId);
    expect(attempt).toMatchObject({ state: "ended", reason: "version_conflict" });
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "pending",
      attemptReason: "version_conflict",
    });
    // The pending version's upload is released at once; the suggestion is offered to the carry.
    expect(await uploadState(attempt?.id ?? "")).toBe("failed");
    expect(await jobsOf("suggestion_carry", s.doc.artifactId)).not.toHaveLength(0);
    expect(await currentText(s.doc.artifactId, "index.md")).toBe(DOC.replace("First", "Opening"));
  });

  it("makes the acceptance a no-op when a competing insertion fills the list", async () => {
    const s = await setup(() => [CROSSING()]);
    await fillChangeList(s.doc, s.owner.id, CHANGE_LIST_LIMITS.openPerArtifact - 1);
    value(await s.accept());
    const raced = raceBeforeBatchWith(/acceptance_claims/, async () => {
      await db()
        .insert(schema.changeItems)
        .values({
          id: `late_${s.doc.artifactId}`,
          artifactId: s.doc.artifactId,
          ownerId: s.owner.id,
          origin: "draft",
          versionId: s.doc.versionId,
          path: "index.md",
          envelope: '{"format":1}',
          bytes: 12,
          reason: "spans_nodes",
        });
    });
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    await runJob(
      raced,
      env.ARTIFACTS,
      { id: job?.id ?? 0, topic: "suggestion_accept" },
      NOW + 2_000,
      JOB_DEPS,
    );
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "pending",
      attemptReason: "quota_exceeded",
    });
    expect((await items(s.doc.artifactId)).filter((item) => item.threadId === s.threadId)).toEqual(
      [],
    );
    expect(await versionCount(s.doc.artifactId)).toBe(1);
  });

  it("completes once when two deliveries of the job run at once", async () => {
    const s = await setup();
    value(await s.accept());
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    const message = { id: job?.id ?? 0, topic: "suggestion_accept" as const };
    // A copy of the row for the second delivery: the first deletes its own when done.
    const [copy] = await db()
      .insert(schema.outbox)
      .values({ ...job, id: undefined } as never)
      .returning({ id: schema.outbox.id });
    const raced = raceBeforeBatchWith(/acceptance_claims/, async () => {
      await runJob(db(), env.ARTIFACTS, { ...message, id: copy?.id ?? 0 }, NOW + 2_000, JOB_DEPS);
    });
    expect(await runJob(raced, env.ARTIFACTS, message, NOW + 2_000, JOB_DEPS)).toBe("done");
    expect(await versionCount(s.doc.artifactId)).toBe(2);
    expect((await attempts(s.doc.artifactId))[0]).toMatchObject({ state: "done" });
    expect((await thread(s.threadId))?.suggestionState).toBe("accepted");
  });
});

describe("recovery", () => {
  it("retries a job that failed before the pending rows, and the scan ends it after three", async () => {
    const s = await setup();
    value(await s.accept());
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    const message = { id: job?.id ?? 0, topic: "suggestion_accept" as const };
    const broken = raceBeforeBatchWith(/upload_sessions/, crash);
    await expect(runJob(broken, env.ARTIFACTS, message, NOW + 2_000, JOB_DEPS)).rejects.toThrow();
    expect((await thread(s.threadId))?.suggestionState).toBe("applying");
    expect(await uploadState((await attempts(s.doc.artifactId))[0]?.id ?? "")).toBeUndefined();
    // Two more failed deliveries; the scan then ends it as failed.
    for (let i = 0; i < 2; i++) {
      await expect(
        runJob(
          raceBeforeBatchWith(/upload_sessions/, crash),
          env.ARTIFACTS,
          message,
          NOW + 2_000,
          JOB_DEPS,
        ),
      ).rejects.toThrow();
    }
    expect((await expireAcceptAttempts(db(), NOW + 3_000)).ended).toBeGreaterThan(0);
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "pending",
      attemptReason: "failed",
    });
    // The viewer offers to accept again: the same plan is still the plan.
    expect((await s.accept()).ok).toBe(true);
  });

  it("reuses the same version after a crash before the R2 write", async () => {
    const s = await setup();
    value(await s.accept());
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    const message = { id: job?.id ?? 0, topic: "suggestion_accept" as const };
    await expect(runJob(db(), failingPut(), message, NOW + 2_000, JOB_DEPS)).rejects.toThrow();
    const [attempt] = await attempts(s.doc.artifactId);
    expect(attempt?.versionId).toBe(`ver_${attempt?.id.slice(4)}`);
    expect(await uploadState(attempt?.id ?? "")).toBe("uploading");
    expect(await runJob(db(), env.ARTIFACTS, message, NOW + 3_000, JOB_DEPS)).toBe("done");
    expect((await artifactOf(s.doc.artifactId))?.currentVersionId).toBe(attempt?.versionId);
    expect(await versionCount(s.doc.artifactId)).toBe(2);
  });

  it("reuses the same version after a crash after the R2 write, before the commit", async () => {
    const s = await setup();
    value(await s.accept());
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    const message = { id: job?.id ?? 0, topic: "suggestion_accept" as const };
    await expect(
      runJob(
        raceBeforeBatchWith(/acceptance_claims/, crash),
        env.ARTIFACTS,
        message,
        NOW + 2_000,
        JOB_DEPS,
      ),
    ).rejects.toThrow();
    expect((await thread(s.threadId))?.suggestionState).toBe("applying");
    expect(await runJob(db(), env.ARTIFACTS, message, NOW + 3_000, JOB_DEPS)).toBe("done");
    expect((await thread(s.threadId))?.suggestionState).toBe("accepted");
    expect(await versionCount(s.doc.artifactId)).toBe(2);
  });

  it("releases an abandoned attempt's pending version when the scan ends it", async () => {
    const s = await setup();
    value(await s.accept());
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    const message = { id: job?.id ?? 0, topic: "suggestion_accept" as const };
    await expect(runJob(db(), failingPut(), message, NOW + 2_000, JOB_DEPS)).rejects.toThrow();
    const [usage] = await db()
      .select({ open: schema.accountUsage.openUploads })
      .from(schema.accountUsage)
      .where(eq(schema.accountUsage.ownerId, s.owner.id));
    expect(usage?.open).toBe(1);
    expect(
      (await expireAcceptAttempts(db(), NOW + 100 + SUGGESTION_LIMITS.attemptMs)).ended,
    ).toBeGreaterThan(0);
    const [attempt] = await attempts(s.doc.artifactId);
    expect(await uploadState(attempt?.id ?? "")).toBe("failed");
    const [after] = await db()
      .select({ open: schema.accountUsage.openUploads })
      .from(schema.accountUsage)
      .where(eq(schema.accountUsage.ownerId, s.owner.id));
    expect(after?.open).toBe(0);
    // A later delivery of the job finds nothing to do.
    expect(
      await runJob(db(), env.ARTIFACTS, message, NOW + SUGGESTION_LIMITS.attemptMs + 2, JOB_DEPS),
    ).toBe("done");
    expect(await versionCount(s.doc.artifactId)).toBe(1);
  });

  it("ends the attempt when budget protection refuses the publish at the job", async () => {
    const s = await setup();
    value(await s.accept());
    await setBudgetOverride(db().global, {
      level: "protect100",
      steps: 2,
      until: null,
      note: null,
      now: NOW,
    });
    try {
      await runJobs("suggestion_accept", s.doc.artifactId);
    } finally {
      await clearBudgetOverride(db().global, NOW);
    }
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "pending",
      attemptReason: "capacity_unavailable",
    });
    expect(await versionCount(s.doc.artifactId)).toBe(1);
  });

  it("ends the attempt as revoked on a hold, a suspension or a lost role", async () => {
    const held = await setup();
    value(await held.accept());
    value(
      await suspendArtifact(db(), { artifactId: held.doc.artifactId, reason: "spam", now: NOW }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId: held.doc.artifactId,
        ground: "court order",
        releaseAt: null,
        now: NOW,
      }),
    );
    await runJobs("suggestion_accept", held.doc.artifactId);
    expect((await attempts(held.doc.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "revoked",
    });

    const team = await workspace(() => user("Member"));
    const ws = await setup(() => [SECOND()], { owner: team.editor, ownerId: team.id });
    value(await ws.accept());
    await db()
      .update(schema.workspaceMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, team.id),
          eq(schema.workspaceMembers.userId, team.editor.id),
        ),
      );
    await runJobs("suggestion_accept", ws.doc.artifactId);
    expect((await attempts(ws.doc.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "revoked",
    });
    expect(await thread(ws.threadId)).toMatchObject({
      suggestionState: "pending",
      attemptReason: "revoked",
    });
    expect(await versionCount(ws.doc.artifactId)).toBe(1);
  });

  it("ends the attempt when the confirmed plan no longer matches the files", async () => {
    const s = await setup();
    value(await s.accept());
    // The name is the document's title: a rename means another rendering than the one confirmed.
    await db()
      .update(schema.artifacts)
      .set({ name: "Renamed" })
      .where(eq(schema.artifacts.id, s.doc.artifactId));
    await runJobs("suggestion_accept", s.doc.artifactId);
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "pending",
      attemptReason: "plan_changed",
    });
  });

  it("waits while suggestions are switched off in the jobs Worker", async () => {
    const s = await setup();
    value(await s.accept());
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    await expect(
      runJob(db(), env.ARTIFACTS, { id: job?.id ?? 0, topic: "suggestion_accept" }, NOW + 2_000, {
        suggestions: { enabled: false, contentDomain: DOMAIN },
      }),
    ).rejects.toThrow(/switched on/);
    expect(await jobsOf("suggestion_accept", s.doc.artifactId)).toHaveLength(1);
  });
});
