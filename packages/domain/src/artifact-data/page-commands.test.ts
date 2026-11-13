// The page's commands (decision 0026, delivery 6) through the in-memory reference: the dispatch,
// the caller rules by mode and the modes a page reaches before delivery 9.
import type { CollectionMode, PageCaller } from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import {
  context,
  envelope,
  OWNER,
  op,
  value,
  visitorId,
} from "../testing/artifact-data-fixtures.ts";
import { MemoryObject } from "../testing/artifact-data-object.ts";
import { PAGE_MODES, readScope, writeScope } from "./documents.ts";
import { pageCaller, runPageCommand } from "./page-commands.ts";

const ALICE: PageCaller = { kind: "visitor", author: visitorId("alice"), canWrite: true };
const BOB: PageCaller = { kind: "visitor", author: visitorId("bob"), canWrite: true };
const READER: PageCaller = { kind: "reader" };

type Answer = { ok: boolean; code?: string; value?: unknown };
type Command = Parameters<typeof runPageCommand>[3];

function setup(modes: CollectionMode[] = ["own", "append", "read", "shared"]) {
  const object = new MemoryObject("page");
  const base = envelope();
  for (const mode of modes) {
    value(object.declare(op(base), OWNER, { name: mode, mode }, context()) as never);
  }
  const run = (caller: PageCaller, command: Command, mutation = true) =>
    runPageCommand(object, mutation ? op(base) : base, caller, command, context()) as Answer;
  const ok = <T>(answer: Answer) => value(answer as never) as T;
  return { run, ok };
}

describe("page commands", () => {
  it("keeps a visitor's own documents to them and lets them delete and export what they wrote", () => {
    const { run, ok } = setup();
    const created = ok<{ _id: string }>(
      run(ALICE, { kind: "create", collection: "own", body: { text: "mine" } }),
    );
    expect(run(BOB, { kind: "get", collection: "own", id: created._id }, false).ok).toBe(false);
    expect(
      ok(run(ALICE, { kind: "get", collection: "own", id: created._id }, false)),
    ).toMatchObject({ text: "mine", _by: visitorId("alice") });
    const exported = ok<{ rows: unknown[] }>(
      run(ALICE, { kind: "export_mine", after: null }, false),
    );
    expect(exported.rows).toHaveLength(1);
    expect(run(ALICE, { kind: "remove", collection: "own", id: created._id }).ok).toBe(true);
  });

  it("lets a reader without a grant read append collections but never write or export", () => {
    const { run, ok } = setup();
    ok(run(ALICE, { kind: "create", collection: "append", body: { vote: 1 } }));
    const page = ok<{ documents: unknown[] }>(
      run(READER, { kind: "query", query: { collection: "append" } }, false),
    );
    expect(page.documents).toHaveLength(1);
    expect(run(READER, { kind: "create", collection: "append", body: { vote: 2 } }).ok).toBe(false);
    expect(run(READER, { kind: "export_mine", after: null }, false)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("refuses writes without the current terms but keeps the visitor's own deletes", () => {
    const { run, ok } = setup();
    const created = ok<{ _id: string }>(
      run(ALICE, { kind: "create", collection: "own", body: { a: 1 } }),
    );
    const noTerms: PageCaller = { ...ALICE, canWrite: false };
    expect(run(noTerms, { kind: "create", collection: "own", body: { a: 2 } }).ok).toBe(false);
    expect(run(noTerms, { kind: "remove", collection: "own", id: created._id }).ok).toBe(true);
  });

  it("reaches only own and append collections before delivery 9", () => {
    expect(PAGE_MODES).toEqual(["own", "append"]);
    const { run, ok } = setup();
    for (const collection of ["read", "shared"]) {
      expect(run(ALICE, { kind: "create", collection, body: { a: 1 } }).ok).toBe(false);
      // Out of reach reads like an empty collection, exactly as a reader of an `own` one.
      expect(ok(run(READER, { kind: "query", query: { collection } }, false))).toEqual({
        documents: [],
        next: null,
      });
    }
    for (const mode of ["read", "shared"] as const) {
      expect(readScope(mode, OWNER)).toBe("all");
      expect(writeScope(mode, OWNER)).toBe("all");
    }
  });

  it("gives every page caller the page modes, never the owner's reach", () => {
    expect(pageCaller(ALICE)).toEqual({ ...ALICE, modes: PAGE_MODES });
    expect(pageCaller(READER)).toEqual({ kind: "reader", modes: PAGE_MODES });
    expect(readScope("shared", pageCaller(ALICE))).toBe("none");
    expect(readScope("append", pageCaller(ALICE))).toBe("all");
  });
});
