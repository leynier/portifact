// The maximum life of artifacts (decision 0023): validation and bounds, tightening and
// loosening, the effective-time rule, the expiry cap with pins, renewals, rollbacks and restores,
// and the restore rule of `apply-policies`.
import { DEFAULT_POLICY, LIMITS, WORKSPACE_POLICIES, WorkspacePolicy } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nextExpiry } from "./lifecycle.ts";
import {
  changedFields,
  checkPolicyImpact,
  checkPolicyPin,
  commentRetentionOf,
  commentRetentionTightened,
  commentTiming,
  describePolicy,
  liftedFields,
  maxLifeDeadline,
  maxLifeOf,
  maxLifeTightened,
  POLICY_MESSAGES,
  policyChangeDetail,
  policyChangeNeedsPlan,
  policyExpiry,
  policyOf,
  policyTouchesArtifacts,
  replacedMaxLife,
  retentionTiming,
  storedPolicy,
  threadDeadline,
  threadDeletable,
  uncappedExpiry,
} from "./workspace-policies.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 9, 30);
const NOTICE = WORKSPACE_POLICIES.retentionNoticeDays * DAY;
const policy = (overrides: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...overrides,
});
const life = (days: number, from = 0) =>
  policy({ artifactMaxDays: days, artifactMaxDaysFrom: from });

describe("the maximum life's shape", () => {
  it("accepts 7 to 3,650 whole days and nothing else", () => {
    for (const days of [7, 30, 3650]) {
      expect(WorkspacePolicy.safeParse(life(days)).success).toBe(true);
    }
    for (const days of [0, 6, 3651, 7.5, -1]) {
      expect(WorkspacePolicy.safeParse(life(days)).success).toBe(false);
    }
  });

  it("reads a policy stored before it as none, and is stored only while set", () => {
    const old = { ...DEFAULT_POLICY, publicAccess: "forbidden" } as Record<string, unknown>;
    delete old.artifactMaxDays;
    delete old.artifactMaxDaysFrom;
    expect(policyOf(JSON.stringify(old)).artifactMaxDays).toBeNull();
    const stored = storedPolicy(policy({ publicAccess: "forbidden" }));
    expect(stored).not.toHaveProperty("artifactMaxDays");
    expect(stored).not.toHaveProperty("artifactMaxDaysFrom");
    expect(storedPolicy(life(30, NOW))).toMatchObject({
      artifactMaxDays: 30,
      artifactMaxDaysFrom: NOW,
    });
    expect(storedPolicy(DEFAULT_POLICY)).toBeNull();
  });
});

describe("tightening and loosening", () => {
  const cases: [string, number | null, number | null, boolean][] = [
    ["setting one", null, 30, true],
    ["shortening it", 60, 30, true],
    ["keeping it", 30, 30, false],
    ["lengthening it", 30, 60, false],
    ["removing it", 30, null, false],
  ];
  it.each(cases)("%s: plan needed %#", (_, from, to, tightens) => {
    const current = from === null ? DEFAULT_POLICY : life(from, NOW);
    const next = to === null ? DEFAULT_POLICY : life(to, NOW);
    expect(policyChangeNeedsPlan(current, next)).toBe(tightens);
    expect(maxLifeTightened(current, next)).toBe(tightens);
    expect(changedFields(current, next)).toEqual(from === to ? [] : ["artifactMaxDays"]);
    // `apply-policies` never holds a longer or removed maximum life back (decision 0023).
    expect(liftedFields(current, next)).toEqual([]);
  });

  it("names the maximum life a change lengthens or removes, for the give-back", () => {
    expect(replacedMaxLife(life(30, NOW), life(60, NOW))).toEqual({ days: 30, from: NOW });
    expect(replacedMaxLife(life(30, NOW), DEFAULT_POLICY)).toEqual({ days: 30, from: NOW });
    expect(replacedMaxLife(life(30, NOW), life(30, NOW))).toBeNull();
    expect(replacedMaxLife(life(30, NOW), life(10, NOW))).toBeNull();
    expect(replacedMaxLife(DEFAULT_POLICY, life(10, NOW))).toBeNull();
  });

  it("touches artifacts while it is set, and records days and date in the audit detail", () => {
    expect(policyTouchesArtifacts(life(30))).toBe(true);
    expect(policyChangeDetail(DEFAULT_POLICY, life(30, NOW), true)).toMatchObject({
      fields: ["artifactMaxDays"],
      artifactMaxDays: 30,
      artifactMaxDaysFrom: NOW,
    });
    expect(policyChangeDetail(life(30, NOW), DEFAULT_POLICY, false)).toMatchObject({
      artifactMaxDays: null,
      artifactMaxDaysFrom: null,
    });
  });

  it("is described to the CLI and MCP with its date", () => {
    expect(describePolicy(life(90, Date.UTC(2026, 10, 18)))).toEqual([
      "artifacts are archived 90 days after their last publish or restore, and cannot be pinned (from 2026-11-18)",
    ]);
  });
});

describe("the effective-time rule", () => {
  const timed = (current: WorkspacePolicy, next: WorkspacePolicy) =>
    retentionTiming(current, next, NOW).artifactMaxDaysFrom;
  it("starts a new or shorter maximum after the notice period, whatever the client sent", () => {
    expect(timed(DEFAULT_POLICY, life(30, 0))).toBe(NOW + NOTICE);
    expect(timed(life(60, NOW - 100 * DAY), life(30, 1))).toBe(NOW + NOTICE);
  });
  it("keeps the date a longer or equal maximum had, so lengthening never binds sooner", () => {
    expect(timed(life(30, NOW + 3 * DAY), life(60, 0))).toBe(NOW + 3 * DAY);
    expect(timed(life(30, NOW - 9 * DAY), life(30, NOW + 99 * DAY))).toBe(NOW - 9 * DAY);
  });
  it("clears the date with the maximum", () => {
    expect(timed(life(30, NOW), DEFAULT_POLICY)).toBeNull();
  });
});

describe("the expiry cap", () => {
  const plan = nextExpiry(new Date(NOW)).getTime();
  // [what, policy, plan expiry, life start, expected expiry]
  const cases: [string, WorkspacePolicy | undefined, number, number, number][] = [
    ["a personal space", undefined, plan, NOW, plan],
    ["no maximum", DEFAULT_POLICY, plan, NOW, plan],
    ["a publish under a short maximum", life(7, 0), plan, NOW, NOW + 7 * DAY],
    ["a publish under a long maximum", life(90, 0), plan, NOW, plan],
    [
      "a renewal of an artifact published 20 days ago",
      life(25, 0),
      plan,
      NOW - 20 * DAY,
      NOW + 5 * DAY,
    ],
    // Never before now: the renewal service refuses this one (it would expire at once).
    ["a renewal past the maximum", life(10, 0), plan, NOW - 20 * DAY, NOW],
    ["a rollback, which starts a new life", life(10, 0), plan, NOW, NOW + 10 * DAY],
    ["a restore, which starts a new life", life(10, 0), plan, NOW, NOW + 10 * DAY],
    [
      "a deadline before the effective date",
      life(10, NOW + 6 * DAY),
      plan,
      NOW - 20 * DAY,
      NOW + 6 * DAY,
    ],
  ];
  it.each(cases)("%s", (_, owner, planExpiry, lifeStart, expected) => {
    expect(policyExpiry(owner, planExpiry, lifeStart, NOW)).toBe(expected);
    expect(uncappedExpiry(planExpiry, expected)).toBe(expected < planExpiry ? planExpiry : null);
  });

  it("never extends an expiry", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 3650 }),
        fc.integer({ min: 0, max: 2 * NOW }),
        fc.integer({ min: 0, max: 2 * NOW }),
        fc.integer({ min: 0, max: 2 * NOW }),
        (days, from, planExpiry, lifeStart) => {
          expect(
            policyExpiry(life(days, from), planExpiry, lifeStart, Math.min(planExpiry, NOW)),
          ).toBeLessThanOrEqual(planExpiry);
        },
      ),
    );
  });

  it("never writes an expiry before now, whatever the life start (review of PR 214)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 3650 }),
        fc.integer({ min: 0, max: 2 * NOW }),
        fc.integer({ min: 0, max: 2 * NOW }),
        fc.integer({ min: 0, max: 2 * NOW }),
        (days, from, lifeStart, now) => {
          // Every caller's plan expiry is in the future: a publish, renewal, restore or move.
          const planExpiry = now + LIMITS.activeDays * DAY;
          const expiry = policyExpiry(life(days, from), planExpiry, lifeStart, now);
          expect(expiry).toBeGreaterThanOrEqual(now);
          expect(expiry).toBeLessThanOrEqual(planExpiry);
        },
      ),
    );
  });

  it("never gives a just-published artifact an expiry in the past, or under 7 days", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 3650 }),
        fc.integer({ min: 0, max: 2 * NOW }),
        fc.integer({ min: 0, max: 2 * NOW }),
        (days, from, now) => {
          const planExpiry = now + LIMITS.activeDays * DAY;
          const expiry = policyExpiry(life(days, from), planExpiry, now, now);
          expect(expiry).toBeGreaterThanOrEqual(now + 7 * DAY);
        },
      ),
    );
  });

  it("never puts a deadline before the maximum takes effect", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 3650 }),
        fc.integer({ min: 0, max: 2 * NOW }),
        fc.integer({ min: 0, max: 2 * NOW }),
        (days, from, lifeStart) => {
          expect(maxLifeDeadline({ days, from }, lifeStart)).toBeGreaterThanOrEqual(from);
        },
      ),
    );
  });

  it("reads a policy without a maximum as none", () => {
    expect(maxLifeOf(undefined)).toBeNull();
    expect(maxLifeOf(DEFAULT_POLICY)).toBeNull();
    expect(maxLifeOf(life(30, NOW))).toEqual({ days: 30, from: NOW });
  });
});

describe("pins under a maximum life", () => {
  it("refuses pinning while one is set, pending or in effect, and names it", () => {
    expect(checkPolicyPin(undefined)).toEqual({ ok: true, value: true });
    expect(checkPolicyPin(DEFAULT_POLICY)).toEqual({ ok: true, value: true });
    expect(checkPolicyPin(life(30, NOW + NOTICE))).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.pinUnderMaxLife(30),
    });
  });
});

describe("the impact of a maximum life", () => {
  const none = {
    publicArtifacts: 0,
    readersOutside: 0,
    linksRevoked: 0,
    linksWithoutPassword: 0,
    linksOverLifetime: 0,
    artifactsAtStart: 0,
    artifactsSoon: 0,
    pinsLifted: 0,
    threadsAtStart: 0,
    messagesAtStart: 0,
    threadsSoon: 0,
  };
  it("is refused unconfirmed with every count, and again when a count grew", () => {
    const impact = { ...none, artifactsAtStart: 2, artifactsSoon: 5, pinsLifted: 1 };
    const refused = checkPolicyImpact(impact, undefined);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain(
        "2 active artifacts would be archived when the maximum life takes effect",
      );
      expect(refused.message).toContain("5 active artifacts would be archived within 30 days");
      expect(refused.message).toContain("1 pinned artifact would be unpinned");
    }
    expect(checkPolicyImpact(impact, impact).ok).toBe(true);
    for (const key of ["artifactsAtStart", "artifactsSoon", "pinsLifted"] as const) {
      expect(checkPolicyImpact({ ...impact, [key]: impact[key] + 1 }, impact)).toEqual({
        ok: false,
        code: "policy_refused",
        message: POLICY_MESSAGES.impactChanged,
      });
    }
  });
});

describe("comment retention (decision 0023)", () => {
  const rule = (days: number, from = 0) =>
    policy({ commentRetentionDays: days, commentRetentionFrom: from });

  it("accepts 30 to 3,650 whole days, and is stored only while set", () => {
    for (const days of [30, 365, 3650]) {
      expect(WorkspacePolicy.safeParse(rule(days)).success).toBe(true);
    }
    for (const days of [29, 3651, 30.5]) {
      expect(WorkspacePolicy.safeParse(rule(days)).success).toBe(false);
    }
    expect(storedPolicy(policy({ publicAccess: "forbidden" }))).not.toHaveProperty(
      "commentRetentionDays",
    );
    expect(storedPolicy(rule(90, NOW))).toMatchObject({
      commentRetentionDays: 90,
      commentRetentionFrom: NOW,
    });
  });

  it.each([
    ["setting it", null, 90, true],
    ["shortening it", 180, 90, true],
    ["keeping it", 90, 90, false],
    ["lengthening it", 90, 180, false],
    ["removing it", 90, null, false],
  ] as const)("%s: plan needed and tightened %#", (_, from, to, tightens) => {
    const current = from === null ? DEFAULT_POLICY : rule(from, NOW);
    const next = to === null ? DEFAULT_POLICY : rule(to, NOW);
    expect(policyChangeNeedsPlan(current, next)).toBe(tightens);
    expect(commentRetentionTightened(current, next)).toBe(tightens);
    // apply-policies never holds back a longer or removed retention.
    expect(liftedFields(current, next)).toEqual([]);
  });

  it("starts after the notice period, keeps its date when lengthened, and clears it when removed", () => {
    expect(commentTiming(DEFAULT_POLICY, rule(90, 0), NOW).commentRetentionFrom).toBe(NOW + NOTICE);
    expect(commentTiming(rule(90, NOW - DAY), rule(180, 0), NOW).commentRetentionFrom).toBe(
      NOW - DAY,
    );
    expect(commentTiming(rule(180, NOW - DAY), rule(90, 0), NOW).commentRetentionFrom).toBe(
      NOW + NOTICE,
    );
    expect(commentTiming(rule(90, NOW), DEFAULT_POLICY, NOW).commentRetentionFrom).toBeNull();
  });

  // [what, state, on current version, artifact state, last activity, moved in, deletable at NOW]
  const cases: [string, "open" | "resolved", boolean, string, number, number | null, boolean][] = [
    ["a resolved thread past its period", "resolved", true, "active", 100, null, true],
    ["an open thread on the current version", "open", true, "active", 400, null, false],
    ["an open thread on an earlier version", "open", false, "active", 100, null, true],
    ["a recent thread", "resolved", true, "active", 20, null, false],
    ["a thread on an archived artifact", "resolved", true, "archived", 100, null, true],
    ["a thread on a suspended artifact", "resolved", true, "suspended", 100, null, false],
    ["a thread moved in yesterday", "resolved", true, "active", 400, 1, false],
    ["a thread moved in 8 days ago", "resolved", true, "active", 400, 8, true],
  ];
  it.each(cases)("%s", (_, state, onCurrentVersion, artifactState, ago, movedAgo, expected) => {
    expect(
      threadDeletable(
        { days: 90, from: 0 },
        {
          state,
          onCurrentVersion,
          artifactState,
          lastActivity: NOW - ago * DAY,
          movedIn: movedAgo === null ? null : NOW - movedAgo * DAY,
        },
        NOW,
      ),
    ).toBe(expected);
  });

  it("never puts a deadline before the rule takes effect or within the move notice", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30, max: 3650 }),
        fc.integer({ min: 0, max: 2 * NOW }),
        fc.integer({ min: 0, max: 2 * NOW }),
        fc.option(fc.integer({ min: 0, max: 2 * NOW })),
        (days, from, lastActivity, movedIn) => {
          const deadline = threadDeadline({ days, from }, lastActivity, movedIn);
          expect(deadline).toBeGreaterThanOrEqual(from);
          expect(deadline).toBeGreaterThanOrEqual(lastActivity + days * DAY);
          if (movedIn !== null) {
            expect(deadline).toBeGreaterThanOrEqual(
              movedIn + WORKSPACE_POLICIES.commentMoveNoticeDays * DAY,
            );
          }
        },
      ),
    );
  });

  it("counts threads and messages in the impact, and refuses a confirmation that grew", () => {
    const none = {
      publicArtifacts: 0,
      readersOutside: 0,
      linksRevoked: 0,
      linksWithoutPassword: 0,
      linksOverLifetime: 0,
      artifactsAtStart: 0,
      artifactsSoon: 0,
      pinsLifted: 0,
      threadsAtStart: 3,
      messagesAtStart: 11,
      threadsSoon: 2,
    };
    const refused = checkPolicyImpact(none, undefined);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain(
        "3 comment threads would be deleted for good when comment retention takes effect",
      );
      expect(refused.message).toContain("11 messages in them would be deleted with them");
    }
    expect(checkPolicyImpact(none, none).ok).toBe(true);
    expect(checkPolicyImpact({ ...none, messagesAtStart: 12 }, none).ok).toBe(false);
  });

  it("is described to the CLI and MCP, and recorded in the audit detail", () => {
    expect(describePolicy(rule(90, Date.UTC(2026, 10, 18)))).toEqual([
      "comment threads are deleted 90 days after their last activity, except open ones on the current version (from 2026-11-18)",
    ]);
    expect(policyChangeDetail(DEFAULT_POLICY, rule(90, NOW), true)).toMatchObject({
      fields: ["commentRetentionDays"],
      commentRetentionDays: 90,
      commentRetentionFrom: NOW,
    });
    expect(commentRetentionOf(rule(90, NOW))).toEqual({ days: 90, from: NOW });
    expect(commentRetentionOf(DEFAULT_POLICY)).toBeNull();
  });
});
