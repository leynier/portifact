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
import { applyFence, newControl, quarantine, resolveReviewed, reviewedState } from "./control.ts";
import {
  awaitedTransferWindow,
  controlEnvelope,
  erasureRefused,
  fenceObsolete,
  fenceRefused,
  formatReviewed,
  holdCorrective,
  INVENTORY_PREFIX,
  identityDisagreement,
  inventoryArtifact,
  inventoryEntry,
  inventoryKey,
  inventoryPrunable,
  inventoryRetired,
  JOURNAL_PREFIX,
  journalPrefixOf,
  journalSubject,
  LIFECYCLE_LIMITS,
  nextJournalScan,
  parseReviewed,
  purgeAnswered,
  purgeEraseEpoch,
  purgeEraseTarget,
  rowEnvelope,
} from "./lifecycle-jobs.ts";

const NOW = Date.UTC(2026, 10, 12);
const ROW_KEPT = { dataRowGone: false, ownerAwaited: false };
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
    expect(fenceRefused(control, { ...base, epoch: 4 }, "stale", ROW_KEPT)).toBe("done");
    expect(fenceRefused(control, { ...base, epoch: 2 }, "stale", ROW_KEPT)).toBe("done");
  });

  it("retries while an earlier change has to land first", () => {
    const control = newControl(base, NOW);
    expect(fenceRefused(control, { ...base, epoch: 3 }, "stale", ROW_KEPT)).toBe("retry");
    expect(fenceRefused(control, { ...base, epoch: 3 }, "held", ROW_KEPT)).toBe("retry");
  });

  it("is done for what can never apply", () => {
    // At an epoch the object is not past, so only the code can end it.
    const control = newControl(base, NOW);
    const ahead = { ...base, epoch: 5 };
    expect(fenceRefused(control, ahead, "conflict", ROW_KEPT)).toBe("done");
    expect(fenceRefused(control, ahead, "forbidden", ROW_KEPT)).toBe("done");
    expect(fenceRefused(control, ahead, "invalid_input", ROW_KEPT)).toBe("done");
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

describe("a fence of a generation the object has left", () => {
  it("ends once D1 no longer has the data row, and waits for D1 while it does", () => {
    const control = { ...newControl(base, NOW), generation: 1 };
    const old = { ...base, generation: 0, epoch: 3 };
    // Killed mutations: dropping the generation comparison, or the row evidence.
    expect(fenceRefused(control, old, "stale", { dataRowGone: true, ownerAwaited: false })).toBe(
      "done",
    );
    expect(fenceRefused(control, old, "stale", { dataRowGone: false, ownerAwaited: false })).toBe(
      "retry",
    );
    expect(
      fenceRefused(control, { ...old, generation: 1 }, "stale", {
        dataRowGone: true,
        ownerAwaited: false,
      }),
    ).toBe("retry");
  });
});

describe("a purge's target and answer", () => {
  const job = { generation: 0, epoch: 2 };

  it("erases the object's own generation only with D1's proof of permanent deletion", () => {
    const control = { ...newControl(base, NOW), generation: 3, epoch: 4 };
    expect(purgeEraseTarget(job, control, { permanentlyDeleted: true })).toEqual({
      generation: 3,
      epoch: 4,
    });
    expect(purgeEraseTarget(job, control, { permanentlyDeleted: false })).toEqual({
      generation: 0,
      epoch: 4,
    });
    expect(purgeEraseTarget(job, null, { permanentlyDeleted: true })).toEqual(job);
  });

  it("retires only on this erase's commit; superseded keeps the obligation", () => {
    expect(purgeAnswered("committed")).toBe("retire");
    expect(purgeAnswered("superseded")).toBe("superseded");
    // A cancelled intent is terminal for its ID.
    expect(purgeAnswered("cancelled")).toBe("fresh");
    expect(purgeAnswered("prepared")).toBe("retry");
  });
});

describe("the artifact and region authority", () => {
  const control = newControl(base, NOW);
  const entry = inventoryEntry("abcdefghij", "default", NOW);
  const agree = {
    key: inventoryKey("abcdefghij"),
    entry,
    region: "default",
    directoryRegion: "default",
    control,
  };

  it("agrees only when the key, the entry, the directory and the control record agree", () => {
    expect(identityDisagreement(agree)).toBeNull();
    expect(identityDisagreement({ ...agree, directoryRegion: null })).toBeNull();
    expect(identityDisagreement({ ...agree, key: inventoryKey("bcdefghijk") })).toBe("key");
    expect(identityDisagreement({ ...agree, entry: { ...entry, region: "eu" } })).toBe(
      "inventory_region",
    );
    expect(identityDisagreement({ ...agree, directoryRegion: "eu" })).toBe("directory_region");
    expect(identityDisagreement({ ...agree, control: { ...control, region: "eu" } })).toBe(
      "control",
    );
    expect(
      identityDisagreement({ ...agree, control: { ...control, artifactId: "bcdefghijk" } }),
    ).toBe("control");
  });
});

describe("the reviewed state's printed form", () => {
  it("round-trips, and refuses anything else", () => {
    const state = {
      artifactId: "abcdefghij",
      region: "eu",
      incarnation: 2,
      reason: "hold",
      ownerId: "ws_1",
      generation: 2,
      epoch: 3,
    } as const;
    const text = "abcdefghij:eu:2:hold:ws_1:2:3";
    expect(formatReviewed(state)).toBe(text);
    expect(parseReviewed(text)).toEqual(state);
    expect(parseReviewed("abcdefghij:eu:12:hold:ws_1:345:6789")).toEqual({
      ...state,
      incarnation: 12,
      generation: 345,
      epoch: 6789,
    });
    expect(parseReviewed(`abcdefghij:eu:${"1".repeat(17)}:hold:ws_1:2:3`)).toBeNull();
    expect(parseReviewed("abcdefghij:eu:2:hold:ws_1:2")).toBeNull();
    expect(parseReviewed(`${text}:4`)).toBeNull();
    expect(parseReviewed("abcdefghij:eu:2:bored:ws_1:2:3")).toBeNull();
    expect(parseReviewed("abcdefghij:eu:2:hold:ws_1:2:x")).toBeNull();
    expect(parseReviewed("abcdefghij:eu:1e3:hold:ws_1:2:3")).toBeNull();
    expect(parseReviewed("abcdefghij:eu:2:hold::2:3")).toBeNull();
    expect(parseReviewed("ABCDEFGHIJ:eu:2:hold:ws_1:2:3")).toBeNull();
    expect(parseReviewed("abcdefghij:EU:2:hold:ws_1:2:3")).toBeNull();
  });
});

describe("an account's journal scan", () => {
  const fresh = { after: null, passStartedAt: NOW, sawLive: false };

  it("walks on from the last key while the listing goes on", () => {
    expect(nextJournalScan(fresh, { lastKey: "k9", truncated: true, live: 0 }, NOW + 1)).toEqual({
      scan: { after: "k9", passStartedAt: NOW, sawLive: false },
      complete: false,
    });
    // Killed mutation: a truncated page with no key cannot continue, so the pass ends.
    expect(nextJournalScan(fresh, { lastKey: null, truncated: true, live: 0 }, NOW).complete).toBe(
      true,
    );
  });

  it("completes only after a whole pass that found nothing to retire", () => {
    const end = { lastKey: "k1", truncated: false, live: 0 };
    expect(nextJournalScan(fresh, end, NOW + 1)).toEqual({ scan: null, complete: true });
    // A pass that retired something is followed by another from the start.
    expect(nextJournalScan(fresh, { ...end, live: 1 }, NOW + 1)).toEqual({
      scan: { after: null, passStartedAt: NOW + 1, sawLive: false },
      complete: false,
    });
    expect(nextJournalScan({ ...fresh, sawLive: true }, end, NOW + 1).complete).toBe(false);
    expect(
      nextJournalScan(fresh, { lastKey: "k9", truncated: true, live: 2 }, NOW + 1).scan?.sawLive,
    ).toBe(true);
  });
});

describe("a reviewed resolution of a quarantine", () => {
  function quarantined(control = newControl(base, NOW), reason: "owner" | "hold" = "hold") {
    const decided = quarantine(control, base, reason, NOW + 5);
    if (!decided.ok) throw new Error(decided.message);
    return decided.value.control;
  }
  const request = (
    control: DataControl,
    decision: "adopt" | "erase",
    hold: { transition: string } | null = null,
  ) => {
    const expected = reviewedState(control);
    if (expected === null) throw new Error("not quarantined");
    return { id: `${NOW}.resolution1`, decision, expected, hold };
  };

  it("reads the reviewed state from the quarantine and the identity numbers", () => {
    const stored = { ...quarantined(), generation: 2, epoch: 3, ownerId: "ws_1" };
    expect(reviewedState(stored)).toEqual({
      artifactId: base.artifactId,
      region: base.region,
      incarnation: 1,
      reason: "hold",
      ownerId: "ws_1",
      generation: 2,
      epoch: 3,
    });
    expect(reviewedState(newControl(base, NOW))).toBeNull();
  });

  it("applies only to the exact state reviewed", () => {
    const stored = quarantined();
    const asked = request(stored, "adopt");
    for (const changed of [
      { artifactId: "bcdefghijk" },
      { region: "eu" },
      { incarnation: 2 },
      { reason: "owner" as const },
      { ownerId: "u_other" },
      { generation: 1 },
      { epoch: 1 },
    ]) {
      const stale = { ...asked, expected: { ...asked.expected, ...changed } };
      const decided = resolveReviewed(stored, base, stale, null);
      expect(decided.ok || decided.code, JSON.stringify(changed)).toBe("conflict");
    }
    const refusal = (decided: ReturnType<typeof resolveReviewed>) =>
      decided.ok ? null : { code: decided.code, message: decided.message };
    const nothing = { code: "conflict", message: "nothing to resolve" };
    expect(refusal(resolveReviewed(newControl(base, NOW), base, asked, null))).toEqual(nothing);
    expect(refusal(resolveReviewed(null, base, asked, null))).toEqual(nothing);
    expect(
      refusal(resolveReviewed(stored, { ...base, ownerId: "u_other" }, asked, null))?.code,
    ).toBe("stale");
    const stale = { ...asked, expected: { ...asked.expected, epoch: 1 } };
    expect(refusal(resolveReviewed(stored, base, stale, null))?.message).toBe(
      "the data changed since this resolution was reviewed",
    );
    const elsewhere = { ...base, artifactId: "bcdefghijk" };
    expect(refusal(resolveReviewed(stored, elsewhere, asked, null))?.code).toBe("forbidden");
    // Another artifact is refused even for a resolution that ended.
    expect(refusal(resolveReviewed(stored, elsewhere, asked, "committed"))?.code).toBe("forbidden");
  });

  it("finishes the same resolution on a retry, changing nothing", () => {
    const stored = newControl(base, NOW);
    const repeated = resolveReviewed(stored, base, request(quarantined(), "erase"), "committed");
    expect(repeated.ok && repeated.value.repeated).toBe(true);
    expect(repeated.ok && repeated.value.erasePayload).toBe(false);
    expect(resolveReviewed(null, base, request(quarantined(), "erase"), "committed").ok).toBe(
      false,
    );
  });

  it("refuses to erase while either side holds", () => {
    const heldObject = quarantined(fenced(newControl(base, NOW), 1, "hold_1"));
    const one = resolveReviewed(
      heldObject,
      { ...base, epoch: 1 },
      request(heldObject, "erase"),
      null,
    );
    expect(one.ok || one.code).toBe("held");
    expect(one.ok || one.message).toBe("a release must be acknowledged before erasing held data");
    const stored = quarantined();
    const d1 = resolveReviewed(
      stored,
      base,
      request(stored, "erase", { transition: "hold_d1" }),
      null,
    );
    expect(d1.ok || d1.code).toBe("held");
    expect(d1.ok || d1.message).toBe("a release must be acknowledged before erasing held data");
    const free = resolveReviewed(stored, base, request(stored, "erase"), null);
    expect(free.ok && free.value.erasePayload).toBe(true);
  });

  it("adopts keeping the object's hold or taking D1's, never dropping one", () => {
    const stored = quarantined();
    const taken = resolveReviewed(
      stored,
      base,
      request(stored, "adopt", { transition: "hold_d1" }),
      null,
    );
    expect(taken.ok && taken.value.control.hold).toEqual({ transition: "hold_d1", epoch: 0 });
    expect(taken.ok && taken.value.control.quarantine).toBeNull();
    const heldObject = quarantined(fenced(newControl(base, NOW), 1, "hold_1"));
    const kept = resolveReviewed(
      heldObject,
      { ...base, epoch: 1 },
      request(heldObject, "adopt"),
      null,
    );
    expect(kept.ok && kept.value.control.hold).toEqual({ transition: "hold_1", epoch: 1 });
    const open = resolveReviewed(stored, base, request(stored, "adopt"), null);
    expect(open.ok && open.value.control.hold).toBeNull();
    expect(open.ok && open.value.repeated).toBe(false);
  });
});

describe("a quarantine's incarnation", () => {
  it("is the object's own count, raised by each quarantine and never by a caller's time", () => {
    const first = quarantine(newControl(base, NOW), base, "orphan", NOW);
    if (!first.ok) throw new Error(first.message);
    expect(first.value.control.quarantine?.incarnation).toBe(1);
    expect(first.value.control.quarantines).toBe(1);
    // An open quarantine keeps its incarnation.
    const again = quarantine(first.value.control, base, "orphan", NOW);
    expect(again.ok && again.value.control.quarantine?.incarnation).toBe(1);
    const cleared = { ...first.value.control, quarantine: null };
    const second = quarantine(cleared, base, "orphan", NOW);
    expect(second.ok && second.value.control.quarantine?.incarnation).toBe(2);
    // The same reason at the same time is still another quarantine.
    const a = first.value.control;
    const b = second.ok ? second.value.control : a;
    expect(reviewedState(a)).not.toEqual(reviewedState(b));
  });
});

describe("a fence whose epoch another transition took", () => {
  it("ends, never takes a new epoch, and waits only for an epoch the object has not reached", () => {
    const control = fenced(newControl(base, NOW), 4, "hold_a");
    expect(fenceRefused(control, { ...base, epoch: 4 }, "stale", ROW_KEPT)).toBe("done");
    expect(
      fenceRefused(control, { ...base, epoch: 4 }, "stale", {
        dataRowGone: true,
        ownerAwaited: false,
      }),
    ).toBe("done");
    expect(fenceRefused(control, { ...base, epoch: 9 }, "stale", ROW_KEPT)).toBe("retry");
  });
});

describe("a fence under an owner the object does not have", () => {
  it("waits only while a transfer to that owner is waiting in D1", () => {
    const control = fenced(newControl(base, NOW), 2, "hold_a");
    const other = { ...base, ownerId: "u_other", epoch: 5 };
    // Killed mutations: dropping the owner comparison or the waiting transfer.
    expect(fenceRefused(control, other, "stale", { dataRowGone: false, ownerAwaited: true })).toBe(
      "retry",
    );
    expect(fenceRefused(control, other, "stale", ROW_KEPT)).toBe("done");
    // The object's own owner is unaffected by the evidence.
    expect(fenceRefused(control, { ...base, epoch: 5 }, "stale", ROW_KEPT)).toBe("retry");
  });
});

describe("a hold or release fence at delivery", () => {
  it("is obsolete when D1's level no longer wants it, and a transfer never is", () => {
    const open = { open: "h", objectHoldReleased: false };
    const free = { open: null, objectHoldReleased: false };
    // Killed mutations: either direction of the level check, or the kind comparison.
    expect(fenceObsolete({ kind: "release" }, open)).toBe(true);
    expect(fenceObsolete({ kind: "release" }, free)).toBe(false);
    expect(fenceObsolete({ kind: "hold" }, free)).toBe(true);
    expect(fenceObsolete({ kind: "hold" }, open)).toBe(false);
    expect(fenceObsolete({ kind: "transfer" }, open)).toBe(false);
    expect(fenceObsolete({ kind: "transfer" }, free)).toBe(false);
  });

  it("waits under another owner only on a transfer between the object's epoch and its own", () => {
    const control = fenced(newControl(base, NOW), 2, "hold_a");
    expect(awaitedTransferWindow(control, { ...base, epoch: 5 })).toEqual({ above: 2, below: 5 });
  });
});

describe("the hold convergence rule", () => {
  const row = { artifactId: "abcdefghij", region: "default", ownerId: "u_owner", generation: 0 };
  const free = newControl(base, NOW);
  const held = fenced(free, 5, "hold_a");
  const none = { open: null, objectHoldReleased: false };

  it("holds an object D1 holds, naming D1's open hold, past both epochs", () => {
    // Killed mutations: the epoch's `max` (D1 behind or ahead), the `+ 1`, the hold's identity.
    expect(holdCorrective(free, { ...row, epoch: 2 }, { ...none, open: "hold_b" })).toEqual({
      fence: { kind: "hold", transition: "hold_b" },
      envelope: { ...base, epoch: 3 },
    });
    const ahead = { ...free, epoch: 7 };
    expect(
      holdCorrective(ahead, { ...row, epoch: 2 }, { ...none, open: "h" })?.envelope.epoch,
    ).toBe(8);
  });

  it("releases only a hold D1 records as released, while D1 holds nothing", () => {
    expect(
      holdCorrective(held, { ...row, epoch: 0 }, { open: null, objectHoldReleased: true }),
    ).toEqual({
      fence: { kind: "release", transition: "hold_a:release" },
      envelope: { ...base, epoch: 6 },
    });
    // A hold D1 does not know is the operator's: a restore may have lost it.
    expect(holdCorrective(held, { ...row, epoch: 0 }, none)).toBeNull();
    // Never while D1 holds anything, whatever the identities.
    expect(
      holdCorrective(held, { ...row, epoch: 0 }, { open: "hold_b", objectHoldReleased: true }),
    ).toBeNull();
    expect(holdCorrective(free, { ...row, epoch: 0 }, none)).toBeNull();
    // Killed mutation: releasing an object that holds nothing.
    expect(
      holdCorrective(free, { ...row, epoch: 0 }, { open: null, objectHoldReleased: true }),
    ).toBeNull();
  });

  it("gives nothing for a quarantine, a prepared erase, another owner or generation", () => {
    const wants = { open: "hold_b", objectHoldReleased: false };
    const r = { ...row, epoch: 0 };
    expect(holdCorrective(null, r, wants)).toBeNull();
    expect(holdCorrective(free, null, wants)).toBeNull();
    expect(
      holdCorrective({ ...free, quarantine: { reason: "owner", at: NOW } }, r, wants),
    ).toBeNull();
    const erasing = { id: "e", generation: 0, epoch: 0 };
    expect(holdCorrective({ ...free, erasing }, r, wants)).toBeNull();
    expect(holdCorrective(free, { ...r, ownerId: "u_other" }, wants)).toBeNull();
    expect(holdCorrective(free, { ...r, generation: 1 }, wants)).toBeNull();
    expect(holdCorrective(free, r, wants)).not.toBeNull();
  });
});
