import {
  AUDIT_DETAILS,
  DATA_REFUSAL_CODES,
  dataCountOf,
  dataQueryOf,
  exportCursorText,
  parseExportCursor,
  queryValue,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  DATA_AUDIT_EVENTS,
  dataAuditEvent,
  dataRefusalError,
  escapeControls,
  exportConsistent,
} from "./artifact-data-owner.ts";
import { HELD_MESSAGE } from "./moderation.ts";

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
    expect(dataAuditEvent("data.author_erased", { documents: 2, edits: 1 })).toEqual({
      kind: "data.author_erased",
      detail: { documents: 2, edits: 1 },
    });
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

describe("escapeControls", () => {
  it("escapes C1 and reordering characters as JSON escapes, keeping the decoded value", () => {
    const csi = String.fromCharCode(0x9b);
    const override = String.fromCharCode(0x202e);
    const separator = String.fromCharCode(0x2028);
    const value = { text: `a${csi}2J${override}b${separator}c` };
    const escaped = escapeControls(JSON.stringify(value));
    for (const char of [csi, override, separator]) expect(escaped.includes(char)).toBe(false);
    expect(escaped).toContain("\\u009b");
    expect(escaped).toContain("\\u202e");
    expect(JSON.parse(escaped)).toEqual(value);
    expect(escapeControls("plain text")).toBe("plain text");
  });
});
