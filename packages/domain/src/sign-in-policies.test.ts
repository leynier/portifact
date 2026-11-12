// The sign-in policies of a workspace (decision 0021): a maximum session age and the kinds of
// client allowed to act, how they are validated, compared, stored, described and checked.
import {
  BACKGROUND,
  CLI_CLIENT_ID,
  type Credential,
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
  liftedFields,
  normalizePolicy,
  POLICY_MESSAGES,
  policyChangeDetail,
  policyChangeNeedsPlan,
  policyOf,
  requestRefusal,
  signInVerdict,
  storedPolicy,
  withoutRequestPolicies,
} from "./workspace-policies.ts";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const policy = (change: Partial<WorkspacePolicy>): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...change,
});
const WHO = { userId: "u1", now: NOW };
const as = (credential?: Credential | null): RequestContext => ({
  kind: "request",
  ip: "192.0.2.9",
  ...(credential === undefined ? {} : { credential }),
});
const session = (hoursAgo: number, userId = "u1"): Credential => ({
  kind: "session",
  userId,
  signedInAt: NOW - hoursAgo * HOUR,
  method: { kind: "code" },
});
const cli = (hoursAgo: number | null): Credential => ({
  kind: "oauth",
  termsAccepted: true,
  userId: "u1",
  clientId: CLI_CLIENT_ID,
  client: "cli",
  signedInAt: hoursAgo === null ? null : NOW - hoursAgo * HOUR,
  method: { kind: "code" },
});
const app = (hoursAgo: number | null): Credential => ({
  kind: "oauth",
  termsAccepted: true,
  userId: "u1",
  clientId: "dcr_123",
  client: "oauth_apps",
  signedInAt: hoursAgo === null ? null : NOW - hoursAgo * HOUR,
  method: { kind: "code" },
});
const EIGHT_HOURS = policy({ sessionMaxHours: 8 });
const CLI_ONLY = policy({ allowedClients: ["cli"] });
const DASHBOARD_ONLY = policy({ allowedClients: [] });

describe("the maximum session age", () => {
  it.each([
    ["a fresh dashboard session", session(1), "allowed"],
    ["a session exactly at the limit", session(8), "allowed"],
    ["a session past the limit", session(8.001), "session_age"],
    ["a CLI token from a fresh sign-in", cli(2), "allowed"],
    ["a CLI token from an old sign-in, however recently refreshed", cli(30), "session_age"],
    ["a token whose record does not say when", cli(null), "session_unknown"],
    ["an app's token from an old sign-in", app(9), "session_age"],
    ["no credential recorded", undefined, "session_unknown"],
    ["two different credentials in one request", null, "session_unknown"],
    ["someone else's credential", session(1, "u2"), "session_unknown"],
    [
      "a service token's credential for a person",
      { kind: "service_token", userId: "u1" },
      "session_unknown",
    ],
  ] as const)("%s: %s", (_, credential, verdict) => {
    expect(signInVerdict(EIGHT_HOURS, as(credential), "person", WHO)).toBe(verdict);
  });

  it("never binds service tokens, background work, a personal space or the defaults", () => {
    expect(signInVerdict(EIGHT_HOURS, as(undefined), "token", WHO)).toBe("allowed");
    expect(signInVerdict(EIGHT_HOURS, BACKGROUND, "person", WHO)).toBe("allowed");
    expect(signInVerdict(undefined, as(undefined), "person", WHO)).toBe("allowed");
    expect(signInVerdict(DEFAULT_POLICY, UNKNOWN_REQUEST, "person", WHO)).toBe("allowed");
  });

  it("refuses in words that name the fix of the client that asked", () => {
    expect(checkRequestPolicy(EIGHT_HOURS, as(session(9)), "person", WHO)).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.sessionAge(8, session(9)),
      reason: "session_age",
    });
    expect(POLICY_MESSAGES.sessionAge(8, session(9))).toContain("Sign in again");
    expect(POLICY_MESSAGES.sessionAge(8, cli(9))).toContain("portifact login");
    expect(POLICY_MESSAGES.sessionAge(8, app(9))).toContain("reconnect this app");
    expect(POLICY_MESSAGES.sessionAge(48, session(49))).toContain("every 2 days");
    expect(POLICY_MESSAGES.sessionAge(24, session(25))).toContain("every 1 day");
    expect(POLICY_MESSAGES.sessionAge(1, session(2))).toContain("every 1 hour");
    expect(POLICY_MESSAGES.sessionAge(36, session(37))).toContain("every 36 hours");
    expect(checkRequestPolicy(EIGHT_HOURS, as(cli(null)), "person", WHO)).toMatchObject({
      message: POLICY_MESSAGES.sessionUnknown(cli(null)),
    });
    expect(POLICY_MESSAGES.sessionUnknown(undefined)).toContain("Sign in again");
  });

  it("checks the network before the sign-in", () => {
    const both = policy({ sessionMaxHours: 8, ipAllowlist: ["203.0.113.0/24"] });
    expect(checkRequestPolicy(both, as(session(9)), "person", WHO)).toMatchObject({
      message: POLICY_MESSAGES.networkPerson("192.0.2.9"),
    });
    expect(requestRefusal(both, as(session(9)), "person", WHO)).toBe("network");
  });
});

describe("the allowed clients", () => {
  it.each([
    [CLI_ONLY, session(1), "allowed"],
    [CLI_ONLY, cli(1), "allowed"],
    [CLI_ONLY, app(1), "client"],
    [DASHBOARD_ONLY, session(500), "allowed"],
    [DASHBOARD_ONLY, cli(1), "client"],
    [DASHBOARD_ONLY, app(1), "client"],
    [policy({ allowedClients: ["oauth_apps"] }), cli(1), "client"],
    [policy({ allowedClients: ["cli", "oauth_apps"] }), app(1), "allowed"],
    [CLI_ONLY, undefined, "client_unknown"],
    [CLI_ONLY, session(1, "u2"), "client_unknown"],
  ] as const)("%# %o", (rule, credential, verdict) => {
    expect(signInVerdict(rule, as(credential), "person", WHO)).toBe(verdict);
  });

  it("checks the client before the age: signing in again would not help", () => {
    const both = policy({ sessionMaxHours: 8, allowedClients: [] });
    expect(signInVerdict(both, as(cli(30)), "person", WHO)).toBe("client");
    expect(checkRequestPolicy(both, as(cli(30)), "person", WHO)).toMatchObject({
      message: POLICY_MESSAGES.client("cli"),
      reason: "client",
    });
    expect(checkRequestPolicy(both, as(app(1)), "person", WHO)).toMatchObject({
      message: POLICY_MESSAGES.client("oauth_apps"),
    });
    expect(checkRequestPolicy(both, as(undefined), "person", WHO)).toMatchObject({
      message: POLICY_MESSAGES.clientUnknown,
    });
    expect(requestRefusal(both, as(app(1)), "person", WHO)).toBe("client");
    expect(requestRefusal(both, as(undefined), "person", WHO)).toBe("client");
    expect(requestRefusal(both, as(session(9)), "person", WHO)).toBe("session_age");
    expect(requestRefusal(EIGHT_HOURS, as(undefined), "person", WHO)).toBe("session_age");
    expect(requestRefusal(both, as(session(1)), "person", WHO)).toBeNull();
    expect(POLICY_MESSAGES.client("cli")).toContain("Portifact CLI");
    expect(POLICY_MESSAGES.client("oauth_apps")).toContain("MCP clients");
  });
});

describe("validating, comparing and storing the sign-in policies", () => {
  it("normalizes the allowed clients to one spelling", () => {
    expect(normalizePolicy(policy({ allowedClients: ["oauth_apps", "cli", "cli"] }))).toMatchObject(
      { ok: true, value: { allowedClients: ["cli", "oauth_apps"] } },
    );
    expect(normalizePolicy(policy({ allowedClients: [] }))).toMatchObject({
      ok: true,
      value: { allowedClients: [] },
    });
  });

  it.each([
    [DEFAULT_POLICY, EIGHT_HOURS, true],
    [EIGHT_HOURS, policy({ sessionMaxHours: 4 }), true],
    [EIGHT_HOURS, policy({ sessionMaxHours: 24 }), false],
    [EIGHT_HOURS, DEFAULT_POLICY, false],
    [DEFAULT_POLICY, CLI_ONLY, true],
    [CLI_ONLY, DASHBOARD_ONLY, true],
    [DASHBOARD_ONLY, CLI_ONLY, false],
    [CLI_ONLY, policy({ allowedClients: ["cli", "oauth_apps"] }), false],
    [CLI_ONLY, DEFAULT_POLICY, false],
    [CLI_ONLY, policy({ allowedClients: ["oauth_apps"] }), true],
  ] as const)("%# needs the plan: %s", (current, next, needs) => {
    expect(policyChangeNeedsPlan(current, next)).toBe(needs);
  });

  it("reports what a restore would lift", () => {
    expect(liftedFields(EIGHT_HOURS, DEFAULT_POLICY)).toEqual(["sessionMaxHours"]);
    expect(liftedFields(EIGHT_HOURS, policy({ sessionMaxHours: 9 }))).toEqual(["sessionMaxHours"]);
    expect(liftedFields(EIGHT_HOURS, policy({ sessionMaxHours: 2 }))).toEqual([]);
    expect(liftedFields(CLI_ONLY, DEFAULT_POLICY)).toEqual(["allowedClients"]);
    expect(liftedFields(CLI_ONLY, DASHBOARD_ONLY)).toEqual([]);
    expect(liftedFields(DEFAULT_POLICY, CLI_ONLY)).toEqual([]);
  });

  it("stores a field only while it is set, so the previous release still reads the row", () => {
    expect(storedPolicy(policy({ publicAccess: "forbidden" }))).toEqual({
      publicAccess: "forbidden",
      defaultAccess: "restricted",
      readerDomains: null,
      shareLinks: "allowed",
      shareLinkMaxDays: null,
    });
    expect(storedPolicy(policy({ sessionMaxHours: 8, allowedClients: [] }))).toMatchObject({
      sessionMaxHours: 8,
      allowedClients: [],
    });
    expect(storedPolicy(DEFAULT_POLICY)).toBeNull();
    expect(policyOf(storedPolicy(EIGHT_HOURS))).toEqual(EIGHT_HOURS);
    expect(
      changedFields(DEFAULT_POLICY, policy({ sessionMaxHours: 8, allowedClients: [] })),
    ).toEqual(["sessionMaxHours", "allowedClients"]);
  });

  it("records the new values in the audit detail, enums and counts only", () => {
    expect(
      policyChangeDetail(
        DEFAULT_POLICY,
        policy({ sessionMaxHours: 8, allowedClients: ["cli"] }),
        false,
      ),
    ).toEqual({
      fields: ["sessionMaxHours", "allowedClients"],
      sessionMaxHours: 8,
      allowedClients: ["cli"],
      confirmed: false,
    });
    expect(policyChangeDetail(EIGHT_HOURS, DEFAULT_POLICY, false)).toEqual({
      fields: ["sessionMaxHours"],
      sessionMaxHours: null,
      confirmed: false,
    });
  });

  it("describes them in short phrases, and the escape hatch lifts them", () => {
    expect(describePolicy(policy({ sessionMaxHours: 12, allowedClients: ["cli"] }))).toEqual([
      "people sign in again every 12 hours",
      "people act only through the dashboard and the Portifact CLI",
    ]);
    expect(describePolicy(DASHBOARD_ONLY)).toEqual(["people act only through the dashboard"]);
    expect(
      isDefaultPolicy(withoutRequestPolicies(policy({ sessionMaxHours: 8, allowedClients: [] }))),
    ).toBe(true);
  });
});

describe("lock-out safety for the sign-in policies", () => {
  it("refuses a maximum age the saving admin's own sign-in already exceeds", () => {
    expect(checkPolicyKeepsCaller(EIGHT_HOURS, as(session(2)), WHO).ok).toBe(true);
    expect(checkPolicyKeepsCaller(EIGHT_HOURS, as(session(9)), WHO)).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.sessionLocksOut(8),
    });
    expect(checkPolicyKeepsCaller(EIGHT_HOURS, as(undefined), WHO)).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.sessionLocksOutUnknown,
    });
  });

  it("never refuses the dashboard over the allowed clients, and fails closed without a credential", () => {
    expect(checkPolicyKeepsCaller(DASHBOARD_ONLY, as(session(500)), WHO).ok).toBe(true);
    expect(checkPolicyKeepsCaller(DASHBOARD_ONLY, as(undefined), WHO)).toMatchObject({
      ok: false,
      message: POLICY_MESSAGES.clientUnknown,
    });
    expect(checkPolicyKeepsCaller(EIGHT_HOURS, BACKGROUND, WHO).ok).toBe(true);
  });
});
