// Properties of decision 0026's protocols over random sequences of commands, fences, erases,
// holds, transfers, author erasures, plan changes, retries, clock moves, alarms and evictions,
// run against the in-memory object. A D1 stand-in keeps what the Workers would send (owner,
// generation, epoch), updated only when the object acknowledged a change, and some commands are
// sent with an envelope from earlier in the run, as a late or retried request would be.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type DataControl,
  type DataEnvelope,
  type DayCounters,
} from "@portifact/contracts/artifact-data";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  envelope,
  FREE,
  NOW,
  OWNER,
  ROOMY,
  visitor,
  visitorId,
} from "../testing/artifact-data-fixtures.ts";
import {
  type Answer,
  authorTraces,
  type Doc,
  MemoryObject,
} from "../testing/artifact-data-object.ts";
import { classLimit, measuredCharge } from "./charging.ts";
import type { Caller } from "./documents.ts";

const AUTHORS = ["a", "b", "c"] as const;
const COLLECTIONS = ["mine", "board", "wiki"] as const;
const TIGHT: ArtifactDataLimits = {
  ...FREE,
  rowsWrittenPerDay: 400,
  cleanupRowsPerDay: 300,
  rightsRowsPerDay: 120,
  exportRowsPerDay: 200,
  rowsReadPerDay: 2_000,
  writesPerAuthorPerMinute: 4,
  deletesPerAuthorPerMinute: 3,
  documentsPerCollection: 12,
};

const who = fc.constantFrom<Caller>(
  OWNER,
  visitor("a"),
  visitor("b"),
  visitor("c"),
  visitor("a", false),
  { kind: "reader" },
);
const collection = fc.constantFrom(...COLLECTIONS);
const pick = fc.nat({ max: 40 });
/** Which envelope a command carries: the current one, one from early in the run, or a restored D1's naming the former owner at the current epoch. */
const late = fc.constantFrom("now", "now", "early", "former");

const command = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("create" as const),
      who,
      collection,
      n: fc.nat({ max: 3 }),
      late,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("replace" as const),
      who,
      pick,
      n: fc.nat({ max: 3 }),
      big: fc.boolean(),
      late,
    }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("remove" as const), who, pick, late }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("bulk" as const),
      picks: fc.array(pick, { minLength: 1, maxLength: 4 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("read" as const),
      who,
      collection,
      by: fc.option(fc.constantFrom(...AUTHORS)),
      desc: fc.boolean(),
      pick,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("export" as const),
      mine: fc.option(fc.constantFrom(...AUTHORS)),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("fence" as const),
      kind: fc.constantFrom("hold", "release", "epoch", "transfer"),
      stale: fc.boolean(),
      repeat: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("erase" as const),
      step: fc.constantFrom("prepare", "commit", "cancel"),
      id: fc.nat({ max: 3 }),
      late,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("author" as const),
      author: fc.constantFrom(...AUTHORS),
      take: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("plan" as const), tight: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("retry" as const), pick }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("clock" as const),
      ms: fc.constantFrom(1_000, 60_000, 3_600_000, 23 * 3_600_000, 86_400_000),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("alarm" as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("evict" as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("quarantine" as const),
      resolve: fc.constantFrom("none", "adopt", "erase"),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("settle" as const), pick }) },
);
type Command = typeof command extends fc.Arbitrary<infer T> ? T : never;

interface Mutation {
  envelope: DataEnvelope;
  run: (object: MemoryObject, now: number, limits: ArtifactDataLimits) => Answer<unknown>;
  actor: string;
}

/** The invariants the record states, checked after every step. */
function checkStep(
  before: {
    control: DataControl | null;
    documents: Map<string, Doc>;
    days: Map<number, DayCounters>;
  },
  object: MemoryObject,
  step: {
    command: Command;
    envelope: DataEnvelope | null;
    answer: unknown;
    chargesBefore: number;
    limits: ArtifactDataLimits;
  },
  applied: Set<string>,
  erased: Set<string>,
) {
  const after = object.durable;
  const control = before.control;
  const changed =
    before.documents.size !== after.documents.size ||
    [...after.documents].some(
      ([key, doc]) => JSON.stringify(before.documents.get(key)) !== JSON.stringify(doc),
    );
  const releasing = step.command.t === "fence" && step.command.kind === "release";
  // A held artifact's payload is never changed, erasures included, until a release.
  if (control?.hold && !releasing) expect(changed, "held payload changed").toBe(false);
  // Every change to the documents was admitted across no fence it should not cross.
  const isErase = step.command.t === "erase" || step.command.t === "quarantine";
  if (changed && control !== null && step.envelope !== null && !isErase) {
    expect(step.envelope.ownerId).toBe(control.ownerId);
    expect(step.envelope.epoch).toBeGreaterThanOrEqual(control.epoch);
    expect(step.envelope.generation).toBe(control.generation);
    expect(control.quarantine).toBeNull();
    expect(control.erasing).toBeNull();
  }
  // An erase affects only its generation: documents go only with a new generation.
  if (isErase && changed) {
    expect(after.documents.size).toBe(0);
    expect(after.control?.generation).toBe((control?.generation ?? 0) + 1);
  }
  // Sequences and revisions never go back; the revision moves exactly when documents change.
  if (control !== null && after.control !== null) {
    expect(after.control.storageSeq).toBeGreaterThanOrEqual(control.storageSeq);
    expect(after.control.payloadRevision).toBeGreaterThanOrEqual(control.payloadRevision);
    if (changed) expect(after.control.payloadRevision).toBeGreaterThan(control.payloadRevision);
    if (changed) expect(after.control.storageSeq).toBeGreaterThan(control.storageSeq);
  }
  // Counters never go backwards.
  for (const [day, counters] of before.days) {
    const now = after.days.get(day);
    if (now === undefined) continue;
    for (const field of [
      "growth",
      "read",
      "cleanup",
      "export",
      "rights",
      "live",
      "refused",
    ] as const) {
      expect(now[field]).toBeGreaterThanOrEqual(counters[field]);
    }
  }
  // Every charge equals what its operation measured; refused work was never charged, so an
  // unprotected operation only ran below its class's limit: the overshoot is one operation.
  for (const entry of object.charges.slice(step.chargesBefore)) {
    expect(entry.dayAfter - entry.usedBefore).toBe(measuredCharge(entry.cost) + entry.folded);
    if (entry.charge !== "protected" && entry.kind !== "erase_author_chunk")
      expect(entry.usedBefore).toBeLessThan(classLimit(entry.charge, step.limits));
  }
  // A replay never returns a body; an operation never applies twice.
  const answer = step.answer as { ok?: boolean; replayed?: unknown; value?: unknown };
  if (answer?.replayed !== undefined) {
    expect(Object.keys(answer.replayed as object).sort()).toEqual(["kind", "result", "target"]);
  }
  if (
    answer?.ok &&
    answer.value !== undefined &&
    step.envelope?.opId !== undefined &&
    step.command.t !== "erase"
  ) {
    const key = step.envelope.opId;
    expect(applied.has(key), "applied twice").toBe(false);
    applied.add(key);
  }
  // Every row accessed is accounted for, by an oracle no charge reads.
  expect(object.accounted()).toBeGreaterThanOrEqual(object.accesses);
  // Author erasure is terminal.
  for (const [author, barrier] of after.barriers) {
    if (barrier.complete) erased.add(author);
  }
  for (const author of erased) {
    expect(authorTraces(object, author)).toEqual({
      documents: 0,
      edits: 0,
      sequences: 0,
      rates: 0,
      operations: 0,
      counts: 0,
      connections: 0,
    });
  }
}

/** In `own` collections a visitor's answers and live messages name only their own documents. */
function checkOwnIsolation(caller: Caller, collectionName: string, answer: unknown) {
  if (caller.kind !== "visitor" || collectionName !== "mine") return;
  const result = answer as { ok: boolean; value?: { documents?: { _by: string }[]; _by?: string } };
  if (!result.ok || result.value === undefined) return;
  const documents =
    result.value.documents ??
    (result.value._by === undefined ? [] : [result.value as { _by: string }]);
  for (const doc of documents) expect(doc._by).toBe(caller.author);
}

function run(commands: Command[]) {
  const object = new MemoryObject();
  let now = NOW;
  let limits = ROOMY;
  const d1 = { owner: "owner_a", generation: 0, epoch: 0, fenced: false };
  const current = () => envelope({ ownerId: d1.owner, generation: d1.generation, epoch: d1.epoch });
  const history: DataEnvelope[] = [current()];
  let ops = 0;
  const opEnvelope = (base: DataEnvelope) => {
    ops += 1;
    return { ...base, opId: `${now}.p${ops.toString().padStart(7, "0")}` };
  };
  const eraseIds = [0, 1, 2, 3].map((index) => `${NOW}.erase00${index}`);
  let transitions = 0;
  let lastTransition: {
    id: string;
    envelope: DataEnvelope;
    fence: Parameters<MemoryObject["fence"]>[1];
  } | null = null;
  const mutations: Mutation[] = [];
  const applied = new Set<string>();
  const erased = new Set<string>();
  const declare = (env: DataEnvelope) => {
    object.declare(opEnvelope(env), OWNER, { name: "mine", mode: "own" }, { now, limits });
    object.declare(
      opEnvelope(env),
      OWNER,
      { name: "board", mode: "append", uniqueKey: "n" },
      { now, limits },
    );
    object.declare(
      opEnvelope(env),
      OWNER,
      { name: "wiki", mode: "shared", indexed: ["n"] },
      { now, limits },
    );
  };
  declare(current());
  const connected = object.connect(current(), visitorId("b"), "grant:b", now + 60_000, {
    now,
    limits,
  });
  const live = connected.ok && "value" in connected ? connected.value : null;
  if (live !== null) object.message(live, JSON.stringify({ subscribe: "mine" }), now);
  const docAt = (index: number) => {
    const docs = [...object.durable.documents.values()];
    return docs.length === 0 ? null : (docs[index % docs.length] as Doc);
  };

  for (const command of commands) {
    const before = {
      control: structuredClone(object.durable.control),
      documents: structuredClone(object.durable.documents),
      days: structuredClone(object.durable.days),
    };
    const chargesBefore = object.charges.length;
    const stepLimits = limits;
    const which = "late" in command ? command.late : "now";
    const base =
      which === "early"
        ? (history[0] as DataEnvelope)
        : which === "former"
          ? { ...current(), ownerId: d1.owner === "owner_a" ? "owner_b" : "owner_a" }
          : current();
    let sent: DataEnvelope | null = null;
    let answer: unknown = null;
    const mutate = (actor: string, perform: Mutation["run"]) => {
      sent = opEnvelope(base);
      const env = sent;
      const mutation = { envelope: env, actor, run: perform };
      mutations.push(mutation);
      answer = perform(object, now, limits);
      void mutation;
    };
    switch (command.t) {
      case "create": {
        const body = { n: command.n, by: command.who.kind };
        mutate(command.who.kind, (o, at, lim) =>
          o.create(mutations.at(-1)?.envelope ?? base, command.who, command.collection, body, {
            now: at,
            limits: lim,
          }),
        );
        checkOwnIsolation(command.who, command.collection, answer);
        break;
      }
      case "replace": {
        const doc = docAt(command.pick);
        if (doc === null) break;
        const body = command.big ? { n: command.n, pad: "x".repeat(200) } : { n: command.n };
        mutate(command.who.kind, (o, at, lim) =>
          o.replace(mutations.at(-1)?.envelope ?? base, command.who, doc.collection, doc.id, body, {
            now: at,
            limits: lim,
          }),
        );
        if (
          command.who.kind === "visitor" &&
          doc.collection === "mine" &&
          doc.author !== command.who.author
        ) {
          expect((answer as { ok: boolean }).ok).toBe(false);
        }
        break;
      }
      case "remove": {
        const doc = docAt(command.pick);
        if (doc === null) break;
        mutate(command.who.kind, (o, at, lim) =>
          o.remove(mutations.at(-1)?.envelope ?? base, command.who, doc.collection, doc.id, {
            now: at,
            limits: lim,
          }),
        );
        if (
          command.who.kind === "visitor" &&
          doc.collection === "mine" &&
          doc.author !== command.who.author
        ) {
          expect((answer as { ok: boolean }).ok).toBe(false);
        }
        break;
      }
      case "bulk": {
        const ids = command.picks
          .map((index) => docAt(index))
          .filter((doc) => doc?.collection === "board")
          .map((doc) => (doc as Doc).id);
        if (ids.length === 0) break;
        mutate("owner", (o, at, lim) =>
          o.bulkRemove(mutations.at(-1)?.envelope ?? base, OWNER, "board", ids, {
            now: at,
            limits: lim,
          }),
        );
        break;
      }
      case "read": {
        sent = base;
        const query = {
          collection: command.collection,
          order: command.desc ? ("-created" as const) : ("created" as const),
          limit: 3,
          ...(command.by === null
            ? {}
            : { equals: { field: "_by", value: visitorId(command.by) } }),
        };
        answer = object.query(base, command.who, query, { now, limits });
        checkOwnIsolation(command.who, command.collection, answer);
        const doc = docAt(command.pick);
        if (doc !== null) {
          const got = object.get(base, command.who, doc.collection, doc.id, { now, limits });
          checkOwnIsolation(command.who, doc.collection, got);
        }
        break;
      }
      case "export": {
        sent = base;
        answer =
          command.mine === null
            ? object.exportPage(base, OWNER, null, 50, { now, limits })
            : object.exportMine(base, visitor(command.mine), null, { now, limits });
        if (command.mine !== null && (answer as { ok: boolean }).ok) {
          for (const row of (answer as { value: { rows: { by: string }[] } }).value.rows) {
            expect(row.by).toBe(visitorId(command.mine));
          }
        }
        break;
      }
      case "fence": {
        if (command.repeat && lastTransition !== null) {
          answer = object.fence(lastTransition.envelope, lastTransition.fence, now);
          expect(
            (answer as { ok: boolean }).ok || (answer as { code: string }).code === "stale",
          ).toBe(true);
          break;
        }
        // A stale fence repeats the epoch of the last fence applied; before any, there is none.
        const stale = command.stale && d1.fenced;
        const epoch = stale ? d1.epoch : d1.epoch + 1;
        transitions += 1;
        const id = `t${transitions}`;
        const fence =
          command.kind === "transfer"
            ? {
                kind: "transfer" as const,
                transition: id,
                toOwner: d1.owner === "owner_a" ? "owner_b" : "owner_a",
              }
            : { kind: command.kind as "hold" | "release" | "epoch", transition: id };
        sent = { ...current(), epoch };
        answer = object.fence(sent, fence, now);
        if ((answer as { ok: boolean }).ok) {
          if (stale) expect.fail("a fence at an epoch already used was applied");
          d1.epoch = epoch;
          d1.fenced = true;
          if (fence.kind === "transfer") d1.owner = fence.toOwner;
          lastTransition = { id, envelope: sent, fence };
        }
        break;
      }
      case "erase": {
        const id = eraseIds[command.id] as string;
        sent = base;
        const step =
          command.step === "prepare"
            ? object.prepareErase
            : command.step === "commit"
              ? object.commitErase
              : object.cancelErase;
        answer = step.call(object, base, id, now);
        if ((answer as { ok: boolean }).ok && object.durable.control !== null)
          d1.generation = object.durable.control.generation;
        break;
      }
      case "author": {
        mutate("system", (o, at, lim) =>
          o.eraseAuthorChunk(
            mutations.at(-1)?.envelope ?? base,
            visitorId(command.author),
            command.take,
            { now: at, limits: lim },
          ),
        );
        break;
      }
      case "plan":
        limits = command.tight ? TIGHT : ROOMY;
        break;
      case "retry": {
        const previous = mutations[command.pick % Math.max(mutations.length, 1)];
        if (previous === undefined) break;
        sent = previous.envelope;
        const replays = mutations.length;
        mutations.push(previous);
        answer = previous.run(object, now, limits);
        mutations.length = replays;
        break;
      }
      case "clock":
        now += command.ms;
        break;
      case "alarm":
        object.alarm(now);
        break;
      case "evict":
        object.evict();
        break;
      case "quarantine": {
        sent = current();
        object.quarantine(current(), "owner", now);
        if (command.resolve !== "none")
          answer = object.resolveQuarantine(current(), command.resolve, now);
        if (object.durable.control !== null) d1.generation = object.durable.control.generation;
        break;
      }
      case "settle": {
        const previous = mutations[command.pick % Math.max(mutations.length, 1)];
        if (previous === undefined || previous.envelope.opId === undefined) break;
        const actor = previous.actor === "visitor" ? visitorId("a") : "owner:owner";
        object.settle(previous.envelope, actor, previous.envelope.opId, now);
        break;
      }
    }
    if (object.durable.control !== null && object.durable.control.generation !== d1.generation) {
      d1.generation = object.durable.control.generation;
    }
    if (history.length < 6) history.push(current());
    const tag = `${command.t}:${(answer as { ok?: boolean; replayed?: unknown; code?: string } | null)?.replayed ? "replay" : (answer as { ok?: boolean } | null)?.ok === true ? "ok" : ((answer as { code?: string } | null)?.code ?? "none")}`;
    STATS.set(tag, (STATS.get(tag) ?? 0) + 1);
    checkStep(
      before,
      object,
      { command, envelope: sent, answer, chargesBefore, limits: stepLimits },
      applied,
      erased,
    );
    // The live listener in the own collection only ever hears its own documents.
    if (live !== null) {
      for (const message of object.sockets.get(live)?.received ?? []) {
        const parsed = JSON.parse(message) as { by?: string; collection?: string };
        if (parsed.collection === "mine") expect(parsed.by).toBe(visitorId("b"));
      }
    }
  }
}

/** How often each command answered each way, so a generator that stops reaching a path fails. */
const STATS = new Map<string, number>();
describe("properties over random sequences", () => {
  afterAll(() => {
    for (const tag of [
      "create:ok",
      "replace:ok",
      "remove:ok",
      "bulk:ok",
      "retry:replay",
      "erase:ok",
      "author:ok",
      "fence:ok",
      "fence:stale",
      "quarantine:ok",
      "create:held",
      "create:stale",
      "read:ok",
      "export:ok",
    ]) {
      expect(STATS.get(tag) ?? 0, tag).toBeGreaterThan(0);
    }
  });
  it("keep every stated invariant of fences, holds, erases, replay, isolation, counters and erasure", () => {
    fc.assert(
      fc.property(fc.array(command, { minLength: 20, maxLength: 80 }), (commands) => {
        run(commands);
      }),
      { numRuns: 200 },
    );
  });

  it("keep them with the operation horizon crossed: an ID never applies twice across pruning", () => {
    const longRuns = fc.array(
      fc.oneof(
        command,
        fc.record({
          t: fc.constant("clock" as const),
          ms: fc.constant(ARTIFACT_DATA.replayMs + 1),
        }),
        fc.record({ t: fc.constant("alarm" as const) }),
      ),
      { minLength: 20, maxLength: 80 },
    );
    fc.assert(
      fc.property(longRuns, (commands) => run(commands)),
      { numRuns: 60 },
    );
  });
});
