import {
  type AccessMode,
  DEFAULT_POLICY,
  type PolicyImpact,
  type WorkspacePolicy,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  changedFields,
  checkPolicyAccess,
  checkPolicyDefaults,
  checkPolicyImpact,
  checkPolicyReaders,
  checkPolicyShareLink,
  checkPolicyTransfer,
  describePolicy,
  impactTotal,
  isDefaultPolicy,
  lifetimeCutoff,
  normalizePolicy,
  POLICY_MESSAGES,
  policyChangeDetail,
  policyChangeNeedsPlan,
  policyDefaultAccess,
  policyLinkOpens,
  policyOf,
  policyTouchesArtifacts,
  readerAllowed,
} from "./workspace-policies.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10);
const policy = (overrides: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...overrides,
});
const refused = (message: string) => ({ ok: false, code: "policy_refused", message });
const NONE: PolicyImpact = {
  publicArtifacts: 0,
  readersOutside: 0,
  linksRevoked: 0,
  linksWithoutPassword: 0,
  linksOverLifetime: 0,
};

describe("policyOf", () => {
  it("reads null as the defaults and parses stored JSON or objects", () => {
    expect(policyOf(null)).toEqual(DEFAULT_POLICY);
    expect(policyOf(undefined)).toEqual(DEFAULT_POLICY);
    const forbidden = policy({ publicAccess: "forbidden" });
    expect(policyOf(JSON.stringify(forbidden))).toEqual(forbidden);
    expect(policyOf(forbidden)).toEqual(forbidden);
  });

  it("throws on a stored value that does not parse, never falling back to the defaults", () => {
    expect(() => policyOf({ publicAccess: "maybe" })).toThrow();
    expect(() => policyOf("{")).toThrow();
  });
});

describe("normalizePolicy", () => {
  it.each([
    [
      ["Example.COM", "example.com", " b.example "],
      ["b.example", "example.com"],
    ],
    [["xn--bcher-kva.example"], ["xn--bcher-kva.example"]],
  ])("normalizes %j to %j", (input, expected) => {
    const result = normalizePolicy(policy({ readerDomains: input }));
    expect(result).toEqual({ ok: true, value: policy({ readerDomains: expected }) });
  });

  it.each([
    "bücher.example",
    "example",
    "1.2.3.4",
    "a@example.com",
    "https://example.com",
    "example.com.",
    "-bad.example",
  ])("refuses %s", (domain) => {
    const result = normalizePolicy(policy({ readerDomains: [domain] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_input");
      expect(result.message).toContain(domain);
    }
  });

  it("keeps a policy without an allowlist", () => {
    expect(normalizePolicy(DEFAULT_POLICY)).toEqual({ ok: true, value: DEFAULT_POLICY });
  });
});

describe("changes and the plan", () => {
  const rows: [string, Partial<WorkspacePolicy>, Partial<WorkspacePolicy>, boolean][] = [
    ["nothing", {}, {}, false],
    ["forbid public", {}, { publicAccess: "forbidden" }, true],
    ["allow public again", { publicAccess: "forbidden" }, {}, false],
    ["workspace default", {}, { defaultAccess: "workspace" }, true],
    [
      "domain from workspace default",
      { defaultAccess: "workspace" },
      { defaultAccess: "domain" },
      true,
    ],
    ["back to restricted default", { defaultAccess: "domain" }, {}, false],
    ["set an allowlist", {}, { readerDomains: ["a.example"] }, true],
    ["drop the allowlist", { readerDomains: ["a.example"] }, {}, false],
    [
      "widen the allowlist",
      { readerDomains: ["a.example"] },
      { readerDomains: ["a.example", "b.example"] },
      false,
    ],
    [
      "narrow the allowlist",
      { readerDomains: ["a.example", "b.example"] },
      { readerDomains: ["a.example"] },
      true,
    ],
    [
      "swap the allowlist",
      { readerDomains: ["a.example"] },
      { readerDomains: ["b.example"] },
      true,
    ],
    ["require passwords", {}, { shareLinks: "password_required" }, true],
    ["disable links", { shareLinks: "password_required" }, { shareLinks: "disabled" }, true],
    [
      "passwords from disabled",
      { shareLinks: "disabled" },
      { shareLinks: "password_required" },
      false,
    ],
    ["allow links", { shareLinks: "disabled" }, {}, false],
    ["set a lifetime", {}, { shareLinkMaxDays: 30 }, true],
    ["shorten the lifetime", { shareLinkMaxDays: 30 }, { shareLinkMaxDays: 7 }, true],
    ["lengthen the lifetime", { shareLinkMaxDays: 7 }, { shareLinkMaxDays: 30 }, false],
    ["drop the lifetime", { shareLinkMaxDays: 7 }, {}, false],
    [
      "loosen one and tighten another",
      { publicAccess: "forbidden" },
      { shareLinks: "disabled" },
      true,
    ],
  ];
  it.each(rows)("%s needs the plan: %s", (_name, current, next, needs) => {
    expect(policyChangeNeedsPlan(policy(current), policy(next))).toBe(needs);
  });

  it("lists the fields that changed in order, and the audit detail names only them", () => {
    const current = policy({ readerDomains: ["a.example"] });
    const next = policy({ publicAccess: "forbidden", readerDomains: null, shareLinkMaxDays: 3 });
    expect(changedFields(current, next)).toEqual([
      "publicAccess",
      "readerDomains",
      "shareLinkMaxDays",
    ]);
    expect(policyChangeDetail(current, next, true)).toEqual({
      fields: ["publicAccess", "readerDomains", "shareLinkMaxDays"],
      publicAccess: "forbidden",
      readerDomains: null,
      shareLinkMaxDays: 3,
      confirmed: true,
    });
    expect(
      policyChangeDetail(
        DEFAULT_POLICY,
        policy({ defaultAccess: "workspace", shareLinks: "disabled" }),
        false,
      ),
    ).toEqual({
      fields: ["defaultAccess", "shareLinks"],
      defaultAccess: "workspace",
      shareLinks: "disabled",
      confirmed: false,
    });
    expect(
      changedFields(policy({ readerDomains: ["a"] }), policy({ readerDomains: ["a", "b"] })),
    ).toEqual(["readerDomains"]);
  });

  it("knows the defaults and which policies reach existing artifacts", () => {
    expect(isDefaultPolicy(DEFAULT_POLICY)).toBe(true);
    expect(isDefaultPolicy(policy({ defaultAccess: "workspace" }))).toBe(false);
    expect(policyTouchesArtifacts(DEFAULT_POLICY)).toBe(false);
    expect(policyTouchesArtifacts(policy({ defaultAccess: "workspace" }))).toBe(false);
    for (const touching of [
      { publicAccess: "forbidden" },
      { readerDomains: ["a.example"] },
      { shareLinks: "password_required" },
      { shareLinks: "disabled" },
      { shareLinkMaxDays: 1 },
    ] as Partial<WorkspacePolicy>[]) {
      expect(policyTouchesArtifacts(policy(touching))).toBe(true);
    }
  });
});

describe("checkPolicyDefaults", () => {
  it("needs a verified domain for the domain default only", () => {
    expect(checkPolicyDefaults(policy({ defaultAccess: "domain" }), false)).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.defaultDomain,
    });
    expect(checkPolicyDefaults(policy({ defaultAccess: "domain" }), true).ok).toBe(true);
    expect(checkPolicyDefaults(policy({ defaultAccess: "workspace" }), false).ok).toBe(true);
  });
});

describe("checkPolicyImpact", () => {
  it("passes when nothing changes or the admin confirmed", () => {
    expect(checkPolicyImpact(NONE, undefined).ok).toBe(true);
    const three = { ...NONE, publicArtifacts: 3 };
    expect(checkPolicyImpact(three, three).ok).toBe(true);
    // Fewer than confirmed is still what the admin accepted; more is not.
    expect(checkPolicyImpact({ ...NONE, publicArtifacts: 2 }, three).ok).toBe(true);
    for (const key of Object.keys(NONE) as (keyof PolicyImpact)[]) {
      expect(checkPolicyImpact({ ...three, [key]: three[key] + 1 }, three)).toEqual(
        refused(POLICY_MESSAGES.impactChanged),
      );
    }
    expect(impactTotal({ ...NONE, readersOutside: 2, linksRevoked: 1 })).toBe(3);
  });

  it("refuses an unconfirmed change with every count in its message", () => {
    expect(
      checkPolicyImpact(
        {
          publicArtifacts: 1,
          readersOutside: 2,
          linksRevoked: 3,
          linksWithoutPassword: 1,
          linksOverLifetime: 4,
        },
        undefined,
      ),
    ).toEqual(
      refused(
        "This policy changes existing artifacts: 1 public artifact would become workspace-only; 2 readers outside the allowed domains would be removed; 3 share links would be revoked; 1 share link without a password would stop opening; 4 share links past the maximum lifetime would stop opening. Narrow them first, or confirm the change.",
      ),
    );
  });
});

describe("checkPolicyAccess", () => {
  const modes: AccessMode[] = ["restricted", "workspace", "domain", "authenticated", "public"];
  it.each(modes)("allows %s without a policy and with the defaults", (mode) => {
    expect(checkPolicyAccess(undefined, mode).ok).toBe(true);
    expect(checkPolicyAccess(DEFAULT_POLICY, mode).ok).toBe(true);
  });

  it.each(modes)("with public forbidden, refuses only public (%s)", (mode) => {
    const result = checkPolicyAccess(policy({ publicAccess: "forbidden" }), mode);
    expect(result).toEqual(
      mode === "public" ? refused(POLICY_MESSAGES.publicForbidden) : { ok: true, value: true },
    );
  });
});

describe("reader allowlist", () => {
  const limited = policy({ readerDomains: ["corp.example", "xn--bcher-kva.example"] });
  it.each([
    ["ada@corp.example", true],
    ["ada@CORP.example", true],
    ["ada@sub.corp.example", false],
    ["ada@other.example", false],
    ["ada@xn--bcher-kva.example", true],
    ["ada@bücher.example", false],
    ["no-at-sign", false],
  ])("%s allowed: %s", (email, allowed) => {
    expect(readerAllowed(limited, email)).toBe(allowed);
  });

  it("allows anyone without an allowlist", () => {
    expect(readerAllowed(undefined, "ada@anything.example")).toBe(true);
    expect(readerAllowed(DEFAULT_POLICY, "ada@anything.example")).toBe(true);
    expect(checkPolicyReaders(undefined, ["a@b.example"]).ok).toBe(true);
  });

  it("refuses the first address outside, naming the allowed domains", () => {
    expect(
      checkPolicyReaders(limited, ["ok@corp.example", "eve@evil.example", "x@y.example"]),
    ).toEqual(
      refused(POLICY_MESSAGES.readerOutside("eve@evil.example", limited.readerDomains ?? [])),
    );
    expect(checkPolicyReaders(limited, ["ok@corp.example"]).ok).toBe(true);
    expect(checkPolicyReaders(limited, []).ok).toBe(true);
  });
});

describe("share links", () => {
  const rows: [
    string,
    Partial<WorkspacePolicy>,
    { password: boolean; expiresAt: number | null },
    string | null,
  ][] = [
    ["no policy", {}, { password: false, expiresAt: null }, null],
    [
      "disabled",
      { shareLinks: "disabled" },
      { password: true, expiresAt: NOW + DAY },
      POLICY_MESSAGES.linksDisabled,
    ],
    [
      "password missing",
      { shareLinks: "password_required" },
      { password: false, expiresAt: null },
      POLICY_MESSAGES.passwordRequired,
    ],
    [
      "password given",
      { shareLinks: "password_required" },
      { password: true, expiresAt: null },
      null,
    ],
    [
      "no expiry with a lifetime",
      { shareLinkMaxDays: 7 },
      { password: false, expiresAt: null },
      POLICY_MESSAGES.lifetime(7),
    ],
    [
      "expiry past the lifetime",
      { shareLinkMaxDays: 7 },
      { password: false, expiresAt: NOW + 7 * DAY + 1 },
      POLICY_MESSAGES.lifetime(7),
    ],
    [
      "expiry at the lifetime",
      { shareLinkMaxDays: 7 },
      { password: false, expiresAt: NOW + 7 * DAY },
      null,
    ],
    [
      "one day",
      { shareLinkMaxDays: 1 },
      { password: false, expiresAt: null },
      POLICY_MESSAGES.lifetime(1),
    ],
  ];
  it.each(rows)("creating, %s", (_name, overrides, link, message) => {
    expect(checkPolicyShareLink(policy(overrides), link, NOW)).toEqual(
      message === null ? { ok: true, value: true } : refused(message),
    );
  });

  it("says day and days", () => {
    expect(POLICY_MESSAGES.lifetime(1)).toContain("1 day.");
    expect(POLICY_MESSAGES.lifetime(2)).toContain("2 days.");
  });

  it("allows any link without a policy", () => {
    expect(checkPolicyShareLink(undefined, { password: false, expiresAt: null }, NOW).ok).toBe(
      true,
    );
    expect(policyLinkOpens(undefined, { hasPassword: false, createdAt: 0 }, NOW)).toBe(true);
  });

  const opens: [
    string,
    Partial<WorkspacePolicy>,
    { hasPassword: boolean; createdAt: number },
    boolean,
  ][] = [
    ["defaults", {}, { hasPassword: false, createdAt: 0 }, true],
    ["disabled", { shareLinks: "disabled" }, { hasPassword: true, createdAt: NOW }, false],
    [
      "password required, none",
      { shareLinks: "password_required" },
      { hasPassword: false, createdAt: NOW },
      false,
    ],
    [
      "password required, set",
      { shareLinks: "password_required" },
      { hasPassword: true, createdAt: NOW },
      true,
    ],
    [
      "inside the lifetime",
      { shareLinkMaxDays: 7 },
      { hasPassword: false, createdAt: NOW - 7 * DAY + 1 },
      true,
    ],
    [
      "at the lifetime",
      { shareLinkMaxDays: 7 },
      { hasPassword: false, createdAt: NOW - 7 * DAY },
      false,
    ],
  ];
  it.each(opens)("opening, %s: %s", (_name, overrides, link, expected) => {
    expect(policyLinkOpens(policy(overrides), link, NOW)).toBe(expected);
  });

  it("cuts off at the lifetime", () => {
    expect(lifetimeCutoff(DEFAULT_POLICY, NOW)).toBeNull();
    expect(lifetimeCutoff(policy({ shareLinkMaxDays: 2 }), NOW)).toBe(NOW - 2 * DAY);
  });
});

describe("new artifacts and transfers", () => {
  it("starts new artifacts from the policy's default access", () => {
    expect(policyDefaultAccess(undefined)).toBe("restricted");
    expect(policyDefaultAccess(policy({ defaultAccess: "domain" }))).toBe("domain");
    const rows: [WorkspacePolicy["defaultAccess"], boolean, boolean, AccessMode][] = [
      ["domain", true, true, "domain"],
      ["domain", false, true, "workspace"],
      ["domain", true, false, "restricted"],
      ["domain", false, false, "restricted"],
      ["workspace", false, true, "workspace"],
      ["workspace", true, false, "restricted"],
      ["restricted", true, true, "restricted"],
    ];
    for (const [wanted, domainVerified, workspacesFeature, mode] of rows) {
      expect(
        policyDefaultAccess(policy({ defaultAccess: wanted }), {
          domainVerified,
          workspacesFeature,
        }),
      ).toBe(mode);
    }
  });

  const base = { accessMode: "restricted" as AccessMode, readers: [] as string[], activeLinks: 0 };
  const rows: [string, Partial<WorkspacePolicy>, Partial<typeof base>, string | null][] = [
    [
      "anything without restrictions",
      {},
      { accessMode: "public", readers: ["a@x.example"], activeLinks: 3 },
      null,
    ],
    [
      "public into forbidden",
      { publicAccess: "forbidden" },
      { accessMode: "public" },
      POLICY_MESSAGES.transferPublic,
    ],
    [
      "authenticated into forbidden",
      { publicAccess: "forbidden" },
      { accessMode: "authenticated" },
      null,
    ],
    [
      "reader outside",
      { readerDomains: ["corp.example"] },
      { readers: ["a@corp.example", "b@x.example"] },
      POLICY_MESSAGES.transferReaders(["corp.example"]),
    ],
    ["readers inside", { readerDomains: ["corp.example"] }, { readers: ["a@corp.example"] }, null],
    [
      "links into disabled",
      { shareLinks: "disabled" },
      { activeLinks: 1 },
      POLICY_MESSAGES.transferLinks,
    ],
    ["no links into disabled", { shareLinks: "disabled" }, { activeLinks: 0 }, null],
    ["links into password required", { shareLinks: "password_required" }, { activeLinks: 2 }, null],
  ];
  it.each(rows)("moving %s", (_name, overrides, artifact, message) => {
    expect(checkPolicyTransfer(policy(overrides), { ...base, ...artifact })).toEqual(
      message === null ? { ok: true, value: true } : refused(message),
    );
  });

  it("lets anything into a personal space", () => {
    expect(checkPolicyTransfer(undefined, { ...base, accessMode: "public" }).ok).toBe(true);
  });
});

describe("describePolicy", () => {
  it("says nothing for the defaults and names every restriction", () => {
    expect(describePolicy(DEFAULT_POLICY)).toEqual([]);
    expect(
      describePolicy({
        publicAccess: "forbidden",
        defaultAccess: "workspace",
        readerDomains: ["a.example", "b.example"],
        shareLinks: "password_required",
        shareLinkMaxDays: 30,
      }),
    ).toEqual([
      "public access forbidden",
      "new artifacts start as workspace",
      "readers only at a.example, b.example",
      "share links need a password",
      "share links last at most 30 days",
    ]);
    expect(describePolicy(policy({ shareLinks: "disabled", shareLinkMaxDays: 30 }))).toEqual([
      "share links disabled",
    ]);
  });
});
