import { describe, expect, it } from "vitest";
import { dataGate } from "../src/gate.ts";
import {
  buildQuery,
  DataError,
  documentBody,
  MAX_DEPTH,
  readScope,
  writeScope,
} from "../src/model.ts";
import { checkProgram, checkStatement, MAX_PARAMS, MAX_STATEMENT_BYTES } from "../src/sql-guard.ts";
import { visitorId } from "../src/visitor.ts";

const SECRET = "test-only-visitor-secret-0123456789abcdef";

describe("visitor IDs", () => {
  it("are stable in one artifact, unrelated across artifacts, and never the account", async () => {
    const one = await visitorId(SECRET, "a1", { account: "user_1" });
    expect(await visitorId(SECRET, "a1", { account: "user_1" })).toBe(one);
    expect(await visitorId(SECRET, "a2", { account: "user_1" })).not.toBe(one);
    expect(await visitorId(SECRET, "a1", { account: "user_2" })).not.toBe(one);
    expect(await visitorId(SECRET, "a1", { cookie: "user_1" })).not.toBe(one);
    expect(one).toMatch(/^v_[A-Za-z0-9_-]{22}$/);
    expect(one).not.toContain("user_1");
    await expect(visitorId("short", "a1", { account: "user_1" })).rejects.toThrow();
  });
});

describe("the request gate", () => {
  const origin = "https://abc.portifact.dev";
  function request(headers: Record<string, string>): Request {
    return new Request(`${origin}/__portifact/data/items`, { headers });
  }

  it("allows only same-origin requests, with the exact Origin and JSON on writes", () => {
    expect(dataGate(request({ "Sec-Fetch-Site": "same-origin" }), false)).toBe("allowed");
    expect(dataGate(request({ "Sec-Fetch-Site": "same-site" }), false)).toBe("refused");
    expect(dataGate(request({}), false)).toBe("refused");
    const write = {
      "Sec-Fetch-Site": "same-origin",
      Origin: origin,
      "Content-Type": "application/json",
    };
    expect(dataGate(request(write), true)).toBe("allowed");
    expect(dataGate(request({ ...write, Origin: "https://evil.portifact.dev" }), true)).toBe(
      "refused",
    );
    expect(dataGate(request({ ...write, "Content-Type": "text/plain" }), true)).toBe("refused");
    const upgrade = { "Sec-Fetch-Site": "same-origin", Upgrade: "websocket" };
    expect(dataGate(request(upgrade), false)).toBe("refused");
    expect(dataGate(request({ ...upgrade, Origin: origin }), false)).toBe("allowed");
  });
});

describe("the document rules", () => {
  it("decide reads and writes from the mode and the caller only", () => {
    const writer = { kind: "visitor", author: "v", canWrite: true } as const;
    const viewer = { kind: "visitor", author: "v", canWrite: false } as const;
    expect(readScope("own", writer)).toBe("own");
    expect(readScope("own", { kind: "reader" })).toBe("none");
    expect(readScope("append", { kind: "reader" })).toBe("all");
    expect(writeScope("shared", writer)).toBe("all");
    expect(writeScope("append", writer)).toBe("own");
    expect(writeScope("read", writer)).toBe("none");
    expect(writeScope("own", viewer)).toBe("none");
    expect(writeScope("read", { kind: "owner" })).toBe("all");
  });

  it("validates bodies", () => {
    expect(() => documentBody([], 100)).toThrow(DataError);
    expect(() => documentBody("x", 100)).toThrow(DataError);
    let deep: unknown = 1;
    for (let index = 0; index <= MAX_DEPTH; index++) deep = [deep];
    expect(() => documentBody({ deep }, 10_000)).toThrow("too deep");
    let nested: unknown = 1;
    for (let index = 0; index <= MAX_DEPTH; index++) nested = { nested };
    expect(() => documentBody({ nested }, 10_000)).toThrow("too deep");
    expect(documentBody({ é: "ü" }, 100).size).toBe(11);
  });

  it("builds queries only from known fields and operators, always with a limit", () => {
    const built = buildQuery(
      { collection: "items", filters: [{ field: "done", op: "eq", value: true }] },
      "own",
      "v",
    );
    expect(built.sql).toContain("author = ?");
    expect(built.params).toEqual(["items", "v", 1, 21]);
    expect(() =>
      buildQuery(
        { collection: "items", filters: [{ field: "a'b", op: "eq", value: 1 }] },
        "all",
        null,
      ),
    ).toThrow();
    expect(() =>
      buildQuery(
        { collection: "items", filters: [{ field: "a", op: "like" as "eq", value: 1 }] },
        "all",
        null,
      ),
    ).toThrow();
    expect(() =>
      buildQuery(
        { collection: "items", filters: [{ field: "a", op: "in", value: [] }] },
        "all",
        null,
      ),
    ).toThrow();
    expect(() =>
      buildQuery(
        { collection: "items", filters: [{ field: "a", op: "in", value: 3 }] },
        "all",
        null,
      ),
    ).toThrow();
    expect(() =>
      buildQuery(
        {
          collection: "items",
          filters: [{ field: "a", op: "in", value: Array.from({ length: 21 }, (_, i) => i) }],
        },
        "all",
        null,
      ),
    ).toThrow();
    expect(() =>
      buildQuery(
        {
          collection: "items",
          filters: [{ field: "a", op: "eq", value: [1] as unknown as number }],
        },
        "all",
        null,
      ),
    ).toThrow();
    expect(() =>
      buildQuery(
        { collection: "items", filters: Array(5).fill({ field: "a", op: "eq", value: 1 }) },
        "all",
        null,
      ),
    ).toThrow();
    expect(() => buildQuery({ collection: "items", after: "not a cursor" }, "all", null)).toThrow(
      "invalid cursor",
    );
    expect(() => buildQuery({ collection: "items", after: btoa("[1]") }, "all", null)).toThrow(
      "invalid cursor",
    );
    expect(buildQuery({ collection: "items", limit: 1000 }, "all", null).limit).toBe(100);
    expect(
      buildQuery(
        { collection: "items", filters: [{ field: "_updated", op: "gt", value: null }] },
        "all",
        null,
      ).sql,
    ).toContain("updated > ?");
  });
});

describe("the owner SQL lexer and program check", () => {
  it("refuses empty, oversized and unterminated statements", () => {
    expect(checkStatement("  -- nothing\n", [])).toEqual({ ok: false, reason: "empty statement" });
    expect(checkStatement(`select '${"x".repeat(MAX_STATEMENT_BYTES)}'`, []).ok).toBe(false);
    expect(checkStatement("select ?", Array(MAX_PARAMS + 1).fill(1)).ok).toBe(false);
    expect(checkStatement("select 'open", []).ok).toBe(false);
    expect(checkStatement("select /* open", []).ok).toBe(false);
    expect(checkStatement('select [a]]b], "q""q", `t` from x;  /* end */', []).ok).toBe(true);
    expect(checkStatement("select case when 1 then 2 end", []).ok).toBe(true);
  });

  it("refuses a write opcode in a read, and a write to a reserved root page", () => {
    const write = [{ opcode: "OpenWrite", p1: 0, p2: 7 }];
    expect(checkProgram(write, new Set([7]), true).ok).toBe(false);
    expect(checkProgram(write, new Set([8]), true).ok).toBe(true);
    expect(checkProgram(write, new Set(), false).ok).toBe(false);
    expect(checkProgram([{ opcode: "Clear", p1: 7, p2: 0 }], new Set([7]), true).ok).toBe(false);
    expect(checkProgram([{ opcode: "CreateBtree", p1: 0, p2: 0 }], new Set([7]), true).ok).toBe(
      true,
    );
    expect(checkProgram([{ opcode: "OpenRead", p1: 0, p2: 7 }], new Set([7]), false).ok).toBe(true);
  });
});
