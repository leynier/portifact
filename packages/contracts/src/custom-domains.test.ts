import { describe, expect, it } from "vitest";
import {
  AddCustomDomainInput,
  CUSTOM_DOMAINS,
  CustomDomainAdd,
  CustomDomainListQuery,
  CustomDomainView,
  cnameTarget,
  HostnameInput,
  RemoveCustomDomainInput,
  txtRecordName,
  txtRecordValue,
} from "./custom-domains.ts";
import { OutboxTopic, TombstoneMarker } from "./jobs.ts";
import { ExportCustomDomain } from "./moderation.ts";

describe("custom domain records", () => {
  it("names the TXT record, its value and the CNAME target", () => {
    expect(txtRecordName("docs.example.com")).toBe("_portifact.docs.example.com");
    expect(txtRecordValue("abc")).toBe("portifact-verify=abc");
    expect(cnameTarget("portifact.dev")).toBe("domains.portifact.dev");
    expect(CUSTOM_DOMAINS).toMatchObject({
      claimTtlDays: 7,
      provisioningMaxDays: 7,
      recheckHours: 24,
      maxMissedChecks: 3,
      downgradeGraceDays: 7,
    });
  });
});

describe("custom domain inputs", () => {
  it("trims a hostname and bounds its length", () => {
    expect(HostnameInput.parse("  docs.example.com ")).toBe("docs.example.com");
    expect(HostnameInput.safeParse("").success).toBe(false);
    expect(HostnameInput.safeParse("a".repeat(CUSTOM_DOMAINS.inputMaxLength + 1)).success).toBe(
      false,
    );
    expect(CustomDomainAdd.safeParse({ hostname: "docs.example.com", extra: 1 }).success).toBe(
      false,
    );
    expect(CustomDomainListQuery.safeParse({ artifactId: "nope" }).success).toBe(false);
    expect(CustomDomainListQuery.parse({})).toEqual({});
  });

  it("takes the MCP tools' inputs", () => {
    expect(
      AddCustomDomainInput.safeParse({ artifactId: "abcdefghij", hostname: "docs.example.com" })
        .success,
    ).toBe(true);
    expect(
      AddCustomDomainInput.safeParse({
        artifactId: "abcdefghij",
        hostname: "docs.example.com",
        idempotencyKey: "",
      }).success,
    ).toBe(false);
    expect(RemoveCustomDomainInput.safeParse({ hostname: "docs.example.com" }).success).toBe(false);
  });

  it("validates a view", () => {
    const view = {
      hostname: "docs.example.com",
      artifactId: "abcdefghij",
      state: "pending",
      records: [{ type: "TXT", name: "_portifact.docs.example.com", value: "x" }],
      claimExpiresAt: "2026-11-17T12:00:00.000Z",
      verifiedAt: null,
      checkedAt: null,
      missedChecks: 0,
      problem: "txt_missing",
    };
    expect(CustomDomainView.parse(view)).toEqual(view);
    expect(CustomDomainView.safeParse({ ...view, state: "detaching" }).success).toBe(false);
    expect(CustomDomainView.safeParse({ ...view, missedChecks: -1 }).success).toBe(false);
  });

  it("carries the job topic and the export shape", () => {
    expect(OutboxTopic.parse("delete_custom_hostname")).toBe("delete_custom_hostname");
    expect(
      ExportCustomDomain.safeParse({ hostname: "a.example.com", state: "active", verifiedAt: null })
        .success,
    ).toBe(true);
    expect(
      ExportCustomDomain.safeParse({
        hostname: "a.example.com",
        state: "active",
        verifiedAt: null,
        token: "x",
      }).success,
    ).toBe(false);
    // Hostnames need no tombstone: a released name is meant to be claimable again.
    expect(
      TombstoneMarker.safeParse({ kind: "custom_domain", id: "x", deletedAt: 0 }).success,
    ).toBe(false);
  });
});
