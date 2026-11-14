import { DEFAULT_POLICY, planRequiredMessage, type WorkspacePolicy } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  type AnonymousOwner,
  anonymousGrantOpen,
  anonymousState,
  anonymousWriting,
  checkDataWriters,
  DATA_WRITER_MESSAGES,
} from "./data-writers.ts";
import { entitlements } from "./plans.ts";
import {
  changedFields,
  liftedFields,
  policyChangeDetail,
  policyChangeNeedsPlan,
  storedPolicy,
} from "./workspace-policies.ts";

const NOW = Date.UTC(2026, 10, 14);
const plan = (name: "free" | "enterprise") =>
  entitlements(
    name === "free"
      ? null
      : { plan: name, seats: 1, validUntil: null, overrides: null, grace: null },
    NOW,
  );
const ALLOWED: WorkspacePolicy = { ...DEFAULT_POLICY, anonymousDataWriters: "allowed" };

const personal: AnonymousOwner = {
  workspace: false,
  entitlements: plan("free"),
  policy: undefined,
};
const freeWorkspace: AnonymousOwner = {
  workspace: true,
  entitlements: plan("free"),
  policy: ALLOWED,
};
const strict: AnonymousOwner = {
  workspace: true,
  entitlements: plan("enterprise"),
  policy: DEFAULT_POLICY,
};
const open: AnonymousOwner = { workspace: true, entitlements: plan("enterprise"), policy: ALLOWED };

describe("anonymous writers", () => {
  it("lets a personal space decide alone, on any plan", () => {
    expect(anonymousWriting(personal)).toEqual({ ok: true, value: true });
  });

  it("needs policies in a workspace's plan before its policy, then the policy", () => {
    expect(anonymousWriting(freeWorkspace)).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("policies"),
    });
    expect(anonymousWriting(strict)).toEqual({
      ok: false,
      code: "policy_refused",
      message: DATA_WRITER_MESSAGES.policy,
    });
    expect(anonymousWriting({ ...strict, policy: undefined }).ok).toBe(false);
    expect(anonymousWriting(open)).toEqual({ ok: true, value: true });
  });

  it("always allows narrowing to signed-in writers", () => {
    for (const owner of [personal, freeWorkspace, strict, open]) {
      expect(checkDataWriters("signed_in", owner).ok).toBe(true);
    }
    expect(checkDataWriters("anyone", strict).ok).toBe(false);
    expect(checkDataWriters("anyone", open).ok).toBe(true);
  });

  it("tells the owner side whether anonymous writing works now", () => {
    expect(anonymousState("signed_in", open)).toBe("off");
    expect(anonymousState("anyone", open)).toBe("available");
    expect(anonymousState("anyone", freeWorkspace)).toBe("plan_required");
    expect(anonymousState("anyone", strict)).toBe("policy_refused");
  });

  it("opens a grant only for an active public artifact open to anyone, with the switch on", () => {
    const artifact = { state: "active", accessMode: "public", writers: "anyone" as const };
    const base = { enabled: true, artifact, owner: personal };
    expect(anonymousGrantOpen(base)).toBe(true);
    expect(anonymousGrantOpen({ ...base, enabled: false })).toBe(false);
    expect(anonymousGrantOpen({ ...base, artifact: null })).toBe(false);
    expect(anonymousGrantOpen({ ...base, owner: null })).toBe(false);
    expect(anonymousGrantOpen({ ...base, owner: strict })).toBe(false);
    for (const change of [
      { state: "archived" },
      { state: "suspended" },
      { accessMode: "authenticated" },
      { accessMode: "restricted" },
      { writers: "signed_in" as const },
      { writers: null },
    ]) {
      expect(anonymousGrantOpen({ ...base, artifact: { ...artifact, ...change } })).toBe(false);
    }
  });
});

describe("the anonymous writers policy", () => {
  it("needs the plan to allow anonymous writers, never to forbid them again", () => {
    expect(policyChangeNeedsPlan(DEFAULT_POLICY, ALLOWED)).toBe(true);
    expect(policyChangeNeedsPlan(ALLOWED, DEFAULT_POLICY)).toBe(false);
  });

  it("reports allowing as lifted, so a restore file cannot open it silently", () => {
    expect(liftedFields(DEFAULT_POLICY, ALLOWED)).toEqual(["anonymousDataWriters"]);
    expect(liftedFields(ALLOWED, DEFAULT_POLICY)).toEqual([]);
  });

  it("is a change of its own field, with its value in the audit detail", () => {
    expect(changedFields(DEFAULT_POLICY, ALLOWED)).toEqual(["anonymousDataWriters"]);
    expect(policyChangeDetail(DEFAULT_POLICY, ALLOWED, false)).toEqual({
      fields: ["anonymousDataWriters"],
      anonymousDataWriters: "allowed",
      confirmed: false,
    });
    expect(policyChangeDetail(ALLOWED, ALLOWED, false)).toEqual({ fields: [], confirmed: false });
  });

  it("is stored only while allowed", () => {
    expect(storedPolicy(DEFAULT_POLICY)).toBeNull();
    expect(storedPolicy(ALLOWED)).toMatchObject({ anonymousDataWriters: "allowed" });
    expect(storedPolicy({ ...DEFAULT_POLICY, publicAccess: "forbidden" })).not.toHaveProperty(
      "anonymousDataWriters",
    );
  });
});
