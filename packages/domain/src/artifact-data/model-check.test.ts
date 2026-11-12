// A model check of decision 0026's lifecycle and replay protocols on small state spaces: every
// delivery order of a few jobs' messages (as queues and retries can reorder them) is run through
// the in-memory object, and each answer and the final state are compared with a reference model
// written separately from the production rules, as plainly as the record states them.
import type { DataEnvelope } from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import {
  context,
  envelope,
  NOW,
  OWNER,
  opId,
  visitor,
  visitorId,
} from "../testing/artifact-data-fixtures.ts";
import { MemoryObject } from "../testing/artifact-data-object.ts";

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

const ctx = context();

/** The record's lifecycle rules for erase intents, fences and writes, stated directly. */
class ReferenceLifecycle {
  generation = 0;
  epoch = 0;
  held = false;
  erasing: string | null = null;
  target = 0;
  ended = new Map<string, string>();
  documents = 0;
  lastTransition: string | null = null;

  fence(kind: "hold" | "release", epoch: number, id: string): string {
    if (id === this.lastTransition) return "ok";
    if (epoch <= this.epoch) return "stale";
    this.epoch = epoch;
    this.lastTransition = id;
    if (kind === "hold") {
      this.held = true;
      if (this.erasing !== null) this.ended.set(this.erasing, "cancelled");
      this.erasing = null;
    } else {
      this.held = false;
    }
    return "ok";
  }

  #common(id: string, generation: number, epoch: number): string | null {
    const ended = this.ended.get(id);
    if (ended !== undefined) return ended;
    if (epoch < this.epoch) return "stale";
    if (generation < this.generation) return "superseded";
    if (generation > this.generation) return "stale";
    if (this.held) return "held";
    return null;
  }

  prepare(id: string, generation: number, epoch: number): string {
    const early = this.#common(id, generation, epoch);
    if (early !== null) return early;
    if (this.erasing !== null) {
      if (this.erasing !== id) return "conflict";
      return epoch < this.target ? "stale" : "prepared";
    }
    this.erasing = id;
    this.target = epoch;
    return "prepared";
  }

  commit(id: string, generation: number, epoch: number): string {
    const early = this.#common(id, generation, epoch);
    if (early !== null) return early;
    if (this.erasing !== id) return "conflict";
    if (epoch < this.target) return "stale";
    this.erasing = null;
    this.ended.set(id, "committed");
    this.generation += 1;
    this.documents = 0;
    return "committed";
  }

  write(generation: number, epoch: number): string {
    if (epoch < this.epoch || generation !== this.generation) return "stale";
    if (this.held) return "held";
    if (this.erasing !== null) return "stale";
    this.documents += 1;
    return "ok";
  }
}

type LifecycleEvent =
  | { kind: "prepare" | "commit"; id: string; generation: number; epoch: number }
  | { kind: "hold" | "release"; epoch: number; id: string }
  | { kind: "write"; generation: number; epoch: number };

function outcome(answer: { ok: boolean; code?: string; value?: unknown }): string {
  if (!answer.ok) return answer.code as string;
  const value = answer.value as { outcome?: string } | undefined;
  return value?.outcome ?? "ok";
}

describe("model check: erase intents, holds and writes in every delivery order", () => {
  it("matches the reference model for every order of two erase jobs, a hold, its release and two writes", () => {
    const [a, b] = [opId(), opId()];
    const events: LifecycleEvent[] = [
      { kind: "prepare", id: a, generation: 0, epoch: 0 },
      { kind: "commit", id: a, generation: 0, epoch: 0 },
      { kind: "hold", epoch: 1, id: "t_hold" },
      { kind: "release", epoch: 2, id: "t_release" },
      { kind: "prepare", id: b, generation: 0, epoch: 2 },
      // Sent with an envelope read before the release: older than B's target once B is prepared.
      { kind: "commit", id: b, generation: 0, epoch: 1 },
      { kind: "write", generation: 0, epoch: 0 },
    ];
    let orders = 0;
    for (const order of permutations(events)) {
      orders += 1;
      const object = new MemoryObject();
      const base = envelope();
      object.declare({ ...base, opId: opId() }, OWNER, { name: "items", mode: "append" }, ctx);
      const reference = new ReferenceLifecycle();
      let commits = 0;
      for (const event of order) {
        const env: DataEnvelope = envelope({
          epoch: event.epoch,
          generation:
            "generation" in event ? event.generation : (object.durable.control?.generation ?? 0),
        });
        let actual: string;
        let expected: string;
        switch (event.kind) {
          case "prepare":
            actual = outcome(object.prepareErase(env, event.id, NOW));
            expected = reference.prepare(event.id, event.generation, event.epoch);
            break;
          case "commit": {
            const held = object.durable.control?.hold !== null;
            actual = outcome(object.commitErase(env, event.id, NOW));
            expected = reference.commit(event.id, event.generation, event.epoch);
            if (actual === "committed" && expected === "committed") {
              commits += 1;
              expect(held).toBe(false);
            }
            break;
          }
          case "hold":
          case "release":
            actual = outcome(object.fence(env, { kind: event.kind, transition: event.id }, NOW));
            expected = reference.fence(event.kind, event.epoch, event.id);
            break;
          case "write":
            actual = outcome(
              object.create({ ...env, opId: opId() }, visitor("w"), "items", { n: 1 }, ctx),
            );
            expected = reference.write(event.generation, event.epoch);
            if (expected === "stale" && reference.generation > 0) expected = "stale";
            break;
        }
        expect(actual, `${order.map((e) => e.kind).join(",")} at ${event.kind}`).toBe(expected);
      }
      // Both intents target generation 0: at most one of them ever deletes anything.
      expect(commits).toBeLessThanOrEqual(1);
      expect(object.durable.control?.generation).toBe(reference.generation);
      expect(object.durable.control?.hold !== null).toBe(reference.held);
      expect(object.durable.control?.erasing?.id ?? null).toBe(reference.erasing);
      expect(object.durable.documents.size).toBe(reference.documents);
    }
    expect(orders).toBe(5040);
  });

  it("applies one operation once for every order of two deliveries, a settlement, a transfer and a retry after it", () => {
    const events = ["create", "duplicate", "settle", "transfer", "late"] as const;
    for (const order of permutations(events)) {
      const object = new MemoryObject();
      const base = envelope();
      object.declare({ ...base, opId: opId() }, OWNER, { name: "items", mode: "append" }, ctx);
      const id = opId();
      const sent = { ...base, opId: id };
      // Reference: the first of a delivery and the settlement decides; a transfer refuses every
      // later delivery of the former owner's envelope; nothing applies twice.
      let decided: "applied" | "aborted" | null = null;
      let moved = false;
      for (const event of order) {
        if (event === "transfer") {
          expect(
            object.fence(
              { ...base, epoch: 1 },
              { kind: "transfer", toOwner: "owner_b", transition: "t" },
              NOW,
            ).ok,
          ).toBe(true);
          moved = true;
          continue;
        }
        if (event === "settle") {
          const settled = object.settle(base, visitorId("x"), id, NOW);
          if (decided === null) decided = "aborted";
          expect(settled.state).toBe(decided === "applied" ? "committed" : "aborted");
          continue;
        }
        const answer = object.create(sent, visitor("x"), "items", { n: 1 }, ctx);
        if (moved) {
          expect(answer).toMatchObject({ ok: false, code: "stale" });
        } else if (decided === null) {
          expect(answer).toMatchObject({ ok: true, value: {} });
          decided = "applied";
        } else if (decided === "applied") {
          expect(answer).toMatchObject({ ok: true, replayed: {} });
        } else {
          expect(answer).toMatchObject({ ok: false, code: "conflict" });
        }
      }
      expect(object.durable.documents.size).toBe(decided === "applied" ? 1 : 0);
    }
  });

  it("keeps author erasure terminal for every order of writes, chunks and another author's write", () => {
    const events = ["write1", "write2", "chunk1", "chunk2", "chunk3", "other"] as const;
    for (const order of permutations(events)) {
      const object = new MemoryObject();
      const base = envelope();
      object.declare({ ...base, opId: opId() }, OWNER, { name: "items", mode: "own" }, ctx);
      // Reference: the first chunk bars the author; each chunk deletes one of their documents;
      // writes after the barrier are refused; the other author is untouched.
      let barred = false;
      let theirs = 0;
      let complete = false;
      for (const event of order) {
        if (event === "other") {
          expect(
            object.create({ ...base, opId: opId() }, visitor("other"), "items", { n: 1 }, ctx).ok,
          ).toBe(true);
        } else if (event.startsWith("write")) {
          const answer = object.create(
            { ...base, opId: opId() },
            visitor("gone"),
            "items",
            { n: 1 },
            ctx,
          );
          expect(answer.ok).toBe(!barred);
          if (!barred) theirs += 1;
        } else {
          barred = true;
          const answer = object.eraseAuthorChunk(
            { ...base, opId: opId() },
            visitorId("gone"),
            1,
            ctx,
          );
          const result = (answer as { value: { documents: number; more: boolean } }).value;
          expect(result.documents).toBe(theirs > 0 ? 1 : 0);
          theirs = Math.max(0, theirs - 1);
          if (!result.more) complete = true;
        }
      }
      const left = [...object.durable.documents.values()];
      expect(left.filter((doc) => doc.author === visitorId("gone"))).toHaveLength(theirs);
      expect(left.filter((doc) => doc.author === visitorId("other"))).toHaveLength(1);
      expect(object.durable.barriers.get(visitorId("gone"))?.complete ?? false).toBe(complete);
      if (complete) expect(theirs).toBe(0);
    }
  });

  it("never lets a first request consume the epoch of a fence D1 ordered before it, in any order", () => {
    // D1 raised the epoch to 1 and wrote a hold job; a declaration and a write read epoch 1.
    const events = ["declare", "hold", "write"] as const;
    for (const order of permutations(events)) {
      const object = new MemoryObject();
      const at = envelope({ epoch: 1 });
      let held = false;
      let declared = false;
      for (const event of order) {
        if (event === "hold") {
          expect(object.fence(at, { kind: "hold", transition: "h" }, NOW).ok).toBe(true);
          held = true;
        } else if (event === "declare") {
          const answer = object.declare(
            { ...at, opId: opId() },
            OWNER,
            { name: "items", mode: "append" },
            ctx,
          );
          expect(answer.ok).toBe(!held);
          declared = declared || answer.ok;
        } else {
          const answer = object.create(
            { ...at, opId: opId() },
            visitor("w"),
            "items",
            { n: 1 },
            ctx,
          );
          expect(answer.ok).toBe(declared && !held);
        }
      }
      expect(object.durable.control?.hold).not.toBeNull();
    }
  });
});
