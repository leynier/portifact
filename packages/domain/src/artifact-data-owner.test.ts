import {
  ARTIFACT_DATA_PLANS,
  ArtifactDataLimits,
  AUDIT_DETAILS,
  DATA_REFUSAL_CODES,
  dataCountOf,
  dataQueryOf,
  exportCursorText,
  PLAN_NAMES,
  parseExportCursor,
  queryValue,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  artifactDataPlan,
  DATA_AUDIT_EVENTS,
  dataAuditEvent,
  dataRefusalError,
  exportConsistent,
} from "./artifact-data-owner.ts";
import { HELD_MESSAGE } from "./moderation.ts";

describe("artifact data plans", () => {
  it.each(PLAN_NAMES)("%s carries limits the object accepts", (plan) => {
    const { limits, dataArtifacts } = artifactDataPlan(plan);
    expect(ArtifactDataLimits.safeParse(limits).success).toBe(true);
    expect(dataArtifacts).toBeGreaterThan(0);
  });

  it("gives Free one data artifact and more to every paid plan (option B)", () => {
    expect(ARTIFACT_DATA_PLANS.free.dataArtifacts).toBe(1);
    expect(ARTIFACT_DATA_PLANS.free.limits.bytesPerArtifact).toBe(5_000_000);
    expect(ARTIFACT_DATA_PLANS.pro.dataArtifacts).toBe(10);
    expect(ARTIFACT_DATA_PLANS.team.dataArtifacts).toBe(50);
    expect(ARTIFACT_DATA_PLANS.enterprise).toEqual(ARTIFACT_DATA_PLANS.team);
  });
});

describe("dataRefusalError", () => {
  it("maps every refusal code the object produces", () => {
    for (const code of DATA_REFUSAL_CODES) {
      const mapped = dataRefusalError(code, "no such document");
      expect(mapped.message.length).toBeGreaterThan(0);
    }
  });

  it("keeps the codes the API shares and capitalizes the message", () => {
    expect(dataRefusalError("not_found", "no such document")).toEqual({
      code: "not_found",
      message: "No such document.",
    });
    expect(dataRefusalError("quota_exceeded", "Full!")).toEqual({
      code: "quota_exceeded",
      message: "Full!",
    });
    expect(dataRefusalError("rate_limited", "  ").message).toBe("Refused.");
  });

  it("never says why a held artifact refuses", () => {
    expect(dataRefusalError("held", "held by a legal hold")).toEqual({
      code: "forbidden",
      message: HELD_MESSAGE,
    });
  });

  it("reads stale and conflict as a version conflict, quarantine as unavailable", () => {
    expect(dataRefusalError("stale", "older epoch").code).toBe("version_conflict");
    expect(dataRefusalError("stale", "older epoch").message).not.toContain("epoch");
    expect(dataRefusalError("conflict", "unique key taken").code).toBe("version_conflict");
    expect(dataRefusalError("quarantined", "x").code).toBe("capacity_unavailable");
    expect(dataRefusalError("something_new", "x").code).toBe("capacity_unavailable");
  });
});

describe("dataAuditEvent", () => {
  it("names only kinds the audit catalog has", () => {
    for (const kind of Object.values(DATA_AUDIT_EVENTS)) expect(kind in AUDIT_DETAILS).toBe(true);
  });

  it("keeps the count of bulk changes and nothing for single ones", () => {
    expect(dataAuditEvent("data.documents_deleted", { documents: 7 })).toEqual({
      kind: "data.documents_deleted",
      detail: { documents: 7 },
    });
    expect(dataAuditEvent("data.documents_created", null)).toEqual({
      kind: "data.documents_created",
      detail: { documents: 0 },
    });
    expect(dataAuditEvent("data.documents_replaced", { documents: 1.5 })?.detail).toEqual({
      documents: 0,
    });
    expect(dataAuditEvent("data.document_created", { documents: 1 })).toEqual({
      kind: "data.document_created",
      detail: {},
    });
  });

  it("records nothing for an index step or an unknown kind", () => {
    expect(dataAuditEvent("data.index_step", { building: 1 })).toBeNull();
    expect(dataAuditEvent("data.author_erased", { documents: 1 })).toBeNull();
    expect(dataAuditEvent("toString", null)).toBeNull();
  });

  it("gives details the catalog accepts", () => {
    for (const kind of Object.values(DATA_AUDIT_EVENTS)) {
      const event = dataAuditEvent(kind, { documents: 3 });
      expect(event).not.toBeNull();
      const schema = AUDIT_DETAILS[kind];
      expect(schema.safeParse(event?.detail).success).toBe(true);
    }
  });
});

describe("export helpers", () => {
  it("is consistent only when every revision agrees", () => {
    expect(exportConsistent([3, 3, 3])).toBe(true);
    expect(exportConsistent([3])).toBe(true);
    expect(exportConsistent([3, 4])).toBe(false);
  });

  it("round-trips a cursor and refuses a malformed one", () => {
    const cursor = { collection: "votes", id: "AAAAAAAAAAAAAAAA" };
    expect(parseExportCursor(exportCursorText(cursor) ?? "")).toEqual(cursor);
    expect(exportCursorText(null)).toBeNull();
    expect(parseExportCursor(undefined)).toBeNull();
    expect(parseExportCursor("votes")).toBeUndefined();
    expect(parseExportCursor("votes/AAAAAAAAAAAAAAAA/x")).toBeUndefined();
    expect(parseExportCursor("Votes/AAAAAAAAAAAAAAAA")).toBeUndefined();
  });

  it("reads query values as numbers and booleans where they look like one", () => {
    expect(queryValue("true")).toBe(true);
    expect(queryValue("false")).toBe(false);
    expect(queryValue("42")).toBe(42);
    expect(queryValue("-1.5")).toBe(-1.5);
    expect(queryValue("007")).toBe("007");
    expect(queryValue("yes")).toBe("yes");
  });

  it("builds the object's query and count from query parameters", () => {
    expect(
      dataQueryOf("votes", {
        equalsField: "choice",
        equalsValue: "a",
        createdOp: "gt",
        createdValue: 5,
        order: "-created",
        limit: 10,
        after: "x",
      }),
    ).toEqual({
      collection: "votes",
      equals: { field: "choice", value: "a" },
      created: { op: "gt", value: 5 },
      order: "-created",
      limit: 10,
      after: "x",
    });
    expect(dataQueryOf("votes", {})).toEqual({ collection: "votes" });
    expect(dataCountOf({ collection: "votes", by: "owner" })).toEqual({
      collection: "votes",
      by: "owner",
    });
    expect(dataCountOf({ collection: "votes", equalsField: "n", equalsValue: "2" })).toEqual({
      collection: "votes",
      equals: { field: "n", value: 2 },
    });
  });
});
