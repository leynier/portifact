// The rules of the lifecycle jobs (decision 0026, delivery 4, second half): the inventory's keys
// and retention, the limits lifecycle commands carry, the envelopes trusted paths build, and what
// a job does after the object refused it. Each test names the mutation it kills.
import {
  ARTIFACT_DATA,
  ArtifactDataLimits,
  type DataControl,
  type DataEnvelope,
  DataEnvelope as EnvelopeSchema,
} from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import { applyFence, newControl } from "./control.ts";
import {
  controlEnvelope,
  erasureRefused,
  fenceRefused,
  INVENTORY_PREFIX,
  inventoryArtifact,
  inventoryEntry,
  inventoryKey,
  inventoryPrunable,
  inventoryRetired,
  JOURNAL_PREFIX,
  journalPrefixOf,
  journalSubject,
  LIFECYCLE_LIMITS,
  purgeEraseEpoch,
  rowEnvelope,
} from "./lifecycle-jobs.ts";

const NOW = Date.UTC(2026, 10, 12);
const base: DataEnvelope = {
  artifactId: "abcdefghij",
  region: "default",
  ownerId: "u_owner",
  generation: 0,
  epoch: 0,
};

function fenced(control: DataControl, epoch: number, transition: string): DataControl {
  const applied = applyFence(control, { ...base, epoch }, { kind: "hold", transition }, NOW);
  if (!applied.ok) throw new Error(applied.message);
  return applied.value.control;
}

describe("the inventory and the journal's keys", () => {
  it("names an object by its artifact, and reads only its own keys back", () => {
    expect(INVENTORY_PREFIX).toBe("system/data-objects/");
    expect(JOURNAL_PREFIX).toBe("system/data-authors/");
    expect(inventoryKey("abcdefghij")).toBe("system/data-objects/abcdefghij");
    // Killed mutation: dropping the prefix check (a key of the same length elsewhere).
    expect(inventoryArtifact(`${"x".repeat(INVENTORY_PREFIX.length)}abcdefghij`)).toBeNull();
    expect(journalSubject(`${"x".repeat(JOURNAL_PREFIX.length)}u_1/abcdefghij`)).toBeNull();
    expect(inventoryArtifact(inventoryKey("abcdefghij"))).toBe("abcdefghij");
    // Killed mutations: dropping the prefix check, the empty check, or the nested-key check.
    expect(inventoryArtifact("system/data-authors/u/abcdefghij")).toBeNull();
    expect(inventoryArtifact(INVENTORY_PREFIX)).toBeNull();
    expect(inventoryArtifact(`${INVENTORY_PREFIX}a/b`)).toBeNull();
  });

  it("names a journal entry by account and artifact, and lists one account's entries", () => {
    expect(journalPrefixOf("u_1")).toBe(`${JOURNAL_PREFIX}u_1/`);
    expect(journalSubject(`${JOURNAL_PREFIX}u_1/abcdefghij`)).toEqual({
      userId: "u_1",
      artifactId: "abcdefghij",
    });
    expect(journalSubject(`${JOURNAL_PREFIX}u_1`)).toBeNull();
    expect(journalSubject(`${JOURNAL_PREFIX}/abcdefghij`)).toBeNull();
    expect(journalSubject(`${JOURNAL_PREFIX}u_1/`)).toBeNull();
    expect(journalSubject(`${JOURNAL_PREFIX}u_1/a/b`)).toBeNull();
    expect(journalSubject(inventoryKey("abcdefghij"))).toBeNull();
  });
});

describe("the inventory's retention", () => {
  it("retires an entry once, keeping the first retirement", () => {
    const entry = inventoryEntry("abcdefghij", "eu", NOW);
    expect(entry).toEqual({ artifactId: "abcdefghij", region: "eu", createdAt: NOW });
    const retired = inventoryRetired(entry, NOW + 5);
    expect(retired.retiredAt).toBe(NOW + 5);
    // Killed mutation: overwriting the first retirement moves the pruning date.
    expect(inventoryRetired(retired, NOW + 9).retiredAt).toBe(NOW + 5);
  });

  it("prunes only a retired entry, and only after a restore can no longer need it", () => {
    const entry = inventoryEntry("abcdefghij", "default", NOW);
    expect(inventoryPrunable(entry, NOW + 365 * 86_400_000)).toBe(false);
    const retired = inventoryRetired(entry, NOW);
    expect(ARTIFACT_DATA.inventoryRetiredMs).toBeGreaterThan(30 * 86_400_000);
    // Killed mutations: `>` for `>=`, and a shorter retention.
    expect(inventoryPrunable(retired, NOW + ARTIFACT_DATA.inventoryRetiredMs - 1)).toBe(false);
    expect(inventoryPrunable(retired, NOW + ARTIFACT_DATA.inventoryRetiredMs)).toBe(true);
  });
});

describe("what lifecycle commands carry", () => {
  it("carries limits the object accepts, and no live allowance", () => {
    expect(ArtifactDataLimits.parse(LIFECYCLE_LIMITS)).toEqual(LIFECYCLE_LIMITS);
    expect(LIFECYCLE_LIMITS.liveMessagesPerDay).toBe(0);
    expect(LIFECYCLE_LIMITS.connectionsPerArtifact).toBe(0);
  });

  it("builds envelopes with neither an operation ID nor an erase reason", () => {
    const row = {
      artifactId: "abcdefghij",
      region: "eu",
      ownerId: "ws_1",
      generation: 2,
      epoch: 3,
    };
    expect(rowEnvelope(row)).toEqual(row);
    expect(EnvelopeSchema.parse(rowEnvelope(row))).toEqual(row);
    const control = { ...newControl(base, NOW), generation: 4, epoch: 7, ownerId: "u_new" };
    expect(controlEnvelope(control)).toEqual({
      ...base,
      ownerId: "u_new",
      generation: 4,
      epoch: 7,
    });
  });

  it("sends a purge's erase at the object's epoch when it is newer, never older", () => {
    const control = { ...newControl(base, NOW), epoch: 5 };
    expect(purgeEraseEpoch(3, control)).toBe(5);
    expect(purgeEraseEpoch(8, control)).toBe(8);
    expect(purgeEraseEpoch(3, null)).toBe(3);
  });
});

describe("after the object refused a fence", () => {
  it("is done once the object is past it", () => {
    const control = fenced(newControl(base, NOW), 4, "hold_a");
    // Killed mutation: `>` for `>=` on the last transition's epoch.
    expect(fenceRefused(control, { ...base, epoch: 4 }, "stale")).toBe("done");
    expect(fenceRefused(control, { ...base, epoch: 2 }, "stale")).toBe("done");
  });

  it("retries while an earlier change has to land first", () => {
    const control = newControl(base, NOW);
    expect(fenceRefused(control, { ...base, epoch: 3 }, "stale")).toBe("retry");
    expect(fenceRefused(control, { ...base, epoch: 3 }, "held")).toBe("retry");
  });

  it("is done for what can never apply", () => {
    // At an epoch the object is not past, so only the code can end it.
    const control = newControl(base, NOW);
    const ahead = { ...base, epoch: 5 };
    expect(fenceRefused(control, ahead, "conflict")).toBe("done");
    expect(fenceRefused(control, ahead, "forbidden")).toBe("done");
    expect(fenceRefused(control, ahead, "invalid_input")).toBe("done");
  });
});

describe("after the object refused an erasure", () => {
  it("waits for a hold or a quarantine, retries a stale envelope, ends anything else", () => {
    expect(erasureRefused("held")).toBe("wait");
    expect(erasureRefused("quarantined")).toBe("wait");
    expect(erasureRefused("stale")).toBe("retry");
    expect(erasureRefused("conflict")).toBe("retry");
    expect(erasureRefused("forbidden")).toBe("done");
    expect(erasureRefused("invalid_input")).toBe("done");
  });
});
