// The mutation pipeline's steps 1 to 6 (`planMutation`), each refusal exact, over fake reads that
// record which rows the decision asked for.
import {
  ARTIFACT_DATA,
  type ChargeClass,
  type DataControl,
} from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import {
  envelope,
  FREE,
  NOW,
  OWNER,
  READER,
  ROOMY,
  visitor,
} from "../testing/artifact-data-fixtures.ts";
import { refuse } from "./decision.ts";
import {
  auditObligation,
  bulkBodies,
  type CollectionFacts,
  classLimit,
  compareKeys,
  declareCollection,
  describeCollection,
  describe as describeData,
  emptyDay,
  meter,
  newAttachment,
  newControl,
  newerReport,
  nextBuild,
  noPendingReads,
  outbound,
  pageOf,
  payloadChanged,
  planCount,
  renewDecision,
  rollPending,
  spentRefusal,
} from "./index.ts";
import {
  type MutationActor,
  type MutationKind,
  type MutationReads,
  type MutationRequest,
  planExport,
  planMutation,
  planRead,
} from "./mutation.ts";

const a = visitor("a");
const author = (a as { author: string }).author;
const stored: DataControl = newControl(envelope(), NOW);
const op = `${NOW}.abcdefgh`;

interface World {
  collection: CollectionFacts | null;
  document: { creator: string; size: number } | null;
  barred: string[];
  prior: {
    requestHash: string;
    state: "committed" | "aborted";
    kind: string;
    target: string;
    result: null;
  } | null;
  used: Partial<Record<ChargeClass, number>>;
  rights: Record<string, number>;
  attempts: number;
  rate: number;
}

function reads(world: Partial<World> = {}) {
  const w: World = {
    collection: { mode: "shared", uniqueKey: null, documents: 0, bytes: 0, fields: [] },
    document: { creator: author, size: 10 },
    barred: [],
    prior: null,
    used: {},
    rights: {},
    attempts: 1,
    rate: 0,
    ...world,
  };
  const asked: string[] = [];
  const fake: MutationReads = {
    prior: (key) => {
      asked.push(`prior:${key}`);
      return w.prior;
    },
    barred: (who) => {
      asked.push(`barred:${who}`);
      return w.barred.includes(who);
    },
    collection: (name) => {
      asked.push(`collection:${name}`);
      return w.collection;
    },
    document: (collection, id) => {
      asked.push(`document:${collection}/${id}`);
      return w.document;
    },
    used: (charge) => w.used[charge] ?? 0,
    rights: (who) => w.rights[who] ?? 0,
    callerAttempts: () => w.attempts,
    rate: (subject, kind, window) => {
      asked.push(`rate:${subject}:${kind}:${window}`);
      return w.rate;
    },
  };
  return { fake, asked };
}

function request(
  kind: MutationKind,
  actor: MutationActor,
  extra: Partial<MutationRequest> = {},
): MutationRequest {
  return {
    kind,
    envelope: { ...envelope(), opId: op },
    actor,
    now: NOW,
    limits: ROOMY,
    hash: "h",
    collection: "items",
    documentId: "d",
    newSize: 5,
    author: author,
    ...extra,
  };
}

const plan = (
  kind: MutationKind,
  actor: MutationActor,
  world: Partial<World> = {},
  extra: Partial<MutationRequest> = {},
  control: DataControl | null = stored,
) => planMutation(control, request(kind, actor, extra), reads(world).fake);

describe("planMutation", () => {
  it("binds an empty object only for an owner's declaration or the erasure job", () => {
    expect(plan("declare", OWNER, {}, {}, null)).toMatchObject({
      decision: "proceed",
      binds: true,
      control: { ownerId: "owner_a", storageSeq: 0 },
      charge: "growth",
      rate: null,
    });
    expect(plan("erase_author_chunk", { kind: "erasure" }, {}, {}, null)).toMatchObject({
      decision: "proceed",
      binds: true,
      charge: "cleanup",
    });
    expect(plan("declare", a, {}, {}, null)).toEqual({
      decision: "refused",
      refusal: refuse("not_found", "no such collection"),
    });
    expect(plan("create", READER, {}, {}, null)).toEqual({
      decision: "refused",
      refusal: refuse("not_found", "no such collection"),
    });
    expect(plan("create", OWNER, {}, {}, null)).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "only a declaration or an erasure step writes first"),
    });
    expect(plan("erase_author_chunk", OWNER, {}, {}, null)).toMatchObject({
      refusal: { code: "forbidden" },
    });
    expect(plan("declare", { kind: "erasure" }, {}, {}, null)).toMatchObject({
      refusal: { code: "forbidden" },
    });
    expect(plan("create", OWNER, {}, {}, stored)).toMatchObject({
      decision: "proceed",
      binds: false,
      control: stored,
    });
    expect(plan("create", OWNER, {}, { envelope: { ...envelope(), region: "eu" } })).toMatchObject({
      refusal: { code: "forbidden" },
    });
  });

  it("checks replay before the horizon and authorizes again before answering it", () => {
    const prior = {
      requestHash: "h",
      state: "committed" as const,
      kind: "document",
      target: "items/d",
      result: null,
    };
    const { fake, asked } = reads({ prior });
    expect(planMutation(stored, request("create", a), fake)).toEqual({
      decision: "replayed",
      answer: { kind: "document", target: "items/d", result: null },
      charge: "read",
    });
    expect(asked[0]).toBe(`prior:${author}|0|${op}`);
    expect(asked).toContain("collection:items");
    expect(asked.some((item) => item.startsWith("rate:"))).toBe(false);
    expect(plan("create", a, { prior, barred: [author] })).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "this author's data was erased"),
    });
    expect(plan("create", visitor("a", false), { prior })).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "you cannot write to this collection"),
    });
    expect(plan("create", a, { prior: { ...prior, requestHash: "x" } })).toMatchObject({
      refusal: { code: "conflict" },
    });
    const late = { ...envelope(), opId: `${NOW - 90_000_000}.abcdefgh` };
    expect(plan("create", a, { prior }, { envelope: late })).toMatchObject({
      decision: "replayed",
    });
    expect(plan("create", a, {}, { envelope: late })).toMatchObject({
      refusal: { code: "conflict" },
    });
    const none = reads();
    expect(
      planMutation(stored, request("create", a, { envelope: envelope() }), none.fake),
    ).toMatchObject({ decision: "proceed", key: null });
    expect(none.asked.some((item) => item.startsWith("prior:"))).toBe(false);
    const empty = reads({ prior });
    expect(planMutation(null, request("declare", OWNER), empty.fake)).toMatchObject({
      decision: "proceed",
      key: `owner:owner|0|${op}`,
    });
    expect(empty.asked.some((item) => item.startsWith("prior:"))).toBe(false);
  });

  it("runs each kind's authorization with exact refusals", () => {
    expect(plan("declare", a)).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "owner side only"),
    });
    expect(plan("index_step", READER)).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "owner side only"),
    });
    expect(plan("bulk_remove", a)).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "owner side only"),
    });
    expect(plan("index_step", OWNER, { collection: null })).toMatchObject({ decision: "proceed" });
    expect(plan("bulk_remove", OWNER, { collection: null })).toEqual({
      decision: "refused",
      refusal: refuse("not_found", "no such collection"),
    });
    expect(plan("erase_author_chunk", OWNER)).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "erasure only"),
    });
    for (const kind of ["create", "replace", "remove"] as const) {
      expect(plan(kind, { kind: "erasure" })).toEqual({
        decision: "refused",
        refusal: refuse("forbidden", "not an erasure step"),
      });
      expect(plan(kind, a, { collection: null })).toEqual({
        decision: "refused",
        refusal: refuse("not_found", "no such collection"),
      });
      expect(plan(kind, a, { barred: [author] })).toEqual({
        decision: "refused",
        refusal: refuse("forbidden", "this author's data was erased"),
      });
    }
    const readOnly = { mode: "read" as const, uniqueKey: null, documents: 0, bytes: 0, fields: [] };
    expect(plan("create", a, { collection: readOnly })).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "you cannot write to this collection"),
    });
    expect(plan("replace", a, { collection: readOnly })).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "you cannot write to this collection"),
    });
    expect(plan("remove", a, { collection: readOnly })).toMatchObject({ decision: "proceed" });
    expect(plan("remove", READER)).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "you cannot delete in this collection"),
    });
    expect(plan("create", READER, { collection: readOnly })).toMatchObject({
      refusal: { message: "you cannot write to this collection" },
    });
  });

  it("finds the document in the scope of the command, and refuses edits of a barred creator", () => {
    const own = { mode: "own" as const, uniqueKey: null, documents: 0, bytes: 0, fields: [] };
    const { fake, asked } = reads({ collection: own });
    expect(planMutation(stored, request("replace", a), fake)).toMatchObject({
      decision: "proceed",
    });
    expect(asked).toContain("document:items/d");
    expect(plan("replace", a, { document: null })).toEqual({
      decision: "refused",
      refusal: refuse("not_found", "no such document"),
    });
    expect(
      plan("replace", a, { collection: own, document: { creator: "other", size: 1 } }),
    ).toEqual({ decision: "refused", refusal: refuse("not_found", "no such document") });
    expect(
      plan("remove", a, { collection: own, document: { creator: "other", size: 1 } }),
    ).toMatchObject({ refusal: { code: "not_found" } });
    expect(
      plan("remove", visitor("a", false), { document: { creator: "other", size: 1 } }),
    ).toMatchObject({ refusal: { code: "not_found" } });
    expect(plan("replace", a, { document: { creator: "other", size: 1 } })).toMatchObject({
      decision: "proceed",
    });
    expect(
      plan("replace", OWNER, { document: { creator: "gone", size: 1 }, barred: ["gone"] }),
    ).toEqual({
      decision: "refused",
      refusal: refuse("conflict", "this document's creator is being erased"),
    });
    expect(
      plan("remove", OWNER, { document: { creator: "gone", size: 1 }, barred: ["gone"] }),
    ).toMatchObject({ decision: "proceed", charge: "cleanup" });
  });

  it("chooses the class from the command and the document", () => {
    expect(plan("create", a)).toMatchObject({ charge: "growth" });
    expect(plan("declare", OWNER)).toMatchObject({ charge: "growth" });
    expect(plan("index_step", OWNER)).toMatchObject({ charge: "growth" });
    expect(plan("replace", a, {}, { newSize: 11 })).toMatchObject({ charge: "growth" });
    expect(plan("replace", a, {}, { newSize: 10 })).toMatchObject({ charge: "cleanup" });
    expect(plan("replace", OWNER, {}, { newSize: 10 })).toMatchObject({ charge: "cleanup" });
    expect(
      plan("replace", a, {}, { newSize: undefined } as unknown as Partial<MutationRequest>),
    ).toMatchObject({ charge: "growth" });
    expect(plan("remove", a)).toMatchObject({ charge: "rights" });
    expect(plan("remove", a, { document: { creator: "other", size: 1 } })).toMatchObject({
      charge: "cleanup",
    });
    expect(plan("remove", OWNER, { document: { creator: "", size: 1 } })).toMatchObject({
      charge: "cleanup",
    });
    expect(plan("bulk_remove", OWNER, {}, { documentIds: ["d"] })).toMatchObject({
      charge: "cleanup",
    });
  });

  it("refuses a spent class before the rate, except for erasure", () => {
    const spent = { used: { growth: ROOMY.rowsWrittenPerDay, cleanup: ROOMY.cleanupRowsPerDay } };
    const { fake, asked } = reads(spent);
    expect(planMutation(stored, request("create", a), fake)).toEqual({
      decision: "refused",
      refusal: refuse("quota_exceeded", "this artifact's data budget for today is spent"),
    });
    expect(asked.some((item) => item.startsWith("rate:"))).toBe(false);
    expect(plan("erase_author_chunk", { kind: "erasure" }, spent)).toMatchObject({
      decision: "proceed",
    });
    expect(plan("bulk_remove", OWNER, spent, { documentIds: ["d"] })).toMatchObject({
      refusal: { code: "rate_limited" },
    });
    expect(plan("create", a, { used: { growth: ROOMY.rowsWrittenPerDay - 1 } })).toMatchObject({
      decision: "proceed",
    });
  });

  it("counts visitors' writes and deletes per minute, and nobody else's", () => {
    const window = Math.floor(NOW / 60_000);
    expect(plan("create", a)).toMatchObject({ rate: { subject: author, kind: "writes", window } });
    expect(plan("replace", a)).toMatchObject({ rate: { kind: "writes" } });
    expect(plan("remove", a)).toMatchObject({ rate: { kind: "deletes" } });
    expect(plan("create", OWNER)).toMatchObject({ rate: null });
    const limits = { ...FREE, writesPerAuthorPerMinute: 3, deletesPerAuthorPerMinute: 5 };
    expect(plan("create", a, { rate: 2 }, { limits })).toMatchObject({ decision: "proceed" });
    expect(plan("create", a, { rate: 3 }, { limits })).toEqual({
      decision: "refused",
      refusal: refuse("rate_limited", "too many requests, try again in a minute"),
    });
    expect(plan("remove", a, { rate: 4 }, { limits })).toMatchObject({ decision: "proceed" });
    expect(plan("remove", a, { rate: 5 }, { limits })).toMatchObject({
      refusal: { code: "rate_limited" },
    });
    const { fake, asked } = reads();
    planMutation(stored, request("remove", a), fake);
    expect(asked.at(-1)).toBe(`rate:${author}:deletes:${window}`);
  });

  it("admits reads and exports in request mode, never binding", () => {
    const erasing = { ...stored, erasing: { id: op, generation: 0, epoch: 0 } };
    const input = {
      stored: erasing,
      envelope: envelope(),
      caller: a,
      limits: ROOMY,
      callerReads: 1,
      used: 0,
      barred: false,
    };
    expect(planRead(input)).toEqual({
      decision: "refused",
      refusal: refuse("stale", "the data is being erased"),
    });
    expect(planRead({ ...input, stored, barred: true })).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "this author's data was erased"),
    });
    expect(planRead({ ...input, stored, used: ROOMY.rowsReadPerDay })).toEqual({
      decision: "refused",
      refusal: refuse("quota_exceeded", "this artifact's data budget for today is spent"),
    });
    const exportInput = {
      stored: erasing,
      envelope: envelope(),
      who: "owner" as const,
      limits: ROOMY,
      used: () => 0,
      barred: false,
    };
    expect(planExport(exportInput)).toEqual({
      decision: "refused",
      refusal: refuse("stale", "the data is being erased"),
    });
    expect(planExport({ ...exportInput, stored, who: "visitor", barred: true })).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "this author's data was erased"),
    });
    expect(planExport({ ...exportInput, stored, used: () => ROOMY.exportRowsPerDay })).toEqual({
      decision: "refused",
      refusal: refuse("rate_limited", "this artifact's export allowance for today is spent"),
    });
  });
});

describe("orderings", () => {
  it("builds the first building field by collection, then by field", () => {
    const field = (collection: string, name: string) => ({
      collection,
      field: name,
      state: "building" as const,
      cursor: null,
    });
    expect(nextBuild([field("b", "a"), field("a", "b")])).toEqual(field("a", "b"));
    expect(nextBuild([field("a", "b"), field("b", "a")])).toEqual(field("a", "b"));
    expect(nextBuild([field("a", "b"), field("a", "a")])).toEqual(field("a", "a"));
    expect(nextBuild([field("a", "a"), field("a", "b")])).toEqual(field("a", "a"));
    const [first, second] = [field("a", "a"), field("a", "a")];
    expect(nextBuild([first, second])).toBe(first);
    const [earlier, later] = [field("b", "a"), field("b", "a")];
    expect(nextBuild([field("c", "a"), earlier, later])).toBe(earlier);
    expect(nextBuild([field("b", "a"), field("a", "z")])).toEqual(field("a", "z"));
  });

  it("orders keys and pages exactly", () => {
    expect(compareKeys([1, "a"], [1, "a"])).toBe(0);
    expect(compareKeys([2, "a"], [2, "b"])).toBe(-1);
    expect(compareKeys([1, "b"], [2, "a"])).toBe(-1);
    expect(
      pageOf(
        [
          { created: 1, id: "a" },
          { created: 1, id: "b" },
        ],
        2,
      ).next,
    ).toBeNull();
    expect(
      newerReport({ generation: 2, seq: 0, bytes: 0 }, { generation: 2, seq: 0, bytes: 0 }),
    ).toBe(false);
    expect(
      newerReport({ generation: 3, seq: 0, bytes: 0 }, { generation: 2, seq: 9, bytes: 0 }),
    ).toBe(false);
  });
});

describe("the rules added after the review of PR 254", () => {
  it("plans owner bulk writes: owner only, a known collection, each document once and present", () => {
    const bulk = (extra: Partial<MutationRequest>, world: Partial<World> = {}) =>
      planMutation(
        stored,
        request("bulk_replace", OWNER, { documentIds: ["a", "b"], newSize: 25, ...extra }),
        reads(world).fake,
      );
    expect(planMutation(stored, request("bulk_create", a), reads().fake)).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "owner side only"),
    });
    expect(planMutation(stored, request("bulk_replace", a), reads().fake)).toEqual({
      decision: "refused",
      refusal: refuse("forbidden", "owner side only"),
    });
    expect(
      planMutation(stored, request("bulk_create", OWNER), reads({ collection: null }).fake),
    ).toMatchObject({ refusal: { code: "not_found" } });
    expect(planMutation(stored, request("bulk_create", OWNER), reads().fake)).toMatchObject({
      decision: "proceed",
      charge: "growth",
    });
    expect(bulk({ documentIds: ["a", "a"] })).toEqual({
      decision: "refused",
      refusal: refuse("invalid_input", "a bulk command names each document once"),
    });
    expect(bulk({}, { document: null })).toEqual({
      decision: "refused",
      refusal: refuse("not_found", "no such document"),
    });
    expect(bulk({ newSize: 21 })).toMatchObject({ decision: "proceed", charge: "growth" });
    expect(bulk({ newSize: 20 })).toMatchObject({ decision: "proceed", charge: "cleanup" });
    expect(bulk({ documentIds: undefined } as unknown as Partial<MutationRequest>)).toEqual({
      decision: "refused",
      refusal: refuse("invalid_input", "between 1 and 100 documents"),
    });
    expect(bulk({ documentIds: [] })).toMatchObject({ refusal: { code: "invalid_input" } });
    const many = Array.from({ length: 101 }, (_, i) => `d${i}`);
    expect(bulk({ documentIds: many })).toMatchObject({ refusal: { code: "invalid_input" } });
  });

  it("authorizes every bulk target exactly as the single command, barrier included", () => {
    const barred = { document: { creator: "gone", size: 1 }, barred: ["gone"] };
    expect(plan("bulk_replace", OWNER, barred, { documentIds: ["a"], newSize: 1 })).toEqual(
      plan("replace", OWNER, barred, { documentId: "a", newSize: 1 }),
    );
    expect(plan("bulk_replace", OWNER, barred, { documentIds: ["a"] })).toEqual({
      decision: "refused",
      refusal: refuse("conflict", "this document's creator is being erased"),
    });
    expect(plan("bulk_remove", OWNER, { document: null }, { documentIds: ["a"] })).toEqual(
      plan("remove", OWNER, { document: null }, { documentId: "a" }),
    );
    // Mixed targets: one refusal refuses the whole command, whichever position it holds.
    const mixed = (ids: string[], kind: "bulk_replace" | "bulk_remove") => {
      const fake = reads().fake;
      const world: MutationReads = {
        ...fake,
        document: (_c, id) =>
          id === "gone"
            ? { creator: "gone", size: 1 }
            : id === "missing"
              ? null
              : { creator: author, size: 1 },
        barred: (who) => who === "gone",
      };
      return planMutation(stored, request(kind, OWNER, { documentIds: ids, newSize: 1 }), world);
    };
    expect(mixed(["a", "b", "gone"], "bulk_replace")).toMatchObject({
      refusal: { code: "conflict" },
    });
    expect(mixed(["gone", "a"], "bulk_replace")).toMatchObject({ refusal: { code: "conflict" } });
    expect(mixed(["a", "missing"], "bulk_remove")).toMatchObject({
      refusal: { code: "not_found" },
    });
    expect(mixed(["a", "gone"], "bulk_remove")).toMatchObject({ decision: "proceed" });
  });

  it("spends a visitor's own rights row, nobody else's, and refuses it at its limit", () => {
    const limits = { ...ROOMY, rightsRowsPerDay: 10 };
    expect(plan("remove", a, { rights: { [author]: 9 } }, { limits })).toMatchObject({
      decision: "proceed",
      charge: "rights",
      rightsAuthor: author,
    });
    expect(plan("remove", a, { rights: { [author]: 10 } }, { limits })).toEqual({
      decision: "refused",
      refusal: refuse("rate_limited", "this artifact's rights allowance for today is spent"),
    });
    expect(
      plan("remove", a, { rights: { other: 99 }, used: { rights: 99 } }, { limits }),
    ).toMatchObject({ decision: "proceed" });
    expect(plan("remove", OWNER, { rights: { [author]: 99 } }, { limits })).toMatchObject({
      charge: "cleanup",
      rightsAuthor: null,
    });
  });

  it("treats a replay as a read attempt for visitors and readers, the owner side's against the read day, the erasure job's never", () => {
    const prior = {
      requestHash: "h",
      state: "committed" as const,
      kind: "document",
      target: "items/d",
      result: null,
    };
    const limits = { ...ROOMY, readsPerCallerPerMinute: 3, rowsReadPerDay: 5 };
    expect(plan("create", a, { prior, attempts: 3 }, { limits })).toMatchObject({
      decision: "replayed",
    });
    expect(plan("create", a, { prior, attempts: 4 }, { limits })).toEqual({
      decision: "refused",
      refusal: refuse("rate_limited", "too many requests, try again in a minute"),
    });
    expect(plan("create", OWNER, { prior, attempts: 99 }, { limits })).toMatchObject({
      decision: "replayed",
    });
    expect(plan("create", OWNER, { prior, used: { read: 5 } }, { limits })).toEqual({
      decision: "refused",
      refusal: refuse("quota_exceeded", "this artifact's data budget for today is spent"),
    });
    expect(
      plan(
        "erase_author_chunk",
        { kind: "erasure" },
        { prior, used: { read: 5 }, attempts: 99 },
        { limits },
      ),
    ).toMatchObject({ decision: "replayed", charge: "protected" });
  });

  it("refuses visitors and readers whose minute is spent, before anything else, refusals included", () => {
    const limits = { ...ROOMY, readsPerCallerPerMinute: 3 };
    for (const caller of [a, READER]) {
      const { fake, asked } = reads({ attempts: 4, collection: null });
      expect(planMutation(stored, request("create", caller, { limits }), fake)).toEqual({
        decision: "refused",
        refusal: refuse("rate_limited", "too many requests, try again in a minute"),
      });
      expect(asked).toEqual([]);
    }
    expect(plan("create", a, { attempts: 3 }, { limits })).toMatchObject({ decision: "proceed" });
    expect(plan("create", OWNER, { attempts: 99 }, { limits })).toMatchObject({
      decision: "proceed",
    });
  });

  it("raises the payload revision and writes audit obligations by the record's rules", () => {
    expect([
      payloadChanged({ documents: 0, declared: false }),
      payloadChanged({ documents: 1, declared: false }),
      payloadChanged({ documents: 0, declared: true }),
    ]).toEqual([false, true, true]);
    expect(auditObligation("index_step", OWNER, { building: 1 })).toEqual({
      kind: "data.index_step",
      detail: { building: 1 },
    });
    expect(auditObligation("erase_author_chunk", { kind: "erasure" }, { documents: 1 })).toEqual({
      kind: "data.author_erased",
      detail: { documents: 1 },
    });
    expect(auditObligation("create", a, {})).toBeNull();
    expect(auditObligation("create", READER, {})).toBeNull();
    const kinds = [
      "declare",
      "create",
      "replace",
      "remove",
      "bulk_create",
      "bulk_replace",
      "bulk_remove",
    ] as const;
    expect(kinds.map((kind) => auditObligation(kind, OWNER, {})?.kind)).toEqual([
      "data.collection_set",
      "data.document_created",
      "data.document_replaced",
      "data.document_deleted",
      "data.documents_created",
      "data.documents_replaced",
      "data.documents_deleted",
    ]);
  });

  it("counts and describes for the owner side only, collections sorted", () => {
    expect(planCount({ collection: "c" }, a, [])).toEqual(refuse("forbidden", "owner side only"));
    expect(planCount({ collection: "c" }, OWNER, [])).toEqual({
      ok: true,
      value: { kind: "collection" },
    });
    expect(planCount({ collection: "c", by: "v" }, OWNER, [])).toEqual({
      ok: true,
      value: { kind: "author", author: "v" },
    });
    expect(planCount({ collection: "c", equals: { field: "f", value: 1 } }, OWNER, ["f"])).toEqual({
      ok: true,
      value: { kind: "value", field: "f", value: "1" },
    });
    const info = (name: string) => ({
      name,
      mode: "own" as const,
      uniqueKey: null,
      indexed: [],
      documents: 0,
      bytes: 0,
    });
    const today = { ...newControl(envelope(), NOW), day: 0 } as unknown as Parameters<
      typeof describeData
    >[1]["today"];
    expect(
      describeData(a, { generation: 1, revision: 2, collections: [], today, connections: 0 }),
    ).toEqual(refuse("forbidden", "owner side only"));
    expect(
      describeData(OWNER, {
        generation: 1,
        revision: 2,
        collections: [info("b"), info("a")],
        today,
        connections: 3,
      }),
    ).toMatchObject({
      ok: true,
      value: { generation: 1, revision: 2, collections: [info("a"), info("b")], connections: 3 },
    });
    expect(
      describeCollection("c", { mode: "own", uniqueKey: "k", documents: 3, bytes: 9 }, [
        { collection: "c", field: "x", state: "ready", cursor: null },
        { collection: "d", field: "y", state: "building", cursor: null },
      ]),
    ).toEqual({
      name: "c",
      mode: "own",
      uniqueKey: "k",
      indexed: [{ field: "x", state: "ready" }],
      documents: 3,
      bytes: 9,
    });
  });

  it("validates bulk bodies all or nothing, unique values per creator", () => {
    expect(bulkBodies([{ k: 1 }, { k: 1 }], "k", ["x", "y"], ROOMY)).toMatchObject({ ok: true });
    expect(bulkBodies([{ k: 1 }, { k: 1 }], "k", ["x", "x"], ROOMY)).toEqual(
      refuse("conflict", "two documents hold the same unique value"),
    );
    expect(bulkBodies([{ k: 1 }, { k: 1 }], "k", [], ROOMY)).toMatchObject({ code: "conflict" });
    expect(bulkBodies([{ k: {} }], "k", ["x"], ROOMY)).toMatchObject({ code: "invalid_input" });
    expect(bulkBodies([[]], null, ["x"], ROOMY)).toMatchObject({ code: "invalid_input" });
    expect(
      bulkBodies(
        Array.from({ length: 101 }, () => ({})),
        null,
        [],
        ROOMY,
      ),
    ).toEqual(refuse("invalid_input", "between 1 and 100 documents"));
    expect(bulkBodies([{ k: 2 }], null, ["x"], ROOMY)).toEqual({
      ok: true,
      value: [{ text: '{"k":2}', size: 7, unique: null }],
    });
    expect(classLimit("protected", ROOMY)).toBe(Number.POSITIVE_INFINITY);
    expect(spentRefusal("protected", Number.MAX_SAFE_INTEGER, ROOMY)).toBeNull();
  });
});

describe("boundaries the code review's rules turn on", () => {
  it("writes an earlier day's reads into that day while it is kept, and into today after", () => {
    const now = NOW;
    const today = Math.floor(now / 86_400_000);
    const at = (day: number) => ({ day, rows: 4, refused: 0, deferred: 3, since: 0 });
    expect(rollPending(at(today - ARTIFACT_DATA.dayKeepDays), now)).toEqual({
      previous: { ...at(today - ARTIFACT_DATA.dayKeepDays), deferred: 0 },
      current: { ...noPendingReads(now), deferred: 3 },
    });
    expect(rollPending(at(today - ARTIFACT_DATA.dayKeepDays - 1), now)).toEqual({
      previous: null,
      current: { ...at(today - ARTIFACT_DATA.dayKeepDays - 1), day: today },
    });
  });

  it("expires live credits with their day and drops them only for a lowered limit", () => {
    const attachment = newAttachment({
      socketId: "s",
      author: null,
      principal: "p",
      generation: 0,
      liveEpoch: 0,
      deadline: NOW + 60_000,
      now: NOW,
      limits: ROOMY,
    });
    const held = { ...attachment, reserved: 5 };
    expect(outbound(held, 1, null, NOW)).toMatchObject({ attachment: { reserved: 4 } });
    expect(outbound(held, 1, null, NOW + 86_400_000)).toEqual({ reserve: true });
    const same = renewDecision(held, "p", NOW + 1_000, NOW, {
      ...ROOMY,
      liveMessagesPerDay: held.liveMessagesPerDay,
    });
    expect(same).toMatchObject({ attachment: { reserved: 5 } });
    const higher = renewDecision(held, "p", NOW + 1_000, NOW, {
      ...ROOMY,
      liveMessagesPerDay: held.liveMessagesPerDay + 1,
    });
    expect(higher).toMatchObject({ attachment: { reserved: 5 } });
    const lower = renewDecision(held, "p", NOW + 1_000, NOW, {
      ...ROOMY,
      liveMessagesPerDay: held.liveMessagesPerDay - 1,
    });
    expect(lower).toMatchObject({ attachment: { reserved: 0 } });
  });

  it("keeps a collection's retained fields after a downgrade, refusing only additions", () => {
    const facts = {
      mode: "own" as const,
      uniqueKey: null,
      documents: 0,
      bytes: 0,
      fields: ["a", "b", "c"],
    };
    const limits = { ...ROOMY, indexedFields: 1 };
    expect(declareCollection(facts, { name: "x", mode: "own" }, 1, limits)).toEqual({
      ok: true,
      value: { create: false, addFields: [] },
    });
    expect(declareCollection(facts, { name: "x", mode: "own", indexed: ["a"] }, 1, limits)).toEqual(
      { ok: true, value: { create: false, addFields: [] } },
    );
    expect(declareCollection(facts, { name: "x", mode: "own", indexed: ["d"] }, 1, limits)).toEqual(
      refuse("quota_exceeded", "at most 1 indexed fields a collection"),
    );
  });

  it("writes a rights row only for a rights charge with its visitor", () => {
    const day = () => emptyDay(Math.floor(NOW / 86_400_000));
    const cost = { rowsRead: 1, rowsWritten: 1 };
    const pending = noPendingReads(NOW);
    expect(
      meter({
        terminal: { kind: "charged", charge: "growth", author: "v" },
        cost,
        pending,
        day,
        bound: true,
        now: NOW,
      }).rights,
    ).toBeNull();
    expect(
      meter({
        terminal: { kind: "charged", charge: "rights", author: "v" },
        cost,
        pending,
        day,
        bound: true,
        now: NOW,
      }).rights,
    ).toEqual({ author: "v", used: 6 });
  });
});
