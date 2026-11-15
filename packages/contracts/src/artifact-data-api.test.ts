import { describe, expect, it } from "vitest";
import {
  DataBulkRemove,
  DataBulkReplace,
  DataExportPageView,
  DataQueryParams,
  dataCountOf,
  dataQueryOf,
  exportCursorText,
  parseExportCursor,
  queryValue,
} from "./artifact-data-api.ts";

const ID = "AAAAAAAAAAAAAAAA";

describe("query parameters", () => {
  it("reads numbers and booleans, keeps other text", () => {
    expect(queryValue("true")).toBe(true);
    expect(queryValue("false")).toBe(false);
    expect(queryValue("12")).toBe(12);
    expect(queryValue("-0.25")).toBe(-0.25);
    expect(queryValue("1e3")).toBe("1e3");
    expect(queryValue("")).toBe("");
  });

  it("builds every query shape and refuses a bad one", () => {
    const params = DataQueryParams.parse({
      equalsField: "_by",
      equalsValue: "owner",
      createdOp: "lte",
      createdValue: "10",
      order: "created",
      limit: "5",
      after: "c",
    });
    expect(dataQueryOf("votes", params)).toEqual({
      collection: "votes",
      equals: { field: "_by", value: "owner" },
      created: { op: "lte", value: 10 },
      order: "created",
      limit: 5,
      after: "c",
    });
    expect(dataQueryOf("votes", { equalsField: "n" })).toEqual({
      collection: "votes",
      equals: { field: "n", value: "" },
    });
    expect(dataQueryOf("votes", { createdOp: "gt" })).toEqual({
      collection: "votes",
      created: { op: "gt", value: 0 },
    });
    expect(() => dataQueryOf("Votes", {})).toThrow();
    expect(DataQueryParams.safeParse({ limit: "101" }).success).toBe(false);
  });

  it("builds counts by collection, author and indexed value", () => {
    expect(dataCountOf({ collection: "votes" })).toEqual({ collection: "votes" });
    expect(dataCountOf({ collection: "votes", by: "v_x" })).toEqual({
      collection: "votes",
      by: "v_x",
    });
    expect(dataCountOf({ collection: "votes", equalsField: "ok" })).toEqual({
      collection: "votes",
      equals: { field: "ok", value: "" },
    });
    expect(dataCountOf({ collection: "votes", equalsField: "ok", equalsValue: "true" })).toEqual({
      collection: "votes",
      equals: { field: "ok", value: true },
    });
  });
});

describe("bulk inputs", () => {
  it("refuses repeated IDs", () => {
    expect(DataBulkRemove.safeParse({ ids: [ID] }).success).toBe(true);
    expect(DataBulkRemove.safeParse({ ids: [ID, ID] }).success).toBe(false);
    expect(
      DataBulkReplace.safeParse({
        documents: [
          { id: ID, body: {} },
          { id: ID, body: {} },
        ],
      }).success,
    ).toBe(false);
    expect(DataBulkReplace.safeParse({ documents: [{ id: ID, body: { a: 1 } }] }).success).toBe(
      true,
    );
  });
});

describe("export cursors and pages", () => {
  it("round-trips a cursor and refuses a malformed one", () => {
    expect(exportCursorText({ collection: "votes", id: ID })).toBe(`votes/${ID}`);
    expect(exportCursorText(null)).toBeNull();
    expect(parseExportCursor(`votes/${ID}`)).toEqual({ collection: "votes", id: ID });
    expect(parseExportCursor("")).toBeNull();
    expect(parseExportCursor(undefined)).toBeNull();
    expect(parseExportCursor("votes")).toBeUndefined();
    expect(parseExportCursor(`votes/${ID}/more`)).toBeUndefined();
  });

  it("carries bodies as stored text", () => {
    const page = {
      artifactId: "abcdefgh23",
      revision: 2,
      rows: [
        {
          collection: "votes",
          id: ID,
          by: "owner",
          editedBy: null,
          created: 1,
          updated: 1,
          body: '{"a":1}',
        },
      ],
      next: null,
      header: null,
    };
    expect(DataExportPageView.parse(page)).toEqual(page);
    expect(
      DataExportPageView.safeParse({ ...page, rows: [{ ...page.rows[0], body: { a: 1 } }] })
        .success,
    ).toBe(false);
  });
});
