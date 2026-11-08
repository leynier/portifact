import type { AccessLogView } from "@portifact/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  accessLogCsv,
  accessLogJson,
  csvField,
  exportAccessLog,
  loadWholeAccessLog,
} from "./access-log-export.ts";

const ID = "k7d2qm4xab";
const AT = "2026-11-08T12:00:00.000Z";

function view(entries: AccessLogView["entries"], nextCursor: string | null): AccessLogView {
  return { artifactId: ID, entries, nextCursor, windowMinutes: 30, retentionDays: 30 };
}

describe("csvField", () => {
  it("leaves plain values as they are", () => {
    expect(csvField("ana@example.test")).toBe("ana@example.test");
    expect(csvField(AT)).toBe(AT);
    expect(csvField("")).toBe("");
  });

  it("quotes separators, quotes and line breaks, doubling quotes", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("one\ntwo")).toBe('"one\ntwo"');
    expect(csvField("one\r\ntwo")).toBe('"one\r\ntwo"');
  });

  it.each([
    ['=HYPERLINK("http://evil.test")@x.test', '"\'=HYPERLINK(""http://evil.test"")@x.test"'],
    ["+1@example.test", '"\'+1@example.test"'],
    ["-2+3@example.test", '"\'-2+3@example.test"'],
    ["@SUM(A1)@example.test", '"\'@SUM(A1)@example.test"'],
    ["\t=1@example.test", '"\'\t=1@example.test"'],
    ["\r=1@example.test", '"\'\r=1@example.test"'],
  ])("neutralizes a cell a spreadsheet would run as a formula: %j", (value, field) => {
    expect(csvField(value)).toBe(field);
  });

  it("only looks at the first character", () => {
    expect(csvField("ana=1@example.test")).toBe("ana=1@example.test");
    expect(csvField("ana-b@example.test")).toBe("ana-b@example.test");
  });
});

describe("accessLogCsv", () => {
  it("writes a header and one row per entry, in order, with CRLF line ends", () => {
    expect(
      accessLogCsv([
        { email: "ana@example.test", openedAt: AT },
        { email: "=cmd|' /C calc'!A0@x.test", openedAt: "2026-11-08T11:00:00.000Z" },
      ]),
    ).toBe(
      `openedAt,email\r\n${AT},ana@example.test\r\n2026-11-08T11:00:00.000Z,"'=cmd|' /C calc'!A0@x.test"\r\n`,
    );
  });

  it("writes only the header for an empty log", () => {
    expect(accessLogCsv([])).toBe("openedAt,email\r\n");
  });
});

describe("accessLogJson", () => {
  it("writes the shape of portifact logs --json", () => {
    const log = view([{ email: "ana@example.test", openedAt: AT }], "next");
    expect(JSON.parse(accessLogJson(log))).toEqual({ ...log, nextCursor: null });
    expect(accessLogJson(log).endsWith("}\n")).toBe(true);
  });
});

describe("loadWholeAccessLog", () => {
  it("follows the cursor to the end at the largest page size", async () => {
    const accessLog = vi
      .fn()
      .mockResolvedValueOnce(view([{ email: "a@example.test", openedAt: AT }], "c1"))
      .mockResolvedValueOnce(view([{ email: "b@example.test", openedAt: AT }], "c2"))
      .mockResolvedValueOnce(view([], null));
    const log = await loadWholeAccessLog({ accessLog }, ID);
    expect(log.entries.map((entry) => entry.email)).toEqual(["a@example.test", "b@example.test"]);
    expect(log.nextCursor).toBeNull();
    expect(accessLog.mock.calls).toEqual([
      [ID, undefined, 100],
      [ID, "c1", 100],
      [ID, "c2", 100],
    ]);
  });

  it("stops when the cursor does not advance", async () => {
    const accessLog = vi.fn().mockResolvedValue(view([], "same"));
    await expect(loadWholeAccessLog({ accessLog }, ID)).rejects.toThrow("did not advance");
    expect(accessLog).toHaveBeenCalledTimes(2);
  });
});

describe("exportAccessLog", () => {
  const accessLog = () =>
    Promise.resolve(view([{ email: "+ana@example.test", openedAt: AT }], null));

  it("names the CSV after the artifact and types it", async () => {
    const file = await exportAccessLog({ accessLog }, ID, "csv");
    expect(file.fileName).toBe(`${ID}-access-log.csv`);
    expect(file.blob.type).toBe("text/csv;charset=utf-8");
    expect(await file.blob.text()).toBe(`openedAt,email\r\n${AT},"'+ana@example.test"\r\n`);
  });

  it("names the JSON after the artifact and types it", async () => {
    const file = await exportAccessLog({ accessLog }, ID, "json");
    expect(file.fileName).toBe(`${ID}-access-log.json`);
    expect(file.blob.type).toBe("application/json");
    expect(JSON.parse(await file.blob.text()).entries).toEqual([
      { email: "+ana@example.test", openedAt: AT },
    ]);
  });
});
