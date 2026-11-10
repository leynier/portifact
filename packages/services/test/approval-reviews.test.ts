// Approval reviews (premium plan T6, decision 0013): requesting, changing and cancelling on the
// owner side, verdicts by requested reviewers, the status, who sees what, the reset on a new
// version, races, transfers, account deletion and the maintenance re-check.
import { env } from "cloudflare:test";
import { APPROVALS, planRequiredMessage, type ServiceTokenCreate } from "@portifact/contracts";
import { globalDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { APPROVAL_MESSAGES, personalActor as personalActorFor } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { advanceAccountDeletion } from "../src/account-data.ts";
import {
  cancelApprovalReview,
  changeApprovalReview,
  getApprovalReview,
  RECHECK_BUDGET,
  RECHECK_CALLS_PER_REQUEST,
  recheckApprovalReviewers,
  requestApprovalReview,
  submitApprovalVerdict,
} from "../src/approval-reviews.ts";
import { getArtifact, listArtifacts } from "../src/artifacts.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import { rollbackArtifact } from "../src/versions.ts";
import { DAY, db, grantPlan, NOW, publishSite, racing, user, value } from "./fixtures.ts";
import { raceBeforeFirstWrite } from "./race.ts";

type Person = { id: string; email: string };

/** An owner on Team with one restricted artifact shared with `readers`. */
async function setup(readers: Person[] = [], plan: "team" | "pro" | null = "team") {
  const owner = await user("Owner");
  if (plan) await grantPlan(owner.id, plan);
  const published = await publishSite(owner.id);
  if (readers.length > 0) {
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId: published.artifactId,
        change: { addReaders: readers.map((r) => r.email) },
        now: NOW,
      }),
    );
  }
  return { owner, ...published };
}

const request = (
  userId: string,
  artifactId: string,
  reviewers: string[],
  extra: { requiredApprovals?: number | null; showStatus?: boolean; now?: number } = {},
) =>
  requestApprovalReview(db(), {
    userId,
    artifactId,
    reviewers,
    requiredApprovals: extra.requiredApprovals,
    showStatus: extra.showStatus,
    now: extra.now ?? NOW,
  });

const verdict = (
  userId: string,
  artifactId: string,
  value: "approve" | "changes",
  note?: string,
  now = NOW + 1,
) => submitApprovalVerdict(db(), { userId, artifactId, verdict: value, note, now });

const status = (userId: string, artifactId: string) =>
  getApprovalReview(db(), { userId, artifactId, now: NOW + 2 });

async function auditKinds(artifactId: string) {
  const rows = await db()
    .select({ kind: schema.auditEvents.kind, detail: schema.auditEvents.detail })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.artifactId, artifactId));
  return rows.filter((row) => row.kind.startsWith("review."));
}

async function workspace(plan: "team" | null = "team") {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const slug = `t${id.slice(3, 22)}`;
  const [admin, editor, member] = [await user("Admin"), await user("Editor"), await user("Member")];
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  if (plan) await grantPlan(id, plan, { seats: 5 });
  return { id, slug, admin, editor, member };
}

describe("requesting a review", () => {
  it("asks listed readers to review the current version, pending with no verdicts", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId, versionId } = await setup([ana, ben]);
    const view = value(await request(owner.id, artifactId, [ana.email, ben.email.toUpperCase()]));
    expect(view.role).toBe("owner");
    expect(view.review).toEqual({
      status: "pending",
      reviewers: 2,
      required: 2,
      approvals: 0,
      changesRequested: 0,
    });
    expect(view.request?.versionId).toBe(versionId);
    expect(view.request?.requestedBy).toBe("Owner");
    // No names before a verdict: asking never tells who has an account.
    expect(view.request?.reviewers.map((r) => [r.name, r.email, r.verdict])).toEqual([
      [null, ana.email, null],
      [null, ben.email, null],
    ]);
    expect(await auditKinds(artifactId)).toEqual([
      { kind: "review.requested", detail: { reviewers: 2, required: null, showStatus: false } },
    ]);
  });

  it("refuses an address that cannot open the artifact, telling the requester to share it", async () => {
    const [ana, stranger] = [await user("Ana"), await user("Stranger")];
    const { owner, artifactId } = await setup([ana]);
    expect(await request(owner.id, artifactId, [ana.email, stranger.email])).toEqual({
      ok: false,
      code: "invalid_input",
      message: APPROVAL_MESSAGES.cannotOpen(stranger.email),
    });
    // An address with no account yet that is on the reader list may review once it signs up.
    const listed = "later@example.test";
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { addReaders: [listed] },
        now: NOW,
      }),
    );
    expect((await request(owner.id, artifactId, [listed])).ok).toBe(true);
  });

  it("grants nothing: a requested reviewer still opens only what the policy lets them", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    const [readers] = await db()
      .select({ count: schema.artifactReaders.email })
      .from(schema.artifactReaders)
      .where(eq(schema.artifactReaders.artifactId, artifactId));
    expect(readers).toBeDefined();
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { removeReaders: [ana.email] },
        now: NOW,
      }),
    );
    expect(await status(ana.id, artifactId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await verdict(ana.id, artifactId, "approve")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("needs the plan, after authorization, and keeps one open request per artifact", async () => {
    const ana = await user("Ana");
    const free = await setup([ana], null);
    expect(await request(free.owner.id, free.artifactId, [ana.email])).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("reviews"),
    });
    const pro = await setup([ana], "pro");
    expect(await request(pro.owner.id, pro.artifactId, [ana.email])).toMatchObject({
      code: "plan_required",
    });
    const stranger = await user();
    // Someone with no role on the owner learns nothing about the plan.
    expect(await request(stranger.id, free.artifactId, [ana.email])).toMatchObject({
      code: "not_found",
    });
    const team = await setup([ana]);
    value(await request(team.owner.id, team.artifactId, [ana.email]));
    expect(await request(team.owner.id, team.artifactId, [ana.email])).toEqual({
      ok: false,
      code: "invalid_input",
      message: APPROVAL_MESSAGES.alreadyOpen,
    });
  });

  it("bounds the reviewers and the required number", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    expect(await request(owner.id, artifactId, [])).toMatchObject({ code: "invalid_input" });
    expect(
      await request(owner.id, artifactId, [ana.email], { requiredApprovals: 2 }),
    ).toMatchObject({ code: "invalid_input", message: APPROVAL_MESSAGES.required(1) });
    const many = Array.from(
      { length: APPROVALS.reviewersPerRequest + 1 },
      (_, i) => `r${i}@x.test`,
    );
    expect(await request(owner.id, artifactId, many)).toMatchObject({ code: "invalid_input" });
  });

  it("rate limits requests per owner and per actor through the counters", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    await db()
      .global.$client.prepare(
        "insert into rate_limits (key, window_start, count) values (?1, ?2, ?3)",
      )
      .bind(`approvals:actor:${owner.id}`, NOW, APPROVALS.perActorPerHour.max)
      .run();
    expect(await request(owner.id, artifactId, [ana.email])).toEqual({
      ok: false,
      code: "rate_limited",
      message: APPROVAL_MESSAGES.rateLimited,
    });
    expect(await auditKinds(artifactId)).toEqual([]);
  });

  it("is refused on archived artifacts", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived", archivedAt: NOW, purgeAt: NOW + 90 * DAY })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await request(owner.id, artifactId, [ana.email])).toMatchObject({ code: "forbidden" });
  });
});

describe("roles in a workspace", () => {
  async function workspaceArtifact() {
    const w = await workspace();
    const prepared = await publishSite(w.editor.id);
    // Move it into the workspace like a publish there would.
    const moved = await transferArtifact(db(), env.ARTIFACTS, {
      userId: w.editor.id,
      artifactId: prepared.artifactId,
      workspace: w.slug,
      now: NOW,
    });
    expect(moved.ok).toBe(true);
    value(
      await updateAccess(db(), {
        userId: w.editor.id,
        artifactId: prepared.artifactId,
        change: { mode: "workspace" },
        now: NOW,
      }),
    );
    return { ...w, artifactId: prepared.artifactId };
  }

  it("lets admins and editors request, refuses members with forbidden and strangers as missing", async () => {
    const w = await workspaceArtifact();
    const stranger = await user();
    expect(await request(w.member.id, w.artifactId, [w.admin.email])).toMatchObject({
      code: "forbidden",
    });
    expect(await request(stranger.id, w.artifactId, [w.admin.email])).toMatchObject({
      code: "not_found",
    });
    const view = value(await request(w.editor.id, w.artifactId, [w.member.email, w.admin.email]));
    expect(view.review.reviewers).toBe(2);
  });

  it("lets a member reviewer give a verdict, and the other side see it", async () => {
    const w = await workspaceArtifact();
    value(await request(w.editor.id, w.artifactId, [w.member.email]));
    const mine = value(await verdict(w.member.id, w.artifactId, "approve", "Looks good"));
    expect(mine.role).toBe("reviewer");
    expect(mine.review.status).toBe("approved");
    const ownerView = value(await status(w.admin.id, w.artifactId));
    expect(ownerView.request?.reviewers[0]).toMatchObject({
      name: "Member",
      email: w.member.email,
      verdict: "approve",
      note: "Looks good",
    });
  });

  it("lets a service token request, change and cancel, but never give a verdict", async () => {
    const w = await workspaceArtifact();
    const body: ServiceTokenCreate = {
      label: "CI",
      role: "editor",
      scopes: ["artifacts:read", "artifacts:write"],
      expiresInDays: 30,
      restriction: { kind: "none" },
    };
    const created = value(
      await createServiceToken(db().global, { userId: w.admin.id, slug: w.slug, body, now: NOW }),
    );
    const tokenId = created.token.id;
    const asked = value(await request(tokenId, w.artifactId, [w.member.email]));
    expect(asked.role).toBe("owner");
    expect(asked.request?.requestedBy).toBeNull();
    expect(
      value(
        await changeApprovalReview(db(), {
          userId: tokenId,
          artifactId: w.artifactId,
          add: [w.admin.email],
          now: NOW,
        }),
      ).review.reviewers,
    ).toBe(2);
    expect(await verdict(tokenId, w.artifactId, "approve")).toMatchObject({ code: "not_found" });
    expect(
      value(
        await cancelApprovalReview(db(), { userId: tokenId, artifactId: w.artifactId, now: NOW }),
      ).review.status,
    ).toBe("none");
    const [event] = await db()
      .select({ actorType: schema.auditEvents.actorType })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.artifactId, w.artifactId),
          eq(schema.auditEvents.kind, "review.requested"),
        ),
      );
    expect(event?.actorType).toBe("token");
  });
});

describe("verdicts and the status", () => {
  it("approves, requests changes and lets a reviewer change their verdict", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await request(owner.id, artifactId, [ana.email, ben.email], { requiredApprovals: 1 }));
    expect(value(await verdict(ana.id, artifactId, "approve")).review.status).toBe("approved");
    expect(value(await verdict(ben.id, artifactId, "changes", "Fix the title")).review).toEqual({
      status: "changes_requested",
      reviewers: 2,
      required: 1,
      approvals: 1,
      changesRequested: 1,
    });
    expect(value(await verdict(ben.id, artifactId, "approve")).review.status).toBe("approved");
    const kinds = (await auditKinds(artifactId)).map((row) => [row.kind, row.detail]);
    expect(kinds).toContainEqual(["review.verdict", { verdict: "changes", version: 1 }]);
    // The note is never in the audit log.
    expect(JSON.stringify(kinds)).not.toContain("Fix the title");
  });

  it("records nothing when the same verdict is given again", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    value(await verdict(ana.id, artifactId, "approve", "ok"));
    value(await verdict(ana.id, artifactId, "approve", "ok"));
    const verdicts = (await auditKinds(artifactId)).filter((row) => row.kind === "review.verdict");
    expect(verdicts).toHaveLength(1);
  });

  it("refuses the requester who is not listed, readers who are not listed and a missing request alike", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    const refused = { ok: false, code: "forbidden", message: APPROVAL_MESSAGES.notReviewer };
    expect(await verdict(ana.id, artifactId, "approve")).toEqual(refused);
    value(await request(owner.id, artifactId, [ana.email]));
    expect(await verdict(owner.id, artifactId, "approve")).toEqual(refused);
    expect(await verdict(ben.id, artifactId, "approve")).toEqual(refused);
  });

  it("lets the requester review when they listed themselves", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [owner.email, ana.email], { requiredApprovals: 1 }));
    expect(value(await verdict(owner.id, artifactId, "approve")).review.status).toBe("approved");
  });

  it("refuses a verdict on a version the reviewer was not looking at", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    expect(
      await submitApprovalVerdict(db(), {
        userId: ana.id,
        artifactId,
        verdict: "approve",
        versionId: "v_old",
        now: NOW,
      }),
    ).toMatchObject({ code: "version_conflict" });
  });

  it("rate limits verdicts per reviewer and artifact", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    await db()
      .global.$client.prepare(
        "insert into rate_limits (key, window_start, count) values (?1, ?2, ?3)",
      )
      .bind(
        `approvals:verdict:${ana.id}:${artifactId}`,
        NOW,
        APPROVALS.verdictsPerReviewerPerHour.max,
      )
      .run();
    expect(await verdict(ana.id, artifactId, "approve")).toMatchObject({ code: "rate_limited" });
  });
});

describe("a new version", () => {
  it("resets the review on publish and keeps earlier verdicts as history", async () => {
    const ana = await user("Ana");
    const { owner, artifactId, versionId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    value(await verdict(ana.id, artifactId, "approve", "v1 is fine"));
    const next = await publishSite(owner.id, undefined, NOW + 10, { artifactId, versionId });
    const view = value(await status(owner.id, artifactId));
    expect(view.request?.versionId).toBe(next.versionId);
    expect(view.review).toMatchObject({ status: "pending", approvals: 0 });
    expect(view.request?.reviewers[0]?.verdict).toBeNull();
    expect(view.request?.history).toMatchObject([
      { versionId, verdict: "approve", note: "v1 is fine", name: "Ana" },
    ]);
    // The reviewer sees no history.
    expect(value(await status(ana.id, artifactId)).request?.history).toEqual([]);
  });

  it("resets the review on rollback too", async () => {
    const ana = await user("Ana");
    const { owner, artifactId, versionId } = await setup([ana]);
    const second = await publishSite(owner.id, undefined, NOW + 1, { artifactId, versionId });
    value(await request(owner.id, artifactId, [ana.email], { now: NOW + 2 }));
    value(await verdict(ana.id, artifactId, "approve", undefined, NOW + 3));
    const rolled = value(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId,
        versionId,
        baseVersionId: second.versionId,
        now: NOW + 4,
      }),
    );
    const view = value(await status(owner.id, artifactId));
    expect(view.request?.versionId).toBe(rolled.versionId);
    expect(view.review.status).toBe("pending");
  });

  it("refuses a verdict when a publish lands between its reads and its write", async () => {
    const ana = await user("Ana");
    const { owner, artifactId, versionId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    const raced = raceBeforeFirstWrite(async () => {
      await publishSite(owner.id, undefined, NOW + 5, { artifactId, versionId });
    });
    expect(
      await submitApprovalVerdict(raced, {
        userId: ana.id,
        artifactId,
        verdict: "approve",
        now: NOW + 6,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    const verdicts = await db().select().from(schema.reviewVerdicts);
    expect(verdicts.filter((row) => row.authorId === ana.id)).toEqual([]);
    expect((await auditKinds(artifactId)).map((row) => row.kind)).toEqual(["review.requested"]);
  });
});

describe("races", () => {
  it("keeps both of two verdicts given at once and decides the status on both", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await request(owner.id, artifactId, [ana.email, ben.email]));
    await Promise.all([
      verdict(ana.id, artifactId, "approve"),
      verdict(ben.id, artifactId, "approve"),
    ]);
    const view = value(await status(owner.id, artifactId));
    expect(view.review).toMatchObject({ status: "approved", approvals: 2 });
    const [row] = await db()
      .select({ announced: schema.reviewRequests.announced })
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.artifactId, artifactId));
    expect(row?.announced).toBe("approved");
  });

  it("applies one of two changes read at the same revision", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await request(owner.id, artifactId, [ana.email]));
    const raced = racing(() =>
      changeApprovalReview(db(), { userId: owner.id, artifactId, showStatus: true, now: NOW }),
    );
    expect(
      await changeApprovalReview(raced, {
        userId: owner.id,
        artifactId,
        add: [ben.email],
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "version_conflict", message: APPROVAL_MESSAGES.changed });
    expect(value(await status(owner.id, artifactId)).request?.showStatus).toBe(true);
  });

  it("does not create a request on an artifact transferred in between", async () => {
    const ana = await user("Ana");
    const w = await workspace();
    const { owner, artifactId } = await setup([ana]);
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: w.id, userId: owner.id, role: "editor", updatedAt: NOW });
    const raced = raceBeforeFirstWrite(async () => {
      value(
        await transferArtifact(db(), env.ARTIFACTS, {
          userId: owner.id,
          artifactId,
          workspace: w.slug,
          now: NOW,
        }),
      );
    });
    expect(
      await requestApprovalReview(raced, {
        userId: owner.id,
        artifactId,
        reviewers: [ana.email],
        now: NOW,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await db()
        .select()
        .from(schema.reviewRequests)
        .where(eq(schema.reviewRequests.artifactId, artifactId)),
    ).toEqual([]);
  });

  it("cancels the open request when the artifact moves to another owner", async () => {
    const ana = await user("Ana");
    const w = await workspace();
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: w.id, userId: owner.id, role: "editor", updatedAt: NOW });
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId,
        workspace: w.slug,
        now: NOW,
      }),
    );
    const [row] = await db()
      .select()
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.artifactId, artifactId));
    expect(row).toMatchObject({ cancelReason: "transferred" });
    expect(value(await status(owner.id, artifactId)).review.status).toBe("none");
  });
});

describe("who sees what", () => {
  it("shows a reviewer only what their comment scope shows of other reviewers", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await request(owner.id, artifactId, [ana.email, ben.email, owner.email]));
    value(await verdict(ben.id, artifactId, "changes", "Ben's note"));
    value(await verdict(owner.id, artifactId, "approve"));
    // `owner` visibility (the default): Ana sees herself and the owner side, not Ben.
    const own = value(await status(ana.id, artifactId));
    expect(own.role).toBe("reviewer");
    expect(own.review).toMatchObject({ reviewers: 3, changesRequested: 1 });
    expect(own.request?.reviewers.map((r) => [r.name, r.email, r.you])).toEqual([
      [null, null, true],
      ["Owner", null, false],
    ]);
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { commentVisibility: "everyone" },
        now: NOW,
      }),
    );
    const all = value(await status(ana.id, artifactId));
    expect(all.request?.reviewers.find((r) => r.name === "Ben")).toMatchObject({
      verdict: "changes",
      note: "Ben's note",
      email: null,
    });
  });

  it("shows other readers nothing unless the request shows its status", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    const none = value(await status(ben.id, artifactId));
    value(await request(owner.id, artifactId, [ana.email]));
    const hidden = value(await status(ben.id, artifactId));
    expect(hidden).toEqual(none);
    expect(hidden).toMatchObject({ role: "reader", review: { status: "none" }, request: null });
    value(
      await changeApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        showStatus: true,
        now: NOW,
      }),
    );
    expect(value(await status(ben.id, artifactId))).toMatchObject({
      review: { status: "pending", reviewers: 1 },
      request: null,
    });
  });

  it("answers anyone who cannot open the artifact like a missing one", async () => {
    const stranger = await user();
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    const missing = await status(stranger.id, "zzzzzzzzzz");
    expect(await status(stranger.id, artifactId)).toEqual(missing);
  });

  it("puts the block on the artifact list and the artifact, without names", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    expect(value(await getArtifact(db(), { userId: owner.id, artifactId })).review.status).toBe(
      "none",
    );
    value(await request(owner.id, artifactId, [ana.email]));
    value(await verdict(ana.id, artifactId, "approve"));
    const listed = value(
      await listArtifacts(db(), { actor: personalActorFor(owner.id), limit: 10, now: NOW }),
    );
    expect(listed.items.find((item) => item.id === artifactId)?.review).toEqual({
      status: "approved",
      reviewers: 1,
      required: 1,
      approvals: 1,
      changesRequested: 0,
    });
    expect(value(await getArtifact(db(), { userId: owner.id, artifactId })).review.status).toBe(
      "approved",
    );
  });
});

describe("changing and cancelling", () => {
  it("adds and removes reviewers, dropping the removed one's current verdict", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await request(owner.id, artifactId, [ana.email]));
    value(await verdict(ana.id, artifactId, "changes"));
    const view = value(
      await changeApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        add: [ben.email],
        remove: [ana.email],
        now: NOW,
      }),
    );
    expect(view.review).toMatchObject({ status: "pending", reviewers: 1, changesRequested: 0 });
    expect(await auditKinds(artifactId)).toContainEqual({
      kind: "review.changed",
      detail: { added: 1, removed: 1 },
    });
    expect(
      await changeApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        add: ["x@nowhere.test"],
        now: NOW,
      }),
    ).toMatchObject({
      code: "invalid_input",
      message: APPROVAL_MESSAGES.cannotOpen("x@nowhere.test"),
    });
  });

  it("records nothing for a change that changes nothing", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    value(
      await changeApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        showStatus: false,
        now: NOW,
      }),
    );
    expect((await auditKinds(artifactId)).map((row) => row.kind)).toEqual(["review.requested"]);
  });

  it("keeps cancelling and reading open when the plan lapses, but not changing", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    await grantPlan(owner.id, "free");
    expect(value(await status(owner.id, artifactId))).toMatchObject({
      available: false,
      review: { status: "pending" },
    });
    expect(value(await verdict(ana.id, artifactId, "approve")).review.status).toBe("approved");
    expect(
      await changeApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        showStatus: true,
        now: NOW,
      }),
    ).toMatchObject({ code: "plan_required" });
    expect(
      value(await cancelApprovalReview(db(), { userId: owner.id, artifactId, now: NOW })).request,
    ).toBeNull();
    expect(await cancelApprovalReview(db(), { userId: owner.id, artifactId, now: NOW })).toEqual({
      ok: false,
      code: "not_found",
      message: APPROVAL_MESSAGES.noRequest,
    });
    expect((await auditKinds(artifactId)).map((row) => row.kind)).toContain("review.cancelled");
  });
});

describe("deletion and access changes", () => {
  it("drops a reader removed from the list with the removal, and counts them again once back", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await request(owner.id, artifactId, [ana.email, ben.email]));
    value(await verdict(ana.id, artifactId, "approve"));
    value(await verdict(ben.id, artifactId, "approve"));
    expect(value(await status(owner.id, artifactId)).review.status).toBe("approved");
    // Ben's approval stops counting in the access change's own batch, not at the next scan.
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { removeReaders: [ben.email] },
        now: NOW,
      }),
    );
    expect(value(await status(owner.id, artifactId)).review).toMatchObject({
      status: "approved",
      reviewers: 1,
      required: 1,
      approvals: 1,
    });
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { addReaders: [ben.email] },
        now: NOW,
      }),
    );
    await recheckAll(NOW + 2 * DAY);
    expect(value(await status(owner.id, artifactId)).review).toMatchObject({ reviewers: 2 });
  });

  it("deletes a deleted account's verdicts and keeps the counts consistent", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await request(owner.id, artifactId, [ana.email, ben.email], { requiredApprovals: 1 }));
    value(await verdict(ana.id, artifactId, "approve", "fine"));
    await db().insert(schema.accountDeletions).values({ userId: ana.id, requestedAt: NOW });
    await advanceAccountDeletion(regionsFromEnv(env), ana.id, NOW);
    const rows = await db()
      .select()
      .from(schema.reviewVerdicts)
      .where(eq(schema.reviewVerdicts.authorId, ana.id));
    expect(rows).toEqual([]);
    expect(value(await status(owner.id, artifactId)).review).toMatchObject({
      status: "pending",
      approvals: 0,
    });
  });

  it("goes with the artifact when it is purged", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, artifactId));
    expect(
      await db()
        .select()
        .from(schema.reviewRequests)
        .where(eq(schema.reviewRequests.artifactId, artifactId)),
    ).toEqual([]);
  });
});

// Findings of the independent review of PR #180.

/** A D1 handle that records every call (a statement or a batch) with its SQL text. */
function recording() {
  const trips: string[][] = [];
  const queries = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property, receiver) {
        const real = Reflect.get(target, property, receiver);
        if (typeof real !== "function") return real;
        if (property === "bind") {
          return (...args: unknown[]) => wrap(real.apply(target, args), query);
        }
        if (["all", "raw", "run", "first"].includes(String(property))) {
          return (...args: unknown[]) => {
            trips.push([query]);
            return real.apply(target, args);
          };
        }
        return real.bind(target);
      },
    });
    queries.set(wrapped, query);
    return wrapped;
  };
  const d1 = new Proxy(env.DB, {
    get(target, property, receiver) {
      const real = Reflect.get(target, property, receiver);
      if (property === "prepare") return (query: string) => wrap(target.prepare(query), query);
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          trips.push(statements.map((s) => queries.get(s) ?? "?"));
          // biome-ignore lint/suspicious/noExplicitAny: the proxies stand in for D1 statements
          return target.batch(statements as any);
        };
      }
      return typeof real === "function" ? real.bind(target) : real;
    },
  });
  const global = globalDb(d1);
  return { database: regionalDb(d1, global), trips };
}

/** Runs the re-check until a pass ends (the cursor comes back to the start). */
/**
 * One whole pass of the scan over every open request. The tests share a database, so the cursor
 * a test before left may sit past this test's requests (their IDs are random): the pass starts
 * from the first request. The clock is fixed, so a slow machine never spends the time budget.
 */
async function recheckAll(now: number) {
  await db()
    .delete(schema.maintenanceCursors)
    .where(eq(schema.maintenanceCursors.name, "approval_reviewers"));
  for (let i = 0; i < 100; i += 1) {
    const run = await recheckApprovalReviewers(db(), now, { clock: () => 0 });
    const [cursor] = await db()
      .select()
      .from(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, "approval_reviewers"));
    if (run.checked === 0 || cursor?.cursor === "") return;
  }
}

async function publicArtifact(owner: Person) {
  const published = await publishSite(owner.id);
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public" })
    .where(eq(schema.artifacts.id, published.artifactId));
  return published;
}

async function serviceToken(slug: string, adminId: string, scopes: ServiceTokenCreate["scopes"]) {
  const body: ServiceTokenCreate = {
    label: "CI",
    role: "editor",
    scopes,
    expiresInDays: 30,
    restriction: { kind: "none" },
  };
  return value(await createServiceToken(db().global, { userId: adminId, slug, body, now: NOW }))
    .token.id;
}

async function workspaceArtifactOf(w: Awaited<ReturnType<typeof workspace>>) {
  const prepared = await publishSite(w.editor.id);
  value(
    await transferArtifact(db(), env.ARTIFACTS, {
      userId: w.editor.id,
      artifactId: prepared.artifactId,
      workspace: w.slug,
      now: NOW,
    }),
  );
  return prepared.artifactId;
}

describe("finding 1: asking tells nothing about accounts", () => {
  it("names nobody outside the owner's people until they give a verdict", async () => {
    const owner = await user("Owner");
    await grantPlan(owner.id, "team");
    const stranger = await user("Secret Name");
    const { artifactId } = await publicArtifact(owner);
    const asked = value(await request(owner.id, artifactId, [stranger.email, "nobody@x.test"]));
    expect(asked.request?.reviewers.map((r) => r.name)).toEqual([null, null]);
    expect(JSON.stringify(asked)).not.toContain("Secret Name");
    value(await verdict(stranger.id, artifactId, "approve"));
    const after = value(await status(owner.id, artifactId));
    expect(after.request?.reviewers.map((r) => r.name)).toEqual(["Secret Name", null]);
  });

  it("names the workspace's own people before any verdict", async () => {
    const w = await workspace();
    const artifactId = await workspaceArtifactOf(w);
    value(
      await updateAccess(db(), {
        userId: w.editor.id,
        artifactId,
        change: { mode: "workspace" },
        now: NOW,
      }),
    );
    const view = value(await request(w.editor.id, artifactId, [w.admin.email, w.member.email]));
    expect(view.request?.reviewers.map((r) => r.name)).toEqual(["Admin", "Member"]);
  });

  it("answers an address with an account and one without the same, with the same reads", async () => {
    const owner = await user("Owner");
    await grantPlan(owner.id, "team");
    const someone = await user("Someone");
    const { artifactId } = await setup([]);
    void artifactId;
    const restricted = await publishSite(owner.id);
    const run = async (email: string) => {
      const { database, trips } = recording();
      const answer = await requestApprovalReview(database, {
        userId: owner.id,
        artifactId: restricted.artifactId,
        reviewers: [email],
        now: NOW,
      });
      return { answer: answer.ok ? "ok" : answer.code, trips: trips.map((t) => t.join(";")) };
    };
    const withAccount = await run(someone.email);
    const without = await run("no-account@x.test");
    expect(withAccount.answer).toBe("invalid_input");
    expect(without.answer).toBe("invalid_input");
    expect(withAccount.trips).toEqual(without.trips);
    // On a public artifact both pass, again with the same reads.
    const open = await publicArtifact(owner);
    const pass = async (email: string) => {
      const { database, trips } = recording();
      const answer = await requestApprovalReview(database, {
        userId: owner.id,
        artifactId: open.artifactId,
        reviewers: [email],
        now: NOW,
      });
      await cancelApprovalReview(db(), { userId: owner.id, artifactId: open.artifactId, now: NOW });
      return { ok: answer.ok, trips: trips.map((t) => t.join(";")) };
    };
    const a = await pass(someone.email);
    const b = await pass("no-account-2@x.test");
    expect(a.ok && b.ok).toBe(true);
    expect(a.trips).toEqual(b.trips);
  });

  it("gives a token one refusal for every address, member or not, and never a name", async () => {
    const w = await workspace();
    const artifactId = await workspaceArtifactOf(w);
    const tokenId = await serviceToken(w.slug, w.admin.id, ["artifacts:read", "artifacts:write"]);
    const stranger = await user("Stranger");
    // A restricted artifact: a member who is not listed and a stranger both cannot take part.
    const member = await requestApprovalReview(db(), {
      userId: tokenId,
      artifactId,
      reviewers: [w.member.email],
      now: NOW,
    });
    const other = await requestApprovalReview(db(), {
      userId: tokenId,
      artifactId,
      reviewers: [stranger.email],
      now: NOW,
    });
    expect(member).toEqual({
      ok: false,
      code: "invalid_input",
      message: APPROVAL_MESSAGES.cannotOpenSome,
    });
    expect(other).toEqual(member);
    const asked = value(await request(tokenId, artifactId, [w.admin.email]));
    expect(asked.request?.reviewers.every((r) => r.email === null)).toBe(true);
  });
});

describe("finding 2: the scan's cost is bounded", () => {
  it("stays within its call budget with a backlog and resumes from its cursor", async () => {
    const owner = await user("Owner");
    await grantPlan(owner.id, "team");
    const reviewers = Array.from(
      { length: APPROVALS.reviewersPerRequest },
      (_, i) => `r${i}@x.test`,
    );
    const total = Math.floor((RECHECK_BUDGET.calls - 3) / RECHECK_CALLS_PER_REQUEST) + 5;
    // The costliest shape: restricted artifacts (the reader list is read) with a verdict each
    // (its author is read).
    const voter = await user("Voter");
    const listed = [voter.email, ...reviewers.slice(1)];
    for (let i = 0; i < total; i += 1) {
      const { artifactId, versionId } = await publishSite(owner.id);
      await db()
        .insert(schema.artifactReaders)
        .values(listed.map((email) => ({ artifactId, email })));
      await db()
        .global.$client.prepare("delete from rate_limits where key like 'approvals:%'")
        .run();
      const view = value(await request(owner.id, artifactId, listed));
      await db()
        .insert(schema.reviewVerdicts)
        .values({
          requestId: view.request?.id as string,
          email: voter.email,
          versionId,
          authorId: voter.id,
          verdict: "approve",
          updatedAt: NOW,
        });
    }
    await db().delete(schema.maintenanceCursors);
    const { database, trips } = recording();
    const first = await recheckApprovalReviewers(database, NOW + DAY, {
      limit: APPROVALS.recheckPerRun,
    });
    const calls = trips.length;
    expect(calls).toBeLessThanOrEqual(RECHECK_BUDGET.calls);
    expect(calls).toBeLessThanOrEqual(first.checked * RECHECK_CALLS_PER_REQUEST + 3);
    expect(first.checked).toBe(Math.floor((RECHECK_BUDGET.calls - 3) / RECHECK_CALLS_PER_REQUEST));
    const [cursor] = await db()
      .select()
      .from(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, "approval_reviewers"));
    expect(cursor?.cursor).not.toBe("");
    const second = await recheckApprovalReviewers(db(), NOW + DAY);
    expect(second.checked).toBeGreaterThan(0);
  });

  it("stops at its time budget", async () => {
    const owner = await user("Owner");
    await grantPlan(owner.id, "team");
    for (let i = 0; i < 3; i += 1) {
      const { artifactId } = await publicArtifact(owner);
      value(await request(owner.id, artifactId, ["a@x.test"]));
    }
    await db().delete(schema.maintenanceCursors);
    let t = 0;
    const run = await recheckApprovalReviewers(db(), NOW + DAY, {
      clock: () => {
        t += RECHECK_BUDGET.ms;
        return t;
      },
    });
    expect(run.checked).toBeLessThanOrEqual(1);
  });
});

describe("finding 3: lost access stops counting", () => {
  it("drops listed reviewers who no longer take part when the mode narrows, in the change's batch", async () => {
    const owner = await user("Owner");
    await grantPlan(owner.id, "team");
    const ana = await user("Ana");
    const { artifactId } = await publicArtifact(owner);
    value(await request(owner.id, artifactId, [ana.email, owner.email], { requiredApprovals: 1 }));
    value(await verdict(ana.id, artifactId, "approve"));
    expect(value(await status(owner.id, artifactId)).review.status).toBe("approved");
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { mode: "restricted" },
        now: NOW,
      }),
    );
    expect(value(await status(owner.id, artifactId)).review).toMatchObject({
      status: "pending",
      reviewers: 1,
      approvals: 0,
    });
  });

  it("re-checks the other counting reviewers before a verdict makes the status final", async () => {
    const [ana, ben, cy] = [await user("Ana"), await user("Ben"), await user("Cy")];
    const { owner, artifactId } = await setup([ana, ben, cy]);
    value(
      await request(owner.id, artifactId, [ana.email, ben.email, cy.email], {
        requiredApprovals: 2,
      }),
    );
    value(await verdict(ben.id, artifactId, "approve"));
    // Ben loses access without an access change the review hears of (like a membership loss).
    await db()
      .delete(schema.artifactReaders)
      .where(
        and(
          eq(schema.artifactReaders.artifactId, artifactId),
          eq(schema.artifactReaders.email, ben.email),
        ),
      );
    const after = value(await verdict(ana.id, artifactId, "approve"));
    expect(after.review).toMatchObject({ status: "pending", reviewers: 2, approvals: 1 });
  });

  it("drops a reader removed between the verdict's reads and its write", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await request(owner.id, artifactId, [ana.email, ben.email]));
    value(await verdict(ben.id, artifactId, "approve"));
    const raced = raceBeforeFirstWrite(async () => {
      value(
        await updateAccess(db(), {
          userId: owner.id,
          artifactId,
          change: { removeReaders: [ben.email] },
          now: NOW,
        }),
      );
    });
    value(
      await submitApprovalVerdict(raced, {
        userId: ana.id,
        artifactId,
        verdict: "changes",
        now: NOW + 1,
      }),
    );
    const [benRow] = await db()
      .select()
      .from(schema.reviewReviewers)
      .where(eq(schema.reviewReviewers.email, ben.email));
    expect(benRow?.droppedAt).not.toBeNull();
    expect(value(await status(owner.id, artifactId)).review).toMatchObject({
      status: "changes_requested",
      reviewers: 1,
      approvals: 0,
    });
  });
});

describe("finding 4: archived and suspended artifacts", () => {
  it.each([
    ["archived", { state: "archived" as const, archivedAt: NOW, purgeAt: NOW + 90 * DAY }],
    ["suspended", { state: "suspended" as const }],
    ["past its expiry", { expiresAt: NOW - DAY }],
  ])(
    "answers a reviewer like a missing artifact while %s, and keeps it for the owner",
    async (_, set) => {
      const ana = await user("Ana");
      const { owner, artifactId } = await setup([ana]);
      value(await request(owner.id, artifactId, [ana.email]));
      await db().update(schema.artifacts).set(set).where(eq(schema.artifacts.id, artifactId));
      const missing = await status(ana.id, "zzzzzzzzzz");
      expect(await status(ana.id, artifactId)).toEqual(missing);
      expect((await status(owner.id, artifactId)).ok).toBe(true);
    },
  );
});

describe("finding 5: tokens and people's data", () => {
  it.each([
    [["artifacts:read"], false],
    [["artifacts:read", "artifacts:write"], false],
    [["artifacts:read", "artifacts:share"], true],
  ] as const)("a token with %j sees addresses: %s, and never notes", async (scopes, emails) => {
    const w = await workspace();
    const artifactId = await workspaceArtifactOf(w);
    value(
      await updateAccess(db(), {
        userId: w.editor.id,
        artifactId,
        change: { mode: "workspace" },
        now: NOW,
      }),
    );
    value(await request(w.editor.id, artifactId, [w.member.email]));
    value(await verdict(w.member.id, artifactId, "approve", "New words", NOW + 6));
    // An earlier version's verdict is history.
    const [open] = await db()
      .select({ id: schema.reviewRequests.id })
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.artifactId, artifactId));
    await db()
      .insert(schema.reviewVerdicts)
      .values({
        requestId: open?.id as string,
        email: w.member.email,
        versionId: "ver_earlier",
        authorId: w.member.id,
        verdict: "changes",
        note: "Old words",
        noteBytes: 9,
        updatedAt: NOW,
      });
    const tokenId = await serviceToken(w.slug, w.admin.id, [...scopes]);
    const view = value(await status(tokenId, artifactId));
    const reviewer = view.request?.reviewers[0];
    expect(reviewer?.email).toBe(emails ? w.member.email : null);
    expect(reviewer?.verdict).toBe("approve");
    expect(reviewer?.note).toBeNull();
    expect(view.request?.history.length).toBeGreaterThan(0);
    expect(view.request?.history.every((entry) => entry.note === null)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("words");
  });
});

describe("finding 6: a verdict follows the person, not the address", () => {
  it("stops counting a verdict whose author changed address, and the scan deletes it", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    value(await verdict(ana.id, artifactId, "approve"));
    await db()
      .update(schema.users)
      .set({ email: `moved-${ana.email}` })
      .where(eq(schema.users.id, ana.id));
    expect(value(await status(owner.id, artifactId)).review).toMatchObject({
      status: "pending",
      approvals: 0,
    });
    const listed = value(await getArtifact(db(), { userId: owner.id, artifactId }));
    expect(listed.review.approvals).toBe(0);
    await recheckAll(NOW + DAY);
    const rows = await db()
      .select()
      .from(schema.reviewVerdicts)
      .where(eq(schema.reviewVerdicts.authorId, ana.id));
    expect(rows).toEqual([]);
  });

  it("never gives the next holder of an address the earlier holder's verdict", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await request(owner.id, artifactId, [ana.email]));
    value(await verdict(ana.id, artifactId, "changes", "Ana's note"));
    const address = ana.email;
    await db()
      .update(schema.users)
      .set({ email: `moved-${address}` })
      .where(eq(schema.users.id, ana.id));
    const bob = await user("Bob");
    await db().update(schema.users).set({ email: address }).where(eq(schema.users.id, bob.id));
    const bobView = value(await status(bob.id, artifactId));
    const mine = bobView.request?.reviewers.find((r) => r.you);
    expect(mine).toMatchObject({ verdict: null, note: null, name: null });
    const given = value(await verdict(bob.id, artifactId, "approve"));
    expect(given.review.status).toBe("approved");
    const rows = await db()
      .select()
      .from(schema.reviewVerdicts)
      .where(eq(schema.reviewVerdicts.email, address));
    expect(rows.map((row) => [row.authorId, row.verdict, row.note])).toEqual([
      [bob.id, "approve", null],
    ]);
  });
});
