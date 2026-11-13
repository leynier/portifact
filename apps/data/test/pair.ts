// The reference and the real object side by side: every command goes to both, with the same IDs,
// and their answers and states must agree after every step, so a divergence between the in-memory
// reference and the Durable Object on SQLite fails where it happens. Measured costs, file sizes and
// usage counts differ by design (the reference counts each access as one row; SQLite measures its
// cursors) and are compared only where they are the same fact: live messages reserved and erase
// intents started. Refusals counted are not: those still pending when an eviction comes are lost,
// and whether they were flushed first follows the measured rows.
import {
  type DataObject,
  type Durable,
  MemoryObject,
  type ObjectView,
} from "@portifact/domain/testing/artifact-data";
import { expect } from "vitest";
import { RealObject } from "./driver.ts";

/** JSON with object keys sorted: where a key was added is not a fact either side states. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/** Equal, or a failure naming each part that differs with both sides, compactly. */
function same(real: unknown, reference: unknown, label: string): void {
  if (canonical(real) === canonical(reference)) return;
  const parts =
    real !== null && typeof real === "object" && reference !== null && typeof reference === "object"
      ? Object.keys(reference as object).filter(
          (key) =>
            canonical((real as Record<string, unknown>)[key]) !==
            canonical((reference as Record<string, unknown>)[key]),
        )
      : ["value"];
  const detail = parts
    .map(
      (key) =>
        `${key}: real ${JSON.stringify((real as Record<string, unknown>)?.[key] ?? real)} reference ${JSON.stringify((reference as Record<string, unknown>)?.[key] ?? reference)}`,
    )
    .join("; ");
  expect.fail(`${label} differs: ${detail}`);
}

/**
 * What two answers must share: outcome, code, value or replay, and the generation. `describe`
 * answers today's usage, which is measured work and differs by design: its day is compared, its
 * counts are not (each object's accounting is checked by its own tests). The command decides
 * that, never the answer's shape: a document may hold a field named `today`.
 */
function answerShape(answer: unknown, command: string): unknown {
  if (answer === null || typeof answer !== "object" || !("ok" in answer)) return answer;
  const {
    cost: _cost,
    storage,
    ...rest
  } = answer as unknown as {
    cost: unknown;
    storage: { generation: number; seq: number };
    value?: unknown;
  };
  const shared = { ...rest, storage: { generation: storage.generation } };
  if (command !== "describe" || rest.value === null || typeof rest.value !== "object") {
    return shared;
  }
  const described = rest.value as { today: { day: number } };
  return { ...shared, value: { ...described, today: { day: described.today.day } } };
}

/** What two states must share: everything but the measured usage itself. */
function stateShape(view: ObjectView): unknown {
  const d: Durable = view.durable;
  const sorted = <K, V>(map: Map<K, V>) =>
    [...map.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  const days = [...d.days.values()];
  // The storage sequence also moves when pending usage is flushed into a day row, and when that
  // happens follows the measured rows (`readFlush`), which differ by design; the property tests
  // check its own rules (it never goes back, and moves with every durable write) on each object.
  const control = d.control === null ? null : { ...d.control, storageSeq: 0 };
  return {
    control,
    collections: sorted(d.collections),
    fields: d.fields,
    documents: sorted(d.documents),
    authorCounts: sorted(d.authorCounts),
    valueCounts: sorted(d.valueCounts),
    seq: sorted(d.seq),
    ops: sorted(d.ops),
    audit: sorted(d.audit),
    barriers: sorted(d.barriers),
    rates: sorted(d.rates),
    ended: sorted(d.ended),
    rights: [...d.rights.keys()].sort(),
    // Which days hold a row also follows flush timing; what was reserved and started does not.
    live: days.reduce((sum, day) => sum + day.live, 0),
    intents: days.map((day) => [day.day, day.intents]).filter(([, intents]) => (intents ?? 0) > 0),
  };
}

/**
 * Connections: every socket the real object holds, the reference holds alike; a socket only the
 * reference still lists must be closed (an evicted object forgets the sockets it closed).
 */
function compareSockets(real: ObjectView, reference: ObjectView, label: string): void {
  for (const [id, socket] of real.sockets) {
    expect(socket, `${label} socket ${id}`).toEqual(reference.sockets.get(id));
  }
  for (const [id, socket] of reference.sockets) {
    if (!real.sockets.has(id)) expect(socket.closed, `${label} socket ${id}`).not.toBeNull();
  }
}

const COMMANDS = [
  "declare",
  "indexStep",
  "create",
  "replace",
  "remove",
  "bulkCreate",
  "bulkReplace",
  "bulkRemove",
  "eraseAuthorChunk",
  "createMany",
  "get",
  "getMany",
  "query",
  "count",
  "describe",
  "exportPage",
  "exportMine",
  "fence",
  "quarantine",
  "resolveQuarantine",
  "prepareErase",
  "commitErase",
  "cancelErase",
  "settle",
  "acknowledge",
  "alarm",
  "flushReads",
  "connect",
  "renew",
  "message",
  "evict",
] as const;

/**
 * A pair answering as the real object (its view, its meters), after checking that the reference
 * answered the same and holds the same state.
 */
export function pairObject(name = "obj"): DataObject {
  const reference = new MemoryObject(name);
  const real = new RealObject(name);
  let steps = 0;
  const compare = async (command: string, mine: unknown, theirs: unknown) => {
    steps += 1;
    // An alarm's count includes day rows, which exist or not by flush timing; the retained rows
    // themselves are compared in the state below.
    if (command !== "alarm") {
      same(
        answerShape(theirs, command),
        answerShape(mine, command),
        `${command} answer, step ${steps}`,
      );
    }
    const theirView = await real.view();
    const label = `${command} state, step ${steps}`;
    same(stateShape(theirView), stateShape(reference.view()), label);
    compareSockets(theirView, reference.view(), label);
  };
  const pair = {
    kind: "real" as const,
    view: () => real.view(),
    async setFaults(faults: Parameters<DataObject["setFaults"]>[0]) {
      reference.setFaults(faults);
      await real.setFaults(faults);
    },
    async setRowBounds(bounds: Parameters<DataObject["setRowBounds"]>[0]) {
      reference.setRowBounds(bounds);
      await real.setRowBounds(bounds);
    },
    async seed(rows: Parameters<DataObject["seed"]>[0]) {
      reference.seed(rows);
      await real.seed(rows);
    },
  } as Record<string, unknown>;
  for (const command of COMMANDS) {
    pair[command] = async (...args: unknown[]) => {
      const call = (target: object) =>
        (target as Record<string, (...a: unknown[]) => unknown>)[command]?.(...args);
      const mine = call(reference);
      const theirs = await call(real);
      await compare(command, mine, theirs);
      return theirs;
    };
  }
  return pair as unknown as DataObject;
}

export const pairObjects = async (name?: string) => pairObject(name);
