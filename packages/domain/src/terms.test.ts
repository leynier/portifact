import { TERMS_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SESSION_OPERATIONS,
  accessChangeOnlyNarrows,
  accountSessionUsableWithoutCurrentTerms,
  accountSettingsUpdateOnlyNarrows,
  commentNoticeMuteOnlyNarrows,
  needsTermsAcceptance,
  TERMS_AGENT_SENTENCE,
  TERMS_EXEMPT_SCOPES,
  TERMS_OPEN_OPERATIONS,
  termsRefusalMessage,
  usableWithoutCurrentTerms,
  webhookUpdateOnlyNarrows,
} from "./terms.ts";

describe("needsTermsAcceptance", () => {
  it("lets through an account that accepted the current version", () => {
    expect(needsTermsAcceptance(TERMS_VERSION)).toBe(false);
  });

  it("asks an account that never accepted", () => {
    expect(needsTermsAcceptance(null)).toBe(true);
    expect(needsTermsAcceptance(undefined)).toBe(true);
  });

  it("asks again when the terms change", () => {
    expect(needsTermsAcceptance("2026-11-08", "2027-01-01")).toBe(true);
  });
});

describe("usableWithoutCurrentTerms", () => {
  it("keeps every operation of the read scopes, named or not", () => {
    for (const scope of TERMS_EXEMPT_SCOPES) {
      expect(usableWithoutCurrentTerms({ scope, operation: null }), scope).toBe(true);
    }
  });

  it("keeps the operations that only remove or narrow, whatever their scope", () => {
    for (const operation of Object.keys(TERMS_OPEN_OPERATIONS)) {
      expect(usableWithoutCurrentTerms({ scope: "artifacts:write", operation }), operation).toBe(
        true,
      );
    }
    expect(
      usableWithoutCurrentTerms({ scope: "credentials:manage", operation: "delete_webhook" }),
    ).toBe(true);
  });

  it("refuses anything else, and an operation the adapter could not name", () => {
    for (const scope of [
      "artifacts:write",
      "artifacts:share",
      "artifacts:delete",
      "annotations:write",
      "annotations:moderate",
      "credentials:manage",
    ] as const) {
      expect(usableWithoutCurrentTerms({ scope, operation: null }), scope).toBe(false);
      for (const operation of ["publish_document", "add_reader", "create_share_link", "toString"]) {
        expect(usableWithoutCurrentTerms({ scope, operation }), operation).toBe(false);
      }
    }
  });
});

describe("accessChangeOnlyNarrows", () => {
  it("allows a mode whose readers are a subset of the current one's", () => {
    expect(accessChangeOnlyNarrows("public", { mode: "restricted" })).toBe(true);
    expect(accessChangeOnlyNarrows("public", { mode: "authenticated" })).toBe(true);
    expect(accessChangeOnlyNarrows("authenticated", { mode: "domain" })).toBe(true);
    expect(accessChangeOnlyNarrows("domain", { mode: "workspace" })).toBe(true);
    expect(accessChangeOnlyNarrows("restricted", { mode: "restricted" })).toBe(true);
  });

  it("refuses a wider mode, or one that is not a subset", () => {
    expect(accessChangeOnlyNarrows("restricted", { mode: "public" })).toBe(false);
    expect(accessChangeOnlyNarrows("authenticated", { mode: "public" })).toBe(false);
    expect(accessChangeOnlyNarrows("workspace", { mode: "domain" })).toBe(false);
    // A restricted artifact's readers are not a subset of a workspace's members, nor the reverse.
    expect(accessChangeOnlyNarrows("workspace", { mode: "restricted" })).toBe(false);
    expect(accessChangeOnlyNarrows("restricted", { mode: "workspace" })).toBe(false);
  });

  it("allows removing readers and groups and turning things off", () => {
    expect(
      accessChangeOnlyNarrows("restricted", {
        removeReaders: ["a@example.test"],
        removeGroups: ["grp_1"],
        indexable: false,
        embeddable: false,
        commentVisibility: "owner",
      }),
    ).toBe(true);
  });

  it("refuses anything that adds, turns on or opens comments", () => {
    const refused = [
      { addReaders: ["a@example.test"] },
      { addGroups: ["grp_1"] },
      { indexable: true },
      { embeddable: true },
      { bar: false },
      { bar: true },
      { commentVisibility: "everyone" as const },
      { readerCommentVisibility: [{ email: "a@example.test", commentVisibility: "own" }] },
      { groupCommentVisibility: [{ group: "grp_1", commentVisibility: "own" }] },
      { mode: "restricted" as const, addReaders: ["a@example.test"] },
    ];
    for (const change of refused) {
      expect(accessChangeOnlyNarrows("public", change), JSON.stringify(change)).toBe(false);
    }
  });
});

describe("webhookUpdateOnlyNarrows", () => {
  it("allows only turning a webhook off", () => {
    expect(webhookUpdateOnlyNarrows({ enabled: false })).toBe(true);
    expect(webhookUpdateOnlyNarrows({ enabled: true })).toBe(false);
    expect(webhookUpdateOnlyNarrows({ enabled: false, events: ["comment.created"] })).toBe(false);
    expect(webhookUpdateOnlyNarrows({ events: [] })).toBe(false);
  });
});

describe("termsRefusalMessage", () => {
  it("names the version and where to accept, what keeps working and what to do with an old CLI", () => {
    const message = termsRefusalMessage("https://app.example.test", "2027-01-01");
    expect(message).toContain("version 2027-01-01");
    expect(message).toContain("open https://app.example.test in a browser");
    expect(message).toContain("Agree and continue");
    expect(message).toContain("no app or agent can accept them");
    expect(message).toContain("removing or narrowing");
    expect(message).toContain("update the CLI or open the dashboard");
    expect(termsRefusalMessage(null)).toContain("open the Portifact dashboard in a browser");
    expect(termsRefusalMessage(null)).toContain(TERMS_VERSION);
    expect(TERMS_AGENT_SENTENCE).toMatch(/^Ask the user to do it, and do not retry/);
  });
});

describe("account session operations without the current terms", () => {
  it("leave open reads, removals, narrowing changes and the ways to leave", () => {
    for (const operation of [
      "read_account_settings",
      "export_account",
      "request_account_deletion_code",
      "delete_account_with_code",
      "delete_account",
      "sign_out_other_sessions",
      "disconnect_app",
      "delete_branding",
      "remove_branding_logo",
      "update_account_settings",
      "set_comment_notice_mute",
    ]) {
      expect(accountSessionUsableWithoutCurrentTerms(operation), operation).toBe(true);
    }
  });

  it("refuse what acts anew, and anything unnamed or unknown (fail closed)", () => {
    expect(accountSessionUsableWithoutCurrentTerms("update_branding")).toBe(false);
    expect(accountSessionUsableWithoutCurrentTerms("set_branding_logo")).toBe(false);
    expect(accountSessionUsableWithoutCurrentTerms(null)).toBe(false);
    expect(accountSessionUsableWithoutCurrentTerms("toString")).toBe(false);
    expect(accountSessionUsableWithoutCurrentTerms("something_new")).toBe(false);
  });

  it("classify every operation with one of the known kinds", () => {
    for (const kind of Object.values(ACCOUNT_SESSION_OPERATIONS)) {
      expect(["read", "removes", "narrowing", "leaving", "refused"]).toContain(kind);
    }
  });

  it("count a settings change as narrowing only when it turns notices off and nothing else", () => {
    expect(accountSettingsUpdateOnlyNarrows({ expiryNotices: false })).toBe(true);
    expect(accountSettingsUpdateOnlyNarrows({ commentNotices: false })).toBe(true);
    expect(accountSettingsUpdateOnlyNarrows({ expiryNotices: false, commentNotices: false })).toBe(
      true,
    );
    expect(accountSettingsUpdateOnlyNarrows({})).toBe(false);
    expect(accountSettingsUpdateOnlyNarrows({ expiryNotices: true })).toBe(false);
    expect(accountSettingsUpdateOnlyNarrows({ commentNotices: false, locale: "es" })).toBe(false);
    expect(accountSettingsUpdateOnlyNarrows({ defaultBar: false })).toBe(false);
    expect(
      accountSettingsUpdateOnlyNarrows({ commentNotices: false, defaultAccessMode: "restricted" }),
    ).toBe(false);
    expect(accountSettingsUpdateOnlyNarrows({ commentNotices: false, locale: undefined })).toBe(
      true,
    );
  });

  it("count muting as narrowing, never unmuting", () => {
    expect(commentNoticeMuteOnlyNarrows({ muted: true })).toBe(true);
    expect(commentNoticeMuteOnlyNarrows({ muted: false })).toBe(false);
  });
});
