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
  checkSingleFamily,
  describePolicy,
  isDefaultPolicy,
  liftedFields,
  networkAdmits,
  networkDecision,
  normalizePolicy,
  POLICY_MESSAGES,
  policyChangeDetail,
  policyChangeNeedsPlan,
  policyOf,
  requestVerdict,
  seesNetworks,
  shownPolicy,
  singleFamilyLists,
  storedPolicy,
  withoutRequestPolicies,
} from "./workspace-policies.ts";

const policy = (change: Partial<WorkspacePolicy>): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...change,
});
const from = (ip: string | null): RequestContext => ({ kind: "request", ip });
const WHO = { userId: "u1", now: 0 };
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
    expect(checkRequestPolicy(OFFICE, from(ip), caller, WHO).ok).toBe(admitted);
  });

  it("binds tokens with their own list only", () => {
    const ci = policy({ tokenIpAllowlist: ["203.0.113.0/24"] });
    expect(checkRequestPolicy(ci, from("203.0.113.4"), "token", WHO).ok).toBe(true);
    expect(checkRequestPolicy(ci, from("192.0.2.9"), "token", WHO)).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.networkToken("192.0.2.9"),
    });
    expect(checkRequestPolicy(ci, from("198.51.100.1"), "person", WHO).ok).toBe(true);
  });

  it("never binds background work, a personal space or the defaults", () => {
    expect(checkRequestPolicy(OFFICE, BACKGROUND, "person", WHO).ok).toBe(true);
    expect(checkRequestPolicy(undefined, from("198.51.100.1"), "person", WHO).ok).toBe(true);
    expect(checkRequestPolicy(DEFAULT_POLICY, UNKNOWN_REQUEST, "person", WHO).ok).toBe(true);
  });

  it("refuses naming the policy and the caller's own address, never the networks", () => {
    const refused = checkRequestPolicy(OFFICE, from("198.51.100.1"), "person", WHO);
    expect(refused).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.networkPerson("198.51.100.1"),
    });
    if (refused.ok) return;
    expect(refused.message).toContain("network policy");
    expect(refused.message).toContain("198.51.100.1");
    expect(refused.message).not.toContain("192.0.2");
    expect(checkRequestPolicy(OFFICE, UNKNOWN_REQUEST, "person", WHO)).toMatchObject({
      message: POLICY_MESSAGES.networkPerson(null),
    });
    expect(POLICY_MESSAGES.networkToken(null)).toContain("an unknown address");
  });
});

describe("lock-out safety", () => {
  it("refuses a people allowlist that leaves out the saving admin's address", () => {
    expect(checkPolicyKeepsCaller(OFFICE, from("192.0.2.9"), WHO).ok).toBe(true);
    expect(checkPolicyKeepsCaller(OFFICE, from("198.51.100.1"), WHO)).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.networkLocksOut("198.51.100.1"),
    });
    expect(checkPolicyKeepsCaller(OFFICE, UNKNOWN_REQUEST, WHO)).toMatchObject({
      message: POLICY_MESSAGES.networkLocksOut(null),
    });
  });

  it("does not check a token allowlist, no allowlist, or the operator", () => {
    expect(
      checkPolicyKeepsCaller(policy({ tokenIpAllowlist: ["203.0.113.0/24"] }), from("1.1.1.1"), WHO)
        .ok,
    ).toBe(true);
    expect(checkPolicyKeepsCaller(DEFAULT_POLICY, from("1.1.1.1"), WHO).ok).toBe(true);
    expect(checkPolicyKeepsCaller(OFFICE, BACKGROUND, WHO).ok).toBe(true);
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

describe("review fixes", () => {
  it("reports and checks single-family lists for what a save sets or changes", () => {
    const v4 = policy({ ipAllowlist: ["192.0.2.0/24"] });
    const both = policy({ ipAllowlist: ["192.0.2.0/24", "2001:db8::/32"] });
    expect(singleFamilyLists(DEFAULT_POLICY, v4)).toEqual({ people: "ipv4", tokens: null });
    expect(singleFamilyLists(DEFAULT_POLICY, both)).toEqual({ people: null, tokens: null });
    // Unchanged: not asked again.
    expect(singleFamilyLists(v4, { ...v4, publicAccess: "forbidden" })).toEqual({
      people: null,
      tokens: null,
    });
    expect(
      singleFamilyLists(DEFAULT_POLICY, policy({ tokenIpAllowlist: ["2001:db8::/32"] })),
    ).toEqual({ people: null, tokens: "ipv6" });
    const required = { people: "ipv4", tokens: null } as const;
    expect(checkSingleFamily({ people: null, tokens: null }, undefined).ok).toBe(true);
    expect(checkSingleFamily(required, required).ok).toBe(true);
    expect(checkSingleFamily(required, undefined)).toMatchObject({ code: "policy_refused" });
    expect(checkSingleFamily(required, { people: "ipv6", tokens: null })).toMatchObject({
      code: "policy_refused",
    });
    expect(checkSingleFamily({ people: null, tokens: "ipv4" }, undefined)).toMatchObject({
      message: expect.stringContaining("service tokens"),
    });
  });

  it("shows the networks only to an admin the policy admits", () => {
    expect(seesNetworks("admin", false)).toBe(true);
    expect(seesNetworks("admin", true)).toBe(false);
    expect(seesNetworks("editor", false)).toBe(false);
  });

  it.each([
    [OFFICE, DEFAULT_POLICY, ["ipAllowlist"]],
    [OFFICE, policy({ ipAllowlist: ["198.51.100.0/24"] }), ["ipAllowlist"]],
    [OFFICE, policy({ ipAllowlist: ["192.0.2.0/25"] }), []],
    [DEFAULT_POLICY, OFFICE, []],
    [policy({ publicAccess: "forbidden" }), DEFAULT_POLICY, ["publicAccess"]],
    [
      policy({ readerDomains: ["a.example"] }),
      policy({ readerDomains: ["b.example"] }),
      ["readerDomains"],
    ],
    [
      policy({ readerDomains: ["a.example", "b.example"] }),
      policy({ readerDomains: ["a.example"] }),
      [],
    ],
    [
      policy({ shareLinks: "disabled" }),
      policy({ shareLinks: "password_required" }),
      ["shareLinks"],
    ],
    [policy({ shareLinkMaxDays: 5 }), policy({ shareLinkMaxDays: 10 }), ["shareLinkMaxDays"]],
    [policy({ defaultAccess: "workspace" }), DEFAULT_POLICY, []],
    [policy({ tokenIpAllowlist: ["203.0.113.0/24"] }), DEFAULT_POLICY, ["tokenIpAllowlist"]],
  ] as const)("lifting %#", (current, next, lifted) => {
    expect(liftedFields(current, next)).toEqual(lifted);
  });

  it("refuses everyone a stored list binds when it does not parse, without throwing", () => {
    const broken = policy({ ipAllowlist: ["10.0.0.0/33"] });
    expect(requestVerdict(broken, from("10.0.0.1"), "person")).toBe("unreadable");
    expect(checkRequestPolicy(broken, from("10.0.0.1"), "person", WHO)).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.networkUnreadable,
    });
    expect(requestVerdict(broken, BACKGROUND, "person")).toBe("allowed");
    expect(
      networkDecision({
        accessMode: "workspace",
        networks: ["bad"],
        signedIn: true,
        ip: "1.1.1.1",
      }),
    ).toBe("unreadable");
    expect(
      networkAdmits({ accessMode: "workspace", networks: ["bad"], signedIn: true, ip: "1.1.1.1" }),
    ).toBe(false);
    // Lifting a broken list is loosening: it admitted nobody.
    expect(policyChangeNeedsPlan(broken, DEFAULT_POLICY)).toBe(false);
  });
});

describe("what a workspace's row stores", () => {
  const sharing: WorkspacePolicy = { ...DEFAULT_POLICY, shareLinks: "disabled" };

  it("stores nothing for the defaults", () => {
    expect(storedPolicy(DEFAULT_POLICY)).toBeNull();
    expect(
      storedPolicy({ ...DEFAULT_POLICY, ipAllowlist: null, tokenIpAllowlist: null }),
    ).toBeNull();
  });

  it("leaves out a network list the policy does not set", () => {
    // The release before network lists reads the row with a strict schema: a policy that only
    // restricts sharing must not carry the new keys, or a rollback breaks its whole workspace.
    const stored = storedPolicy(sharing);
    expect(stored).not.toBeNull();
    expect(Object.keys(stored ?? {})).not.toContain("ipAllowlist");
    expect(Object.keys(stored ?? {})).not.toContain("tokenIpAllowlist");
    expect(stored).toMatchObject({ shareLinks: "disabled" });
  });

  it("keeps the lists that are set, each on its own", () => {
    const people = storedPolicy({ ...DEFAULT_POLICY, ipAllowlist: ["203.0.113.0/24"] });
    expect(people).toMatchObject({ ipAllowlist: ["203.0.113.0/24"] });
    expect(Object.keys(people ?? {})).not.toContain("tokenIpAllowlist");
    const tokens = storedPolicy({ ...sharing, tokenIpAllowlist: ["2001:db8::/32"] });
    expect(tokens).toMatchObject({ tokenIpAllowlist: ["2001:db8::/32"], shareLinks: "disabled" });
    expect(Object.keys(tokens ?? {})).not.toContain("ipAllowlist");
  });

  it("reads back exactly the policy that was stored, as an object or as JSON", () => {
    for (const policy of [
      DEFAULT_POLICY,
      sharing,
      { ...sharing, ipAllowlist: ["203.0.113.0/24"] },
      { ...DEFAULT_POLICY, ipAllowlist: ["203.0.113.0/24"], tokenIpAllowlist: ["2001:db8::/32"] },
    ] satisfies WorkspacePolicy[]) {
      const stored = storedPolicy(policy);
      expect(policyOf(stored)).toEqual(policy);
      expect(policyOf(stored === null ? null : JSON.stringify(stored))).toEqual(policy);
    }
  });
});
