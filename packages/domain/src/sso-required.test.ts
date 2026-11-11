// "SSO required" (decision 0021): people act on a workspace only through a sign-in with the
// workspace's own single sign-on provider. How it is validated, stored, compared, described,
// checked on every kind of credential and method, and guarded against lock-outs.
import {
  BACKGROUND,
  CLI_CLIENT_ID,
  type Credential,
  DEFAULT_POLICY,
  type RequestContext,
  type SignInMethod,
  WorkspacePolicy,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  changedFields,
  checkPolicyKeepsCaller,
  checkRequestPolicy,
  checkSsoOutside,
  checkSsoRequirement,
  describePolicy,
  liftedFields,
  POLICY_MESSAGES,
  policyChangeDetail,
  policyChangeNeedsPlan,
  policyOf,
  requestRefusal,
  signInVerdict,
  ssoRequirementBinds,
  storedPolicy,
  withoutRequestPolicies,
} from "./workspace-policies.ts";

const NOW = 1_800_000_000_000;
const OURS = `sso_${"a".repeat(32)}`;
const THEIRS = `sso_${"b".repeat(32)}`;
const REQUIRED: WorkspacePolicy = { ...DEFAULT_POLICY, ssoRequired: true };
const WHO = { userId: "u1", now: NOW, ssoProvider: OURS };

const methods: Record<string, SignInMethod | null> = {
  "an email code": { kind: "code" },
  "Google with the same address": { kind: "social", provider: "google" },
  GitHub: { kind: "social", provider: "github" },
  "this workspace's provider": { kind: "sso", providerId: OURS },
  "another workspace's provider": { kind: "sso", providerId: THEIRS },
  "a method not known (a session from before)": null,
};

const session = (method: SignInMethod | null, userId = "u1"): Credential => ({
  kind: "session",
  userId,
  signedInAt: NOW - 1000,
  method,
});
const token = (method: SignInMethod | null, cli: boolean): Credential => ({
  kind: "oauth",
  userId: "u1",
  clientId: cli ? CLI_CLIENT_ID : "dcr_1",
  client: cli ? "cli" : "oauth_apps",
  signedInAt: NOW - 1000,
  method,
});
const as = (credential?: Credential | null, sso = true): RequestContext => ({
  kind: "request",
  ip: "192.0.2.1",
  ...(sso ? { sso: true } : {}),
  ...(credential === undefined ? {} : { credential }),
});

describe("the SSO required verdict, for every credential and method", () => {
  const rows = Object.entries(methods).flatMap(([name, method]) => {
    const expected = name === "this workspace's provider" ? "allowed" : "sso";
    return [
      [`the dashboard signed in with ${name}`, session(method), expected],
      [`the CLI from a sign-in with ${name}`, token(method, true), expected],
      [`an MCP app from a sign-in with ${name}`, token(method, false), expected],
    ] as const;
  });
  it.each(rows)("%s", (_name, credential, expected) => {
    expect(signInVerdict(REQUIRED, as(credential), "person", WHO)).toBe(expected);
  });

  it.each([
    ["no credential recorded", undefined],
    ["two credentials in one request", null],
    ["someone else's SSO session", session({ kind: "sso", providerId: OURS }, "u2")],
    ["a service token's credential for a person", { kind: "service_token", userId: "u1" }],
  ] as const)("fails closed with %s", (_name, credential) => {
    expect(
      signInVerdict(REQUIRED, as(credential as Credential | null | undefined), "person", WHO),
    ).toBe("sso");
  });

  it("never binds service tokens, background work or a workspace without it", () => {
    expect(signInVerdict(REQUIRED, as(session({ kind: "code" })), "token", WHO)).toBe("allowed");
    expect(signInVerdict(REQUIRED, BACKGROUND, "person", WHO)).toBe("allowed");
    expect(signInVerdict(DEFAULT_POLICY, as(session({ kind: "code" })), "person", WHO)).toBe(
      "allowed",
    );
    expect(signInVerdict(undefined, as(session(null)), "person", WHO)).toBe("allowed");
  });

  it("is suspended while the provider cannot sign anyone in, or the Worker offers no SSO", () => {
    const code = as(session({ kind: "code" }));
    expect(signInVerdict(REQUIRED, code, "person", { ...WHO, ssoProvider: null })).toBe("allowed");
    expect(signInVerdict(REQUIRED, code, "person", { userId: "u1", now: NOW })).toBe("allowed");
    expect(signInVerdict(REQUIRED, as(session({ kind: "code" }), false), "person", WHO)).toBe(
      "allowed",
    );
    expect(ssoRequirementBinds(REQUIRED, code, OURS)).toBe(true);
    expect(ssoRequirementBinds(REQUIRED, BACKGROUND, OURS)).toBe(false);
    expect(ssoRequirementBinds(DEFAULT_POLICY, code, OURS)).toBe(false);
  });

  it("checks the client before SSO and SSO before the age", () => {
    const both = { ...REQUIRED, allowedClients: [] as [], sessionMaxHours: 1 };
    expect(signInVerdict(both, as(token({ kind: "code" }, true)), "person", WHO)).toBe("client");
    const old = { ...session({ kind: "code" }), signedInAt: NOW - 10 * 3_600_000 };
    expect(signInVerdict(both, as(old), "person", WHO)).toBe("sso");
    const oldSso = { ...old, method: { kind: "sso", providerId: OURS } } as const;
    expect(signInVerdict(both, as(oldSso), "person", WHO)).toBe("session_age");
  });
});

describe("refusing a request for SSO", () => {
  it("names the fix of the client that asked, with the sso reason", () => {
    const refused = (credential: Credential) =>
      checkRequestPolicy(REQUIRED, as(credential), "person", WHO);
    const dashboard = refused(session({ kind: "code" }));
    expect(dashboard).toMatchObject({ ok: false, code: "policy_refused", reason: "sso" });
    expect(!dashboard.ok && dashboard.message).toContain("Sign in with single sign-on");
    const cli = refused(token({ kind: "code" }, true));
    expect(!cli.ok && cli.message).toContain("then run `portifact login` and approve it");
    const app = refused(token(null, false));
    expect(!app.ok && app.message).toContain("Ask the user to sign in to Portifact");
    expect(!app.ok && app.message).toContain("this app's connection");
    expect(requestRefusal(REQUIRED, as(session(null)), "person", WHO)).toBe("sso");
    expect(
      requestRefusal(REQUIRED, as(session({ kind: "sso", providerId: OURS })), "person", WHO),
    ).toBeNull();
  });
});

describe("the SSO required setting", () => {
  it("reads a policy stored before it as unset, and stores it only while set", () => {
    const old = { ...DEFAULT_POLICY, publicAccess: "forbidden" } as Record<string, unknown>;
    delete old.ssoRequired;
    expect(policyOf(old).ssoRequired).toBe(false);
    expect(storedPolicy({ ...DEFAULT_POLICY, publicAccess: "forbidden" })).not.toHaveProperty(
      "ssoRequired",
    );
    expect(storedPolicy(REQUIRED)).toMatchObject({ ssoRequired: true });
    expect(WorkspacePolicy.safeParse({ ...DEFAULT_POLICY, ssoRequired: "yes" }).success).toBe(
      false,
    );
  });

  it("is a field that changes, tightens with the plan, loosens without it and can be lifted", () => {
    expect(changedFields(DEFAULT_POLICY, REQUIRED)).toEqual(["ssoRequired"]);
    expect(policyChangeNeedsPlan(DEFAULT_POLICY, REQUIRED)).toBe(true);
    expect(policyChangeNeedsPlan(REQUIRED, DEFAULT_POLICY)).toBe(false);
    expect(liftedFields(REQUIRED, DEFAULT_POLICY)).toEqual(["ssoRequired"]);
    expect(liftedFields(DEFAULT_POLICY, REQUIRED)).toEqual([]);
    expect(withoutRequestPolicies(REQUIRED).ssoRequired).toBe(false);
    expect(policyChangeDetail(DEFAULT_POLICY, REQUIRED, true)).toEqual({
      fields: ["ssoRequired"],
      ssoRequired: true,
      confirmed: true,
    });
    expect(describePolicy(REQUIRED)).toEqual([
      "people sign in through the workspace's single sign-on",
    ]);
  });
});

describe("never a setting nobody can satisfy", () => {
  it("needs single sign-on offered and a provider that can sign people in", () => {
    expect(checkSsoRequirement(REQUIRED, as(undefined, false), OURS)).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.ssoOff,
    });
    expect(checkSsoRequirement(REQUIRED, as(), null)).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.ssoNotUsable,
    });
    expect(checkSsoRequirement(REQUIRED, as(), OURS)).toEqual({ ok: true, value: true });
    expect(checkSsoRequirement(DEFAULT_POLICY, as(undefined, false), null).ok).toBe(true);
    expect(checkSsoRequirement(REQUIRED, BACKGROUND, null).ok).toBe(true);
  });

  it.each(Object.entries(methods))(
    "lets an admin who signed in with %s require it only through this provider",
    (name, method) => {
      const result = checkPolicyKeepsCaller(REQUIRED, as(session(method)), WHO);
      expect(result.ok).toBe(name === "this workspace's provider");
      if (!result.ok) expect(result.message).toBe(POLICY_MESSAGES.ssoLocksOut);
    },
  );

  it("needs the members the provider cannot serve confirmed, and refuses a count that grew", () => {
    expect(checkSsoOutside(true, 0, undefined).ok).toBe(true);
    expect(checkSsoOutside(false, 3, undefined).ok).toBe(true);
    expect(checkSsoOutside(true, 2, undefined)).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.ssoOutside(2),
    });
    expect(POLICY_MESSAGES.ssoOutside(1)).toContain("1 member's address is");
    expect(checkSsoOutside(true, 2, 2).ok).toBe(true);
    expect(checkSsoOutside(true, 1, 2).ok).toBe(true);
    expect(checkSsoOutside(true, 3, 2)).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.ssoOutsideGrew,
    });
  });
});
