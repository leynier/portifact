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

describe("custom domain shapes, exactly", () => {
  it("lists the states, record types and problems", async () => {
    const { CustomDomainState, DnsRecord, CustomDomainProblem } = await import(
      "./custom-domains.ts"
    );
    expect(CustomDomainState.options).toEqual(["pending", "provisioning", "active", "removing"]);
    expect(DnsRecord.shape.type.options).toEqual(["TXT", "CNAME"]);
    expect(CustomDomainProblem.options).toEqual([
      "txt_missing",
      "certificate_pending",
      "cloudflare_unavailable",
    ]);
  });

  it("explains a refused hostname", () => {
    expect(HostnameInput.safeParse("").error?.issues[0]?.message).toBe(
      "Type a hostname, for example docs.example.com.",
    );
    expect(HostnameInput.safeParse("a".repeat(301)).error?.issues[0]?.message).toBe(
      "A hostname has at most 253 characters.",
    );
  });

  it("requires every field of the list, the add body, the removal and the query", async () => {
    const { CustomDomainList, CustomDomainRemoved } = await import("./custom-domains.ts");
    const list = {
      available: true,
      enabled: true,
      limit: 5,
      used: 2,
      cnameTarget: "domains.portifact.dev",
      domains: [],
    };
    expect(CustomDomainList.parse(list)).toEqual(list);
    for (const key of Object.keys(list)) {
      const { [key]: _dropped, ...rest } = list as Record<string, unknown>;
      expect(CustomDomainList.safeParse(rest).success, key).toBe(false);
    }
    expect(CustomDomainList.safeParse({ ...list, limit: -1 }).success).toBe(false);
    expect(CustomDomainList.safeParse({ ...list, used: -1 }).success).toBe(false);
    expect(CustomDomainAdd.safeParse({}).success).toBe(false);
    expect(CustomDomainAdd.parse({ hostname: " a.example.com " })).toEqual({
      hostname: "a.example.com",
    });
    expect(
      CustomDomainRemoved.safeParse({ hostname: "a.example.com", removed: false }).success,
    ).toBe(false);
    expect(CustomDomainRemoved.safeParse({ removed: true }).success).toBe(false);
    expect(CustomDomainListQuery.parse({ artifactId: "abcdefghij" })).toEqual({
      artifactId: "abcdefghij",
    });
  });

  it("describes the MCP inputs for agents", () => {
    const describe = (schema: { description?: string | undefined }) => schema.description ?? "";
    expect(describe(AddCustomDomainInput.shape.artifactId)).toContain("list_artifacts");
    expect(describe(AddCustomDomainInput.shape.hostname)).toContain("never an apex domain");
    expect(describe(AddCustomDomainInput.shape.idempotencyKey)).toContain("Idempotency-Key");
    expect(describe(RemoveCustomDomainInput.shape.confirm)).toContain("after the user confirmed");
  });
});
