// The request policies of a workspace (decision 0020): network allowlists for people and for
// service tokens, how they are validated, compared, shown, checked and recorded.
import {
  BACKGROUND,
  DEFAULT_POLICY,
  type RequestContext,
  UNKNOWN_REQUEST,
  type WorkspacePolicy,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  changedFields,
  checkPolicyKeepsCaller,
  checkRequestPolicy,
  describePolicy,
  isDefaultPolicy,
  networkAdmits,
  normalizePolicy,
  POLICY_MESSAGES,
  policyChangeDetail,
  policyChangeNeedsPlan,
  shownPolicy,
  withoutRequestPolicies,
} from "./workspace-policies.ts";

const policy = (change: Partial<WorkspacePolicy>): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...change,
});
const from = (ip: string | null): RequestContext => ({ kind: "request", ip });
const OFFICE = policy({ ipAllowlist: ["192.0.2.0/24", "2001:db8::/32"] });

describe("checking a request against the network allowlists", () => {
  it.each([
    ["192.0.2.9", "person", true],
    ["2001:db8::5", "person", true],
    ["::ffff:192.0.2.9", "person", true],
    ["198.51.100.1", "person", false],
    [null, "person", false],
    // Tokens have their own list, absent here: they are not bound by the people's list.
    ["198.51.100.1", "token", true],
  ] as const)("from %s, a %s is admitted: %s", (ip, caller, admitted) => {
    expect(checkRequestPolicy(OFFICE, from(ip), caller).ok).toBe(admitted);
  });

  it("binds tokens with their own list only", () => {
    const ci = policy({ tokenIpAllowlist: ["203.0.113.0/24"] });
    expect(checkRequestPolicy(ci, from("203.0.113.4"), "token").ok).toBe(true);
    expect(checkRequestPolicy(ci, from("192.0.2.9"), "token")).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.networkToken("192.0.2.9"),
    });
    expect(checkRequestPolicy(ci, from("198.51.100.1"), "person").ok).toBe(true);
  });

  it("never binds background work, a personal space or the defaults", () => {
    expect(checkRequestPolicy(OFFICE, BACKGROUND, "person").ok).toBe(true);
    expect(checkRequestPolicy(undefined, from("198.51.100.1"), "person").ok).toBe(true);
    expect(checkRequestPolicy(DEFAULT_POLICY, UNKNOWN_REQUEST, "person").ok).toBe(true);
  });

  it("refuses naming the policy and the caller's own address, never the networks", () => {
    const refused = checkRequestPolicy(OFFICE, from("198.51.100.1"), "person");
    expect(refused).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.networkPerson("198.51.100.1"),
    });
    if (refused.ok) return;
    expect(refused.message).toContain("network policy");
    expect(refused.message).toContain("198.51.100.1");
    expect(refused.message).not.toContain("192.0.2");
    expect(checkRequestPolicy(OFFICE, UNKNOWN_REQUEST, "person")).toMatchObject({
      message: POLICY_MESSAGES.networkPerson(null),
    });
    expect(POLICY_MESSAGES.networkToken(null)).toContain("an unknown address");
  });
});

describe("lock-out safety", () => {
  it("refuses a people allowlist that leaves out the saving admin's address", () => {
    expect(checkPolicyKeepsCaller(OFFICE, from("192.0.2.9")).ok).toBe(true);
    expect(checkPolicyKeepsCaller(OFFICE, from("198.51.100.1"))).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.networkLocksOut("198.51.100.1"),
    });
    expect(checkPolicyKeepsCaller(OFFICE, UNKNOWN_REQUEST)).toMatchObject({
      message: POLICY_MESSAGES.networkLocksOut(null),
    });
  });

  it("does not check a token allowlist, no allowlist, or the operator", () => {
    expect(
      checkPolicyKeepsCaller(policy({ tokenIpAllowlist: ["203.0.113.0/24"] }), from("1.1.1.1")).ok,
    ).toBe(true);
    expect(checkPolicyKeepsCaller(DEFAULT_POLICY, from("1.1.1.1")).ok).toBe(true);
    expect(checkPolicyKeepsCaller(OFFICE, BACKGROUND).ok).toBe(true);
  });
});

describe("validating and comparing", () => {
  it("normalizes both allowlists and names a bad range", () => {
    expect(
      normalizePolicy(
        policy({ ipAllowlist: ["192.0.2.7/24", "192.0.2.9"], tokenIpAllowlist: ["2001:DB8::1"] }),
      ),
    ).toEqual({
      ok: true,
      value: policy({ ipAllowlist: ["192.0.2.0/24"], tokenIpAllowlist: ["2001:db8::1/128"] }),
    });
    expect(normalizePolicy(policy({ ipAllowlist: ["0.0.0.0/0"] }))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(normalizePolicy(policy({ tokenIpAllowlist: ["office"] }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("office"),
    });
    expect(isDefaultPolicy(OFFICE)).toBe(false);
    expect(isDefaultPolicy(withoutRequestPolicies(OFFICE))).toBe(true);
  });

  it.each([
    // Setting one tightens.
    [null, ["192.0.2.0/24"], true],
    // Narrowing tightens.
    [["192.0.2.0/24"], ["192.0.2.0/25"], true],
    // Replacing one network with another tightens.
    [["192.0.2.0/24"], ["198.51.100.0/24"], true],
    // Widening, adding a network or lifting it loosens.
    [["192.0.2.0/25"], ["192.0.2.0/24"], false],
    [["192.0.2.0/24"], ["192.0.2.0/24", "198.51.100.0/24"], false],
    [["192.0.2.0/24"], null, false],
  ] as const)("from %j to %j needs the plan: %s", (current, next, needsPlan) => {
    for (const field of ["ipAllowlist", "tokenIpAllowlist"] as const) {
      const a = policy({ [field]: current === null ? null : [...current] });
      const b = policy({ [field]: next === null ? null : [...next] });
      expect(changedFields(a, b)).toEqual([field]);
      expect(policyChangeNeedsPlan(a, b)).toBe(needsPlan);
    }
  });

  it("records counts only in the audit detail", () => {
    const detail = policyChangeDetail(DEFAULT_POLICY, OFFICE, false);
    expect(detail).toEqual({ fields: ["ipAllowlist"], ipRanges: 2, confirmed: false });
    expect(JSON.stringify(detail)).not.toContain("192.0.2");
    expect(
      policyChangeDetail(policy({ tokenIpAllowlist: ["203.0.113.0/24"] }), DEFAULT_POLICY, false),
    ).toEqual({ fields: ["tokenIpAllowlist"], tokenIpRanges: null, confirmed: false });
  });
});

describe("showing", () => {
  it("shows the networks to admins and only that they exist to everyone else", () => {
    const both = policy({ ...OFFICE, tokenIpAllowlist: ["203.0.113.0/24"] });
    expect(shownPolicy(both, true)).toEqual(both);
    expect(shownPolicy(both, false)).toEqual({
      ...both,
      ipAllowlist: "hidden",
      tokenIpAllowlist: "hidden",
    });
    expect(shownPolicy(DEFAULT_POLICY, false)).toEqual(DEFAULT_POLICY);
  });

  it("describes them without their networks", () => {
    const lines = describePolicy(
      shownPolicy({ ...OFFICE, tokenIpAllowlist: ["1.1.1.1/32"] }, false),
    );
    expect(lines).toEqual([
      "people only from approved networks",
      "service tokens only from approved networks",
    ]);
    expect(describePolicy(OFFICE).join(" ")).not.toContain("192.0.2");
  });
});

describe("the content Worker's check", () => {
  const networks = ["192.0.2.0/24"];
  it.each([
    ["workspace", true, "192.0.2.1", true],
    ["workspace", true, "198.51.100.1", false],
    ["workspace", true, null, false],
    ["workspace", true, "::ffff:192.0.2.1", true],
    // Anonymous (public) visitors and share links name nobody: never bound.
    ["workspace", false, "198.51.100.1", true],
    // The outsiders a restricted or domain artifact names are not bound here.
    ["restricted", true, "198.51.100.1", true],
    ["domain", true, "198.51.100.1", true],
    ["authenticated", true, "198.51.100.1", true],
    ["public", true, "198.51.100.1", true],
  ] as const)("%s, signed in %s, from %s: %s", (accessMode, signedIn, ip, admitted) => {
    expect(networkAdmits({ accessMode, networks, signedIn, ip })).toBe(admitted);
  });

  it("admits everyone without an allowlist", () => {
    expect(
      networkAdmits({ accessMode: "workspace", networks: null, signedIn: true, ip: null }),
    ).toBe(true);
  });
});
