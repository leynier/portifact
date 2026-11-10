import { AUDIT_CSV_COLUMNS, type AuditEventView } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  auditCsvHeader,
  auditCsvRow,
  auditExportContentType,
  auditExportDetail,
  auditExportFileName,
  auditExportLine,
  auditExportPreamble,
  auditExportStop,
  auditJsonLine,
  csvCell,
  newerFirst,
} from "./audit-export.ts";

/** A fixed data set: the export of these rows must never change, byte for byte. */
const EVENTS: AuditEventView[] = [
  {
    id: "ae_000000000000000000000003",
    at: "2026-11-02T09:00:00.000Z",
    kind: "access.changed",
    actor: { type: "member", id: "u_ada", name: "Ada Lovelace" },
    target: { type: "artifact", id: "abcdefghij" },
    artifact: { id: "abcdefghij", name: 'Plan, "final"\nv2 ✓ 計画' },
    detail: { readersAdded: 2, readerDomains: ["corp.example"], bar: false },
  },
  {
    id: "ae_000000000000000000000002",
    at: "2026-11-02T08:00:00.000Z",
    kind: "member.role_changed",
    actor: { type: "removed_member", id: "u_gone" },
    target: {
      type: "member",
      id: "u_ed",
      member: { type: "member", id: "u_ed", name: "=cmd|' /C calc'!A0" },
    },
    artifact: null,
    detail: { from: "editor", to: "admin" },
  },
  {
    id: "ae_000000000000000000000001",
    at: "2026-11-02T07:00:00.000Z",
    kind: "service_token.revoked",
    actor: { type: "service_token", id: "st_1", label: "+CI\tbuild" },
    target: {
      type: "service_token",
      id: "st_1",
      serviceToken: { type: "service_token", id: "st_1", label: null },
    },
    artifact: null,
    detail: {},
  },
  {
    id: "ae_000000000000000000000000",
    at: "2026-11-02T06:00:00.000Z",
    kind: "plan.granted",
    actor: { type: "operator" },
    target: { type: "plan", id: "ws_1" },
    artifact: { id: "zyxwvutsrq", name: null },
    detail: { plan: "enterprise", seats: 3, validUntil: null },
  },
];

const CSV = [
  "id,at,kind,actor_type,actor_id,actor_name,target_type,target_id,artifact_id,artifact_name,detail",
  'ae_000000000000000000000003,2026-11-02T09:00:00.000Z,access.changed,member,u_ada,Ada Lovelace,artifact,abcdefghij,abcdefghij,"Plan, ""final""\nv2 ✓ 計画","{""readersAdded"":2,""readerDomains"":[""corp.example""],""bar"":false}"',
  'ae_000000000000000000000002,2026-11-02T08:00:00.000Z,member.role_changed,removed_member,u_gone,,member,u_ed,,,"{""from"":""editor"",""to"":""admin""}"',
  "ae_000000000000000000000001,2026-11-02T07:00:00.000Z,service_token.revoked,service_token,st_1,'+CI\tbuild,service_token,st_1,,,{}",
  'ae_000000000000000000000000,2026-11-02T06:00:00.000Z,plan.granted,operator,,,plan,ws_1,zyxwvutsrq,,"{""plan"":""enterprise"",""seats"":3,""validUntil"":null}"',
  "",
].join("\r\n");

describe("CSV cells", () => {
  it("quotes only what RFC 4180 needs and doubles quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("")).toBe("");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
    expect(csvCell("ünïcødé ✓ 計画 🙂")).toBe("ünïcødé ✓ 計画 🙂");
  });

  it("prefixes every cell a spreadsheet would run as a formula", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
      const cell = csvCell(`${start}1+1`);
      expect(cell.replace(/^"/, "").startsWith(`'${start}`), JSON.stringify(start)).toBe(true);
    }
    expect(csvCell("=1,2")).toBe('"\'=1,2"');
    expect(csvCell("\rx")).toBe('"\'\rx"');
    // Only the start counts.
    expect(csvCell("a=1")).toBe("a=1");
    expect(csvCell("'already")).toBe("'already");
  });
});

describe("the export of a fixed data set", () => {
  it("writes the CSV header, then one CRLF line per event, byte for byte", () => {
    expect(auditCsvHeader()).toBe(`${AUDIT_CSV_COLUMNS.join(",")}\r\n`);
    expect(auditCsvHeader() + EVENTS.map(auditCsvRow).join("")).toBe(CSV);
    expect(auditExportPreamble("csv") + EVENTS.map((e) => auditExportLine("csv", e)).join("")).toBe(
      CSV,
    );
  });

  it("writes JSON Lines as the same objects the API returns, one per LF line", () => {
    const jsonl = EVENTS.map(auditJsonLine).join("");
    expect(auditExportPreamble("jsonl")).toBe("");
    expect(EVENTS.map((e) => auditExportLine("jsonl", e)).join("")).toBe(jsonl);
    const lines = jsonl.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual(EVENTS);
    // A newline inside a value stays escaped, so each event is exactly one line.
    expect(lines[0]).toContain("\\nv2 ✓ 計画");
  });

  it("names a fixed file and media type per format", () => {
    expect(auditExportFileName("csv")).toBe("portifact-audit.csv");
    expect(auditExportFileName("jsonl")).toBe("portifact-audit.jsonl");
    expect(auditExportContentType("csv")).toBe("text/csv; charset=utf-8; header=present");
    expect(auditExportContentType("jsonl")).toBe("application/jsonl; charset=utf-8");
  });
});

describe("where an export part stops", () => {
  const a = { at: 10, id: "ae_b" };
  const b = { at: 10, id: "ae_a" };
  const c = { at: 5, id: "ae_z" };

  it("orders newest first, by time and then ID", () => {
    expect([c, b, a].sort(newerFirst)).toEqual([a, b, c]);
    expect(newerFirst(a, a)).toBe(0);
  });

  it("stops at the newer boundary of the two databases, or not at all", () => {
    expect(auditExportStop([null, null])).toBeNull();
    expect(auditExportStop([])).toBeNull();
    expect(auditExportStop([c, null])).toEqual(c);
    expect(auditExportStop([null, b])).toEqual(b);
    expect(auditExportStop([c, b])).toEqual(b);
    expect(auditExportStop([b, a])).toEqual(a);
  });
});

describe("the audit.exported detail", () => {
  it("keeps the format, the number of kinds and the dates, never the actor or target", () => {
    expect(auditExportDetail("csv", {})).toEqual({ format: "csv", kinds: 0 });
    expect(
      auditExportDetail("jsonl", {
        kinds: ["artifact.published", "plan.granted"],
        actor: "u_ada",
        target: "abcdefghij",
        from: "2026-01-01T10:00:00.000Z",
        to: "2026-02-01T00:00:00Z",
      }),
    ).toEqual({ format: "jsonl", kinds: 2, from: "2026-01-01", to: "2026-02-01" });
  });
});
