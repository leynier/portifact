// Unit tests of each rule of decision 0026's protocols, exact at their boundaries.
import { createHash } from "node:crypto";
import {
  ARTIFACT_DATA,
  type DataControl,
  type DataEnvelope,
  type JournalEntry,
} from "@portifact/contracts/artifact-data";
import fc from "fast-check";
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
import {
  actorOf,
  admit,
  afterStep,
  apiGate,
  applyFence,
  authorOf,
  barrierRefusal,
  batched,
  beginGate,
  COMMAND_ROWS,
  COUNTER_WRITE_ROWS,
  cancelErase,
  charged,
  checkHorizon,
  chunkLeavesMore,
  chunkSize,
  claimOutcome,
  classLimit,
  commitErase,
  compareKeys,
  completes,
  connectDecision,
  counted,
  createRefusal,
  cutPage,
  DELETED_ROW_ROWS,
  DOCUMENT_ROWS,
  dayOf,
  declareCollection,
  declaredFields,
  decodeCursor,
  deleteScope,
  documentBody,
  EDIT_ROWS,
  ERASED_ROW_ROWS,
  type ExportDocument,
  editorAfter,
  emptyDay,
  encodeCursor,
  exportFooter,
  exportHeader,
  exportLine,
  fenceEpochAdmitted,
  flushPending,
  growthRefusal,
  INDEX_STEP_ROWS,
  inbound,
  indexEntries,
  issuedAt,
  journalKey,
  journalPrunable,
  keyBefore,
  type LiveAttachment,
  liveCheck,
  liveReservation,
  measuredCharge,
  meter,
  minuteOf,
  mustFlushReads,
  mutationActorName,
  namesAnotherArtifact,
  newAttachment,
  newControl,
  newerReport,
  nextAlarm,
  nextBuild,
  noPendingReads,
  OPERATION_ROW_BOUNDS,
  outbound,
  pageOf,
  parseExportFile,
  passLeftMore,
  pendingDeadline,
  planConnect,
  planExport,
  planMatches,
  planQuery,
  planRead,
  prepareErase,
  presentDocument,
  pruneAllowed,
  pruneCutoffs,
  quarantine,
  RETAINED_CLASSES,
  rateRefusal,
  reaches,
  readScope,
  readyFields,
  receives,
  reconcile,
  redeemable,
  redeemGate,
  refuse,
  removeClass,
  renewDecision,
  replaceClass,
  replayDecision,
  requestHash,
  resolveQuarantine,
  retired,
  rollPending,
  scalarText,
  sequenceAdvances,
  sequenceScope,
  settleDecision,
  sha256Hex,
  spentRefusal,
  subscribed,
  touched,
  uniqueValue,
  utf8Length,
  withinBound,
  writeScope,
} from "./index.ts";

const base = envelope({ generation: 2, epoch: 5 });
const stored = newControl(base, NOW);
const request = { kind: "request", create: false } as const;
const id = (offset = 0) => `${NOW + offset}.erase0001`;

describe("admit", () => {
  it("decides every mode in the record's order", () => {
    expect(admit(null, base, request)).toEqual({ ok: true, empty: true });
    expect(admit(stored, base, request)).toEqual({ ok: true, empty: false });
    for (const mode of [
      request,
      { kind: "operator" },
      { kind: "erase" },
      { kind: "maintenance" },
    ] as const) {
      expect(admit(stored, { ...base, artifactId: "zzzzzzzz22" }, mode)).toEqual(
        refuse("forbidden", "artifact reference mismatch"),
      );
      expect(admit(stored, { ...base, region: "eu" }, mode)).toEqual(
        refuse("forbidden", "artifact reference mismatch"),
      );
    }
    const odd = { ...base, ownerId: "x", epoch: 0, generation: 9 };
    expect(
      admit(
        { ...stored, hold: { transition: "t", epoch: 5 }, quarantine: { reason: "owner", at: 0 } },
        odd,
        { kind: "maintenance" },
      ),
    ).toEqual({ ok: true, empty: false });
    const quarantined: DataControl = { ...stored, quarantine: { reason: "owner", at: NOW } };
    expect(admit(quarantined, base, request)).toEqual(
      refuse("quarantined", "This artifact's data is unavailable."),
    );
    expect(admit(quarantined, base, { kind: "erase" })).toMatchObject({ code: "quarantined" });
    expect(admit(quarantined, base, { kind: "operator" })).toEqual({ ok: true, empty: false });
    expect(admit(stored, { ...base, ownerId: "x" }, { kind: "operator" })).toEqual(
      refuse("stale", "the artifact changed owner"),
    );
    expect(admit(stored, { ...base, epoch: 4 }, request)).toEqual(
      refuse("stale", "the artifact changed since this request began"),
    );
    expect(admit(stored, { ...base, epoch: 6 }, request)).toEqual({ ok: true, empty: false });
    expect(admit(stored, { ...base, generation: 1 }, request)).toEqual(
      refuse("stale", "the data was erased since this request began"),
    );
    expect(admit(stored, { ...base, generation: 3 }, { kind: "erase" })).toMatchObject({
      code: "stale",
    });
    expect(admit(stored, { ...base, generation: 1 }, { kind: "erase" })).toEqual({
      ok: true,
      done: true,
    });
    expect(admit(stored, { ...base, generation: 1 }, { kind: "operator" })).toMatchObject({
      code: "stale",
    });
    const held: DataControl = { ...stored, hold: { transition: "t", epoch: 5 } };
    expect(admit(held, base, request)).toEqual(
      refuse("held", "This artifact cannot be changed right now."),
    );
    expect(admit(held, base, { kind: "erase" })).toMatchObject({ code: "held" });
    expect(admit(held, base, { kind: "operator" })).toEqual({ ok: true, empty: false });
    const erasing: DataControl = { ...stored, erasing: { id: id(), generation: 2, epoch: 5 } };
    expect(admit(erasing, base, request)).toEqual(refuse("stale", "the data is being erased"));
    expect(admit(erasing, base, { kind: "erase" })).toEqual({ ok: true, empty: false });
    expect(admit(erasing, base, { kind: "operator" })).toEqual({ ok: true, empty: false });
    expect(namesAnotherArtifact(stored, base)).toBe(false);
  });

  it("binds a new control record from the envelope", () => {
    expect(newControl(base, NOW)).toEqual({
      artifactId: base.artifactId,
      region: "default",
      ownerId: "owner_a",
      ownerEpoch: 5,
      generation: 2,
      epoch: 5,
      boundEpoch: 5,
      fencedEpoch: null,
      hold: null,
      quarantine: null,
      erasing: null,
      lastErase: null,
      last: {
        id: "created",
        kind: "created",
        epoch: 5,
        fromOwner: null,
        toOwner: "owner_a",
        at: NOW,
      },
      storageSeq: 0,
      payloadRevision: 0,
      liveEpoch: 0,
    });
    expect(touched(stored, false)).toMatchObject({ storageSeq: 1, payloadRevision: 0 });
    expect(touched(stored, true)).toMatchObject({ storageSeq: 1, payloadRevision: 1 });
  });
});

describe("fences", () => {
  const at = (epoch: number) => ({ ...base, epoch });
  it("applies each kind and records its transition", () => {
    const hold = applyFence(stored, at(6), { kind: "hold", transition: "h" }, NOW + 1);
    expect(hold).toEqual({
      ok: true,
      value: {
        control: {
          ...stored,
          epoch: 6,
          fencedEpoch: 6,
          hold: { transition: "h", epoch: 6 },
          last: {
            id: "h",
            kind: "hold",
            epoch: 6,
            fromOwner: "owner_a",
            toOwner: "owner_a",
            at: NOW + 1,
          },
          storageSeq: 1,
          liveEpoch: 1,
        },
        repeated: false,
        cancelledErase: null,
        closeConnections: true,
        rearm: false,
      },
    });
    const held = (hold as { value: { control: DataControl } }).value.control;
    expect(applyFence(held, at(7), { kind: "epoch", transition: "e" }, NOW)).toMatchObject({
      ok: true,
      value: { control: { hold: { transition: "h" } }, rearm: false },
    });
    expect(applyFence(held, at(7), { kind: "hold", transition: "h2" }, NOW)).toMatchObject({
      ok: true,
      value: { control: { hold: { transition: "h2", epoch: 7 } } },
    });
    expect(applyFence(held, at(7), { kind: "release", transition: "r" }, NOW)).toMatchObject({
      ok: true,
      value: { control: { hold: null }, rearm: true },
    });
    expect(
      applyFence(held, at(7), { kind: "transfer", toOwner: "b", transition: "m" }, NOW),
    ).toEqual(refuse("held", "a held artifact cannot change owner"));
    expect(
      applyFence(stored, at(6), { kind: "transfer", toOwner: "owner_a", transition: "m" }, NOW),
    ).toEqual(refuse("invalid_input", "a transfer needs a new owner"));
    expect(
      applyFence(stored, at(6), { kind: "transfer", toOwner: "b", transition: "m" }, NOW),
    ).toMatchObject({
      ok: true,
      value: {
        control: {
          ownerId: "b",
          ownerEpoch: 6,
          last: { kind: "transfer", fromOwner: "owner_a", toOwner: "b" },
        },
      },
    });
  });

  it("ends a prepared erase on a hold or a transfer, not on a release or an epoch", () => {
    const erasing: DataControl = {
      ...stored,
      erasing: { id: id(), generation: 2, epoch: 5 },
      lastErase: null,
    };
    for (const fence of [
      { kind: "hold" as const, transition: "x" },
      { kind: "transfer" as const, toOwner: "b", transition: "x" },
    ]) {
      expect(applyFence(erasing, at(6), fence, NOW)).toMatchObject({
        ok: true,
        value: {
          control: { erasing: null, lastErase: { id: id(), outcome: "cancelled" } },
          cancelledErase: id(),
        },
      });
    }
    for (const fence of [
      { kind: "release" as const, transition: "x" },
      { kind: "epoch" as const, transition: "x" },
    ]) {
      expect(applyFence(erasing, at(6), fence, NOW)).toMatchObject({
        ok: true,
        value: { control: { erasing: { id: id() }, lastErase: null }, cancelledErase: null },
      });
    }
    expect(applyFence(stored, at(6), { kind: "hold", transition: "x" }, NOW)).toMatchObject({
      value: { control: { lastErase: null } },
    });
  });

  it("refuses the wrong artifact, generation, owner and epoch, and recognizes repeats by contents", () => {
    expect(
      applyFence(stored, { ...at(6), region: "eu" }, { kind: "hold", transition: "x" }, NOW),
    ).toMatchObject({ code: "forbidden" });
    expect(
      applyFence(stored, { ...at(6), generation: 1 }, { kind: "hold", transition: "x" }, NOW),
    ).toEqual(refuse("stale", "the fence names another generation"));
    expect(
      applyFence(stored, { ...at(6), ownerId: "x" }, { kind: "hold", transition: "x" }, NOW),
    ).toEqual(refuse("stale", "the fence names another owner"));
    expect(applyFence(stored, at(4), { kind: "hold", transition: "x" }, NOW)).toEqual(
      refuse("stale", "a fence needs a newer epoch"),
    );
    // The first fence may come at the epoch the object was bound at; after it, only newer ones.
    const fenced = applyFence(stored, at(5), { kind: "hold", transition: "x" }, NOW);
    expect(fenced).toMatchObject({ ok: true, value: { control: { epoch: 5, fencedEpoch: 5 } } });
    const once = (fenced as { value: { control: DataControl } }).value.control;
    expect(applyFence(once, at(5), { kind: "release", transition: "y" }, NOW)).toEqual(
      refuse("stale", "a fence needs a newer epoch"),
    );
    expect(applyFence(once, at(6), { kind: "release", transition: "y" }, NOW)).toMatchObject({
      ok: true,
    });
    expect(fenceEpochAdmitted(stored, 5)).toBe(true);
    expect(fenceEpochAdmitted(stored, 4)).toBe(false);
    expect(fenceEpochAdmitted(once, 5)).toBe(false);
    expect(fenceEpochAdmitted(once, 6)).toBe(true);
    // A fence at a lower epoch than a newer request's never lowers the admission floor.
    expect(
      applyFence({ ...stored, epoch: 9 }, at(6), { kind: "epoch", transition: "z" }, NOW),
    ).toMatchObject({ value: { control: { epoch: 9, fencedEpoch: 6 } } });
    const moved = (
      applyFence(stored, at(6), { kind: "transfer", toOwner: "b", transition: "m" }, NOW) as {
        value: { control: DataControl };
      }
    ).value.control;
    expect(
      applyFence(moved, at(6), { kind: "transfer", toOwner: "b", transition: "m" }, NOW),
    ).toEqual({
      ok: true,
      value: {
        control: moved,
        repeated: true,
        cancelledErase: null,
        closeConnections: false,
        rearm: false,
      },
    });
    const conflict = refuse("conflict", "this transition ID was used for another change");
    expect(
      applyFence(moved, at(6), { kind: "transfer", toOwner: "c", transition: "m" }, NOW),
    ).toEqual(conflict);
    expect(
      applyFence(moved, at(7), { kind: "transfer", toOwner: "b", transition: "m" }, NOW),
    ).toEqual(conflict);
    expect(applyFence(moved, at(6), { kind: "hold", transition: "m" }, NOW)).toEqual(conflict);
    const held = (
      applyFence(stored, at(6), { kind: "hold", transition: "h" }, NOW) as {
        value: { control: DataControl };
      }
    ).value.control;
    expect(applyFence(held, at(6), { kind: "hold", transition: "h" }, NOW)).toMatchObject({
      value: { repeated: true },
    });
  });

  it("binds an empty object at the fence's own epoch", () => {
    expect(applyFence(null, base, { kind: "hold", transition: "h" }, NOW)).toMatchObject({
      ok: true,
      value: {
        control: {
          epoch: 5,
          ownerEpoch: 5,
          hold: { transition: "h" },
          storageSeq: 1,
          generation: 2,
        },
      },
    });
    expect(
      applyFence(null, base, { kind: "transfer", toOwner: "b", transition: "m" }, NOW),
    ).toMatchObject({ value: { control: { ownerId: "b", last: { fromOwner: "owner_a" } } } });
  });
});

describe("quarantine and reconciliation", () => {
  it("quarantines once, keeps the first reason, and refuses empty or other objects", () => {
    expect(quarantine(null, base, "owner", NOW)).toEqual(
      refuse("not_found", "no data to quarantine"),
    );
    expect(quarantine(stored, { ...base, region: "eu" }, "owner", NOW)).toMatchObject({
      code: "forbidden",
    });
    const first = quarantine(stored, base, "hold", NOW);
    expect(first).toEqual({
      ok: true,
      value: {
        control: {
          ...stored,
          quarantine: { reason: "hold", at: NOW },
          storageSeq: 1,
          liveEpoch: 1,
        },
        changed: true,
      },
    });
    const control = (first as { value: { control: DataControl } }).value.control;
    expect(quarantine(control, base, "owner", NOW + 1)).toEqual({
      ok: true,
      value: { control, changed: false },
    });
  });

  it("resolves by adopting or erasing, never erasing held data", () => {
    const q: DataControl = { ...stored, quarantine: { reason: "owner", at: NOW } };
    expect(resolveQuarantine(stored, base, "adopt")).toEqual(
      refuse("conflict", "nothing to resolve"),
    );
    expect(resolveQuarantine(null, base, "adopt")).toMatchObject({ code: "conflict" });
    expect(resolveQuarantine(q, { ...base, ownerId: "x" }, "adopt")).toMatchObject({
      code: "stale",
    });
    expect(resolveQuarantine(q, { ...base, generation: 1 }, "adopt")).toMatchObject({
      code: "stale",
    });
    expect(resolveQuarantine(q, base, "adopt")).toEqual({
      ok: true,
      value: {
        control: { ...q, quarantine: null, storageSeq: 1, liveEpoch: q.liveEpoch + 1 },
        erasePayload: false,
        endedErase: null,
      },
    });
    expect(resolveQuarantine({ ...q, hold: { transition: "t", epoch: 5 } }, base, "erase")).toEqual(
      refuse("held", "a release must be acknowledged before erasing held data"),
    );
    expect(resolveQuarantine(q, base, "erase")).toEqual({
      ok: true,
      value: {
        control: {
          ...q,
          generation: 3,
          quarantine: null,
          erasing: null,
          storageSeq: 1,
          payloadRevision: 1,
          liveEpoch: q.liveEpoch + 1,
        },
        erasePayload: true,
        endedErase: null,
      },
    });
    const erasing = { ...q, erasing: { id: id(), generation: 2, epoch: 5 } };
    expect(resolveQuarantine(erasing, base, "erase")).toMatchObject({
      value: { control: { lastErase: { id: id(), outcome: "committed" } }, endedErase: id() },
    });
  });

  it("follows the field authority table", () => {
    const row = { ownerId: "owner_a", generation: 2, epoch: 5, held: false };
    expect(reconcile(row, null)).toEqual({ action: "none" });
    expect(reconcile(null, null)).toEqual({ action: "none" });
    expect(reconcile(row, stored)).toEqual({ action: "none" });
    expect(reconcile(null, stored)).toEqual({ action: "quarantine", reason: "orphan" });
    expect(reconcile({ ...row, ownerId: "x" }, stored)).toEqual({
      action: "quarantine",
      reason: "owner",
    });
    expect(reconcile({ ...row, held: true }, stored)).toEqual({
      action: "quarantine",
      reason: "hold",
    });
    expect(reconcile(row, { ...stored, hold: { transition: "t", epoch: 5 } })).toEqual({
      action: "quarantine",
      reason: "hold",
    });
    expect(reconcile({ ...row, generation: 3 }, stored)).toEqual({
      action: "quarantine",
      reason: "generation",
    });
    expect(reconcile({ ...row, generation: 1, epoch: 9 }, stored)).toEqual({
      action: "raise",
      generation: 2,
      epoch: 9,
    });
    expect(reconcile({ ...row, generation: 1, epoch: 2 }, stored)).toEqual({
      action: "raise",
      generation: 2,
      epoch: 6,
    });
    expect(reconcile({ ...row, epoch: 4 }, stored)).toEqual({
      action: "raise",
      generation: 2,
      epoch: 6,
    });
    // D1 at or ahead of the object's epoch, same generation: nothing to raise.
    expect(reconcile({ ...row, epoch: 6 }, stored)).toEqual({ action: "none" });
    expect(reconcile(row, { ...stored, erasing: { id: id(), generation: 2, epoch: 7 } })).toEqual({
      action: "resume_erase",
      eraseId: id(),
      generation: 2,
      epoch: 7,
    });
    expect(
      reconcile(
        { ...row, epoch: 8 },
        { ...stored, erasing: { id: id(), generation: 2, epoch: 7 } },
      ),
    ).toMatchObject({ epoch: 8 });
    expect(
      reconcile(row, { ...stored, epoch: 9, erasing: { id: id(), generation: 2, epoch: 7 } }),
    ).toMatchObject({ epoch: 9 });
    expect(reconcile(row, { ...stored, quarantine: { reason: "owner", at: 0 } })).toEqual({
      action: "operator",
    });
  });
});

describe("erase steps", () => {
  const e = envelope();
  const NONE = {
    control: null,
    erasePayload: false,
    ended: null,
    closeConnections: false,
    startsIntent: false,
  };
  const prepared = (control: DataControl | null, eraseId = id(), at = e) => {
    const step = prepareErase(control, at, eraseId, null, NOW);
    return (step as { value: { control: DataControl } }).value.control;
  };
  it("prepares a new intent, binding an empty object, and repeats it", () => {
    expect(prepareErase(null, e, id(), null, NOW)).toEqual({
      ok: true,
      value: {
        outcome: "prepared",
        control: {
          ...newControl(e, NOW),
          erasing: { id: id(), generation: 0, epoch: 0 },
          storageSeq: 1,
          liveEpoch: 1,
        },
        erasePayload: false,
        ended: null,
        closeConnections: true,
        startsIntent: true,
      },
    });
    const control = prepared(newControl(e, NOW));
    expect(prepareErase(control, e, id(), null, NOW)).toEqual({
      ok: true,
      value: { outcome: "prepared", ...NONE },
    });
    expect(prepareErase(control, e, id(1), null, NOW)).toEqual(
      refuse("conflict", "another erase is prepared"),
    );
  });

  it("applies the horizon and the day's admission only to starting an unknown intent", () => {
    const fresh = newControl(e, NOW);
    expect(prepareErase(fresh, e, "bad", null, NOW)).toMatchObject({ code: "invalid_input" });
    expect(prepareErase(fresh, e, id(-ARTIFACT_DATA.horizonMs - 1), null, NOW)).toMatchObject({
      code: "conflict",
    });
    const limit = ARTIFACT_DATA.erase.intentsPerDay;
    expect(prepareErase(fresh, e, id(), null, NOW, limit - 1)).toMatchObject({ ok: true });
    expect(prepareErase(fresh, e, id(), null, NOW, limit)).toEqual(
      refuse("rate_limited", "too many erase intents today, try again tomorrow"),
    );
    // A prepared intent stays repeatable, finishable and cancellable after any delay.
    const control = prepared(fresh);
    const late = NOW + 10 * ARTIFACT_DATA.replayMs;
    expect(prepareErase(control, e, id(), null, late, limit)).toMatchObject({
      value: { outcome: "prepared" },
    });
    expect(commitErase(control, e, id(), null)).toMatchObject({ value: { outcome: "committed" } });
    expect(cancelErase(control, e, id(), null)).toMatchObject({ value: { outcome: "cancelled" } });
  });

  it("keeps the intent's target: an older envelope is refused, a newer one (a restore) accepted", () => {
    const control = prepared(newControl(e, NOW), id(), { ...e, epoch: 5 });
    expect(control.erasing).toEqual({ id: id(), generation: 0, epoch: 5 });
    const older = refuse("stale", "this step is older than the prepared erase");
    for (const step of [commitErase, cancelErase]) {
      expect(step(control, { ...e, epoch: 4 }, id(), null)).toEqual(older);
      expect(step(control, { ...e, epoch: 6 }, id(), null)).toMatchObject({ ok: true });
      expect(step(control, { ...e, epoch: 5 }, id(), null)).toMatchObject({ ok: true });
    }
    expect(prepareErase(control, { ...e, epoch: 4 }, id(), null, NOW)).toEqual(older);
    expect(prepareErase(control, { ...e, epoch: 9 }, id(), null, NOW)).toEqual({
      ok: true,
      value: { outcome: "prepared", ...NONE },
    });
  });

  it("answers an ended intent before anything else, except another artifact", () => {
    const steps = [
      (
        c: DataControl | null,
        en: typeof base,
        i: string,
        ended: "cancelled" | "committed" | null,
      ) => prepareErase(c, en, i, ended, NOW),
      commitErase,
      cancelErase,
    ];
    for (const step of steps) {
      expect(step(stored, base, id(), "cancelled")).toEqual({
        ok: true,
        value: { outcome: "cancelled", ...NONE },
      });
      expect(step(stored, { ...base, artifactId: "zzzzzzzz22" }, id(), "committed")).toMatchObject({
        code: "forbidden",
      });
      expect(step(stored, { ...base, generation: 1 }, id(), null)).toEqual({
        ok: true,
        value: { outcome: "superseded", ...NONE },
      });
      expect(
        step({ ...stored, hold: { transition: "t", epoch: 5 } }, base, id(), null),
      ).toMatchObject({ code: "held" });
    }
  });

  it("commits and cancels only the prepared ID", () => {
    const control = prepared(newControl(e, NOW));
    expect(commitErase(control, e, id(1), null)).toEqual(
      refuse("conflict", "this erase is not the prepared one"),
    );
    expect(cancelErase(control, e, id(1), null)).toEqual(
      refuse("conflict", "this erase is not the prepared one"),
    );
    expect(commitErase(null, e, id(), null)).toMatchObject({ code: "conflict" });
    expect(cancelErase(null, e, id(), null)).toMatchObject({ code: "conflict" });
    expect(commitErase(control, e, id(), null)).toEqual({
      ok: true,
      value: {
        outcome: "committed",
        control: {
          ...control,
          generation: 1,
          erasing: null,
          lastErase: { id: id(), outcome: "committed" },
          storageSeq: 2,
          payloadRevision: 1,
          liveEpoch: control.liveEpoch + 1,
        },
        erasePayload: true,
        ended: { id: id(), outcome: "committed" },
        closeConnections: true,
        startsIntent: false,
      },
    });
    expect(cancelErase(control, e, id(), null)).toEqual({
      ok: true,
      value: {
        outcome: "cancelled",
        control: {
          ...control,
          erasing: null,
          lastErase: { id: id(), outcome: "cancelled" },
          storageSeq: 2,
        },
        erasePayload: false,
        ended: { id: id(), outcome: "cancelled" },
        closeConnections: false,
        startsIntent: false,
      },
    });
  });
});

describe("operations", () => {
  it("parses issue times and enforces the horizon at its exact edges", () => {
    expect(issuedAt(`${NOW}.abcdefgh`)).toBe(NOW);
    expect(issuedAt(`${NOW}.short`)).toBeNull();
    expect(issuedAt(`x${NOW}.abcdefgh`)).toBeNull();
    expect(issuedAt(`${NOW}.abcdefgh!`)).toBeNull();
    expect(issuedAt("1.abcdefgh")).toBeNull();
    const op = `${NOW}.abcdefgh`;
    expect(checkHorizon(op, NOW + ARTIFACT_DATA.horizonMs)).toEqual({ ok: true, value: NOW });
    expect(checkHorizon(op, NOW + ARTIFACT_DATA.horizonMs + 1)).toEqual(
      refuse("conflict", "this operation ID has expired; start a new operation"),
    );
    expect(checkHorizon(op, NOW - ARTIFACT_DATA.clockSkewMs)).toMatchObject({ ok: true });
    expect(checkHorizon(op, NOW - ARTIFACT_DATA.clockSkewMs - 1)).toMatchObject({
      code: "conflict",
    });
    expect(checkHorizon("nope", NOW)).toEqual(
      refuse("invalid_input", "an operation ID is its issue time, a dot and a random part"),
    );
    expect(ARTIFACT_DATA.horizonMs + ARTIFACT_DATA.clockSkewMs).toBeLessThan(
      ARTIFACT_DATA.replayMs,
    );
  });

  it("decides replays and hashes requests synchronously", () => {
    const prior = {
      requestHash: "h",
      state: "committed" as const,
      kind: "document",
      target: "items/x",
      result: null,
    };
    expect(replayDecision(null, "h")).toEqual({ ok: true, value: { kind: "fresh" } });
    expect(replayDecision(prior, "h")).toEqual({
      ok: true,
      value: { kind: "replay", answer: { kind: "document", target: "items/x", result: null } },
    });
    expect(replayDecision(prior, "other")).toEqual(
      refuse("conflict", "this operation ID was used for another request"),
    );
    expect(replayDecision({ ...prior, state: "aborted" }, "h")).toEqual(
      refuse("conflict", "this operation was abandoned"),
    );
    expect(requestHash(["create", "items", { n: 1 }])).toBe(
      createHash("sha256").update('["create","items",{"n":1}]').digest("hex"),
    );
    expect(requestHash(undefined)).toBe(createHash("sha256").update("null").digest("hex"));
  });

  it("settles each case", () => {
    const op = `${NOW}.abcdefgh`;
    const none = { obligation: null, record: null, barred: false, currentGeneration: true };
    expect(
      settleDecision(
        { ...none, obligation: { kind: "data.x", detail: { n: 1 }, state: "pending" } },
        op,
        NOW,
      ),
    ).toEqual({
      answer: { state: "committed", kind: "data.x", detail: { n: 1 }, delivered: false },
      writeAborted: false,
    });
    expect(
      settleDecision(
        { ...none, obligation: { kind: "data.x", detail: {}, state: "delivered" } },
        op,
        NOW,
      ).answer,
    ).toMatchObject({ delivered: true });
    expect(
      settleDecision({ ...none, record: { state: "committed", kind: "document" } }, op, NOW),
    ).toEqual({
      answer: { state: "committed", kind: "document", detail: null, delivered: true },
      writeAborted: false,
    });
    expect(
      settleDecision({ ...none, record: { state: "aborted", kind: "aborted" } }, op, NOW),
    ).toEqual({ answer: { state: "aborted" }, writeAborted: false });
    expect(settleDecision(none, op, NOW)).toEqual({
      answer: { state: "aborted" },
      writeAborted: true,
    });
    expect(settleDecision({ ...none, barred: true }, op, NOW)).toEqual({
      answer: { state: "aborted" },
      writeAborted: false,
    });
    expect(settleDecision({ ...none, currentGeneration: false }, op, NOW).writeAborted).toBe(false);
    expect(settleDecision(none, op, NOW + ARTIFACT_DATA.horizonMs).writeAborted).toBe(true);
    expect(settleDecision(none, op, NOW + ARTIFACT_DATA.horizonMs + 1).writeAborted).toBe(false);
    expect(settleDecision(none, op, NOW - ARTIFACT_DATA.clockSkewMs).writeAborted).toBe(true);
    expect(settleDecision(none, op, NOW - ARTIFACT_DATA.clockSkewMs - 1)).toEqual({
      answer: { state: "refused", code: "conflict" },
      writeAborted: false,
    });
    expect(settleDecision(none, "bad", NOW)).toEqual({
      answer: { state: "refused", code: "invalid_input" },
      writeAborted: false,
    });
  });

  it("computes SHA-256 like Node for any text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (text) => {
        expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
      }),
      { numRuns: 300 },
    );
    for (const length of [0, 55, 56, 63, 64, 65, 119, 120, 1_000]) {
      const text = "a".repeat(length);
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });
});

describe("charging", () => {
  it("names days and minutes in UTC", () => {
    expect(dayOf(86_400_000 * 3 - 1)).toBe(2);
    expect(dayOf(86_400_000 * 3)).toBe(3);
    expect(minuteOf(120_000 - 1)).toBe(1);
    expect(minuteOf(120_000)).toBe(2);
    expect(emptyDay(7)).toEqual({
      day: 7,
      growth: 0,
      read: 0,
      cleanup: 0,
      export: 0,
      rights: 0,
      protected: 0,
      live: 0,
      refused: 0,
      intents: 0,
    });
  });

  it("maps each class to its limit and refusal, exactly at the limit", () => {
    const limits = {
      ...FREE,
      rowsWrittenPerDay: 10,
      rowsReadPerDay: 11,
      cleanupRowsPerDay: 12,
      exportRowsPerDay: 13,
      rightsRowsPerDay: 14,
    };
    expect(
      ["growth", "read", "cleanup", "export", "rights"].map((name) =>
        classLimit(name as "growth", limits),
      ),
    ).toEqual([10, 11, 12, 13, 14]);
    expect(spentRefusal("growth", 9, limits)).toBeNull();
    expect(spentRefusal("growth", 10, limits)).toEqual(
      refuse("quota_exceeded", "this artifact's data budget for today is spent"),
    );
    expect(spentRefusal("read", 11, limits)).toMatchObject({ code: "quota_exceeded" });
    expect(spentRefusal("cleanup", 12, limits)).toEqual(
      refuse("rate_limited", "this artifact's cleanup allowance for today is spent"),
    );
    expect(spentRefusal("export", 13, limits)).toMatchObject({ code: "rate_limited" });
    expect(spentRefusal("rights", 13, limits)).toBeNull();
    expect(rateRefusal(2, 3)).toBeNull();
    expect(rateRefusal(3, 3)).toEqual(
      refuse("rate_limited", "too many requests, try again in a minute"),
    );
  });

  it("charges measured work plus the charge's own rows, folding pending reads in", () => {
    expect(measuredCharge({ rowsRead: 3, rowsWritten: 5 })).toBe(12);
    const pending = { day: 1, rows: 7, refused: 2, since: 0, deferred: 0 };
    expect(charged(emptyDay(1), "cleanup", { rowsRead: 1, rowsWritten: 1 }, pending)).toEqual({
      ...emptyDay(1),
      cleanup: 6,
      read: 7,
      refused: 2,
    });
    expect(
      charged(
        { ...emptyDay(1), read: 3 },
        "read",
        { rowsRead: 1, rowsWritten: 0 },
        noPendingReads(86_400_000),
      ),
    ).toMatchObject({ read: 8 });
  });

  it("keeps pending reads per day and flushes at either bound", () => {
    expect(noPendingReads(86_400_000 + 5)).toEqual({
      day: 1,
      rows: 0,
      refused: 0,
      since: 86_400_005,
      deferred: 0,
    });
    const pending = { day: 1, rows: 5, refused: 0, since: 86_400_000, deferred: 0 };
    expect(rollPending(pending, 86_400_000 * 2 - 1)).toEqual({ previous: null, current: pending });
    expect(rollPending(pending, 86_400_000 * 2)).toEqual({
      previous: pending,
      current: noPendingReads(86_400_000 * 2),
    });
    expect(rollPending({ ...pending, rows: 0 }, 86_400_000 * 2).previous).toBeNull();
    expect(
      rollPending({ ...pending, rows: 0, refused: 1 }, 86_400_000 * 2).previous,
    ).not.toBeNull();
    expect(pendingDeadline(pending)).toBe(86_400_000 + ARTIFACT_DATA.readFlush.ms);
    expect(pendingDeadline({ ...pending, rows: 0 })).toBeNull();
    expect(
      mustFlushReads(
        { ...pending, rows: 0, refused: ARTIFACT_DATA.readFlush.refusals - 1 },
        86_400_000,
      ),
    ).toBe(false);
    expect(
      mustFlushReads(
        { ...pending, rows: 0, refused: ARTIFACT_DATA.readFlush.refusals },
        86_400_000,
      ),
    ).toBe(true);
    expect(mustFlushReads({ ...pending, rows: 0 }, 86_400_000 * 9)).toBe(false);
    expect(
      mustFlushReads({ ...pending, rows: 0, refused: 1 }, 86_400_000 + ARTIFACT_DATA.readFlush.ms),
    ).toBe(true);
    expect(mustFlushReads(pending, 86_400_000 + ARTIFACT_DATA.readFlush.ms - 1)).toBe(false);
    expect(mustFlushReads(pending, 86_400_000 + ARTIFACT_DATA.readFlush.ms)).toBe(true);
    expect(mustFlushReads({ ...pending, rows: ARTIFACT_DATA.readFlush.rows - 1 }, 86_400_000)).toBe(
      false,
    );
    expect(mustFlushReads({ ...pending, rows: ARTIFACT_DATA.readFlush.rows }, 86_400_000)).toBe(
      true,
    );
  });

  it("counts uncharged outcomes into pending usage, starting its clock at the first", () => {
    const pending = { day: dayOf(NOW), rows: 5, refused: 1, since: NOW, deferred: 0 };
    expect(counted(pending, { rowsRead: 3, rowsWritten: 1 }, false, NOW + 9)).toEqual({
      ...pending,
      rows: 9,
    });
    expect(counted(pending, { rowsRead: 0, rowsWritten: 0 }, true, NOW + 9)).toEqual({
      ...pending,
      refused: 2,
    });
    expect(counted(noPendingReads(NOW), { rowsRead: 2, rowsWritten: 0 }, false, NOW + 9)).toEqual({
      day: dayOf(NOW),
      rows: 2,
      refused: 0,
      since: NOW + 9,
      deferred: 0,
    });
  });

  it("reserves live messages without passing the day's limit", () => {
    expect(liveReservation(0, 1_000)).toBe(100);
    expect(liveReservation(950, 1_000)).toBe(50);
    expect(liveReservation(1_000, 1_000)).toBe(0);
    expect(liveReservation(1_200, 1_000)).toBe(0);
  });

  it("bounds operations by their caps", () => {
    const get = OPERATION_ROW_BOUNDS.get;
    expect(withinBound("get", { rowsRead: get, rowsWritten: 0 })).toBe(true);
    expect(withinBound("get", { rowsRead: get, rowsWritten: 1 })).toBe(false);
    // Derived from the constants the work uses, so they cannot drift from it.
    expect(OPERATION_ROW_BOUNDS.prune).toBe(
      COMMAND_ROWS +
        RETAINED_CLASSES.length * (DELETED_ROW_ROWS * ARTIFACT_DATA.caps.pruneRows + 1),
    );
    // Real SQLite measures three rows per row deleted by key after its seek (delivery 4).
    expect(DELETED_ROW_ROWS).toBe(3);
    expect(ERASED_ROW_ROWS).toBe(DELETED_ROW_ROWS);
    expect(OPERATION_ROW_BOUNDS.erase_author_chunk).toBe(
      COMMAND_ROWS +
        ARTIFACT_DATA.caps.eraseChunkDocuments * (DOCUMENT_ROWS + EDIT_ROWS + 3 * DELETED_ROW_ROWS),
    );
    expect(RETAINED_CLASSES).toHaveLength(6);
    expect(OPERATION_ROW_BOUNDS.declare).toBeGreaterThan(
      INDEX_STEP_ROWS * ARTIFACT_DATA.caps.indexStepDocuments,
    );
    expect(OPERATION_ROW_BOUNDS.bulk_replace).toBe(
      COMMAND_ROWS + ARTIFACT_DATA.caps.bulkDocuments * 2 * DOCUMENT_ROWS,
    );
  });
});

describe("documents", () => {
  const a = visitor("a");
  const readOnly = visitor("a", false);
  it("decides scopes from the mode and the caller only", () => {
    const table = (scope: typeof readScope) =>
      (["own", "append", "read", "shared"] as const).map((mode) =>
        [OWNER, a, readOnly, READER].map((caller) => scope(mode, caller)).join(","),
      );
    expect(table(readScope)).toEqual([
      "all,own,own,none",
      "all,all,all,all",
      "all,all,all,all",
      "all,all,all,all",
    ]);
    expect(table(writeScope)).toEqual([
      "all,own,none,none",
      "all,own,none,none",
      "all,none,none,none",
      "all,all,none,none",
    ]);
    expect(table(deleteScope)).toEqual([
      "all,own,own,none",
      "all,own,own,none",
      "all,own,own,none",
      "all,all,own,none",
    ]);
    expect(reaches("all", READER, "x")).toBe(true);
    expect(reaches("own", a, (a as { author: string }).author)).toBe(true);
    expect(reaches("own", a, "other")).toBe(false);
    expect(reaches("own", OWNER, "owner")).toBe(false);
    expect(reaches("none", a, (a as { author: string }).author)).toBe(false);
    expect([
      actorOf(a),
      actorOf(OWNER),
      actorOf({ kind: "owner", actor: "u1" }),
      actorOf(READER),
    ]).toEqual([(a as { author: string }).author, "owner:owner", "owner:u1", "reader"]);
    expect([authorOf(a), authorOf(OWNER), authorOf(READER)]).toEqual([
      (a as { author: string }).author,
      "owner",
      null,
    ]);
    expect([
      mutationActorName({ kind: "erasure" }),
      mutationActorName(READER),
      mutationActorName({ kind: "owner", actor: "u" }),
    ]).toEqual(["system:erasure", "reader", "owner:u"]);
  });

  it("validates bodies at their exact bounds", () => {
    expect(documentBody([], 100)).toEqual(refuse("invalid_input", "a document is a JSON object"));
    expect(documentBody(null, 100)).toMatchObject({ code: "invalid_input" });
    expect(documentBody("text", 100)).toMatchObject({ code: "invalid_input" });
    expect(documentBody({ _id: 1 }, 100)).toEqual(
      refuse("invalid_input", "fields starting with _ are set by the server"),
    );
    expect(documentBody({ a: "é" }, 10)).toEqual({
      ok: true,
      value: { text: '{"a":"é"}', size: 10 },
    });
    expect(documentBody({ a: "é" }, 9)).toEqual(
      refuse("quota_exceeded", "a document holds at most 9 bytes"),
    );
    let deep: unknown = 1;
    for (let level = 0; level < ARTIFACT_DATA.maxDepth; level++) deep = { d: deep };
    expect(documentBody(deep, 10_000).ok).toBe(true);
    expect(documentBody({ d: deep }, 10_000)).toEqual(
      refuse("invalid_input", "document nested too deep"),
    );
    expect(documentBody({ list: [[[1]]] }, 100).ok).toBe(true);
    expect(utf8Length("€")).toBe(3);
  });

  it("canonicalizes scalars for unique keys and indexes", () => {
    expect([
      scalarText("1"),
      scalarText(1),
      scalarText(1.0),
      scalarText(true),
      scalarText(null),
      scalarText([1]),
      scalarText(Number.NaN),
      scalarText(Number.POSITIVE_INFINITY),
      scalarText(undefined),
    ]).toEqual(['"1"', "1", "1", "true", null, null, null, null, null]);
    expect(uniqueValue({ k: "x" }, "k")).toEqual({ ok: true, value: '"x"' });
    expect(uniqueValue({ k: {} }, "k")).toEqual(
      refuse("invalid_input", "the unique field k must be a scalar"),
    );
    const long = "x".repeat(ARTIFACT_DATA.indexValueBytes - 2);
    expect(
      indexEntries({ a: 1, b: { c: 1 }, c: long, d: `${long}x`, e: false }, [
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
      ]),
    ).toEqual([
      { field: "a", value: "1" },
      { field: "c", value: JSON.stringify(long) },
      { field: "e", value: "false" },
    ]);
  });

  it("scopes sequences and attribution", () => {
    expect(sequenceScope("own", "c", "v")).toBe("author:v");
    expect(sequenceScope("shared", "c", "v")).toBe("collection:c");
    expect(sequenceAdvances("author:v", (author) => author === "v")).toBe(false);
    expect(sequenceAdvances("author:w", (author) => author === "v")).toBe(true);
    expect(sequenceAdvances("collection:v", () => true)).toBe(true);
    expect(editorAfter("v", "v")).toBeNull();
    expect(editorAfter("v", "w")).toBe("w");
    expect(
      presentDocument({
        id: "i",
        author: "v",
        editor: null,
        created: 1,
        updated: 2,
        seq: 3,
        body: '{"n":1,"_id":"spoof"}',
      }),
    ).toEqual({ n: 1, _id: "i", _by: "v", _editedBy: null, _created: 1, _updated: 2, _seq: 3 });
  });

  it("declares collections with fixed mode and key, under the plan's counts", () => {
    const limits = { ...FREE, collections: 2, indexedFields: 2 };
    const facts = { mode: "own" as const, uniqueKey: null, documents: 0, bytes: 0, fields: ["a"] };
    expect(declareCollection(null, { name: "x", mode: "own" }, 1, limits)).toEqual({
      ok: true,
      value: { create: true, addFields: [] },
    });
    expect(declareCollection(null, { name: "x", mode: "own" }, 2, limits)).toEqual(
      refuse("quota_exceeded", "at most 2 collections"),
    );
    expect(declareCollection(facts, { name: "x", mode: "own" }, 2, limits)).toEqual({
      ok: true,
      value: { create: false, addFields: [] },
    });
    expect(declareCollection(facts, { name: "x", mode: "append" }, 2, limits)).toEqual(
      refuse("conflict", "a collection's mode and unique key are fixed once declared"),
    );
    expect(
      declareCollection(facts, { name: "x", mode: "own", uniqueKey: "k" }, 2, limits),
    ).toMatchObject({ code: "conflict" });
    expect(
      declareCollection(facts, { name: "x", mode: "own", indexed: ["a", "b", "b"] }, 2, limits),
    ).toEqual({ ok: true, value: { create: false, addFields: ["b"] } });
    expect(
      declareCollection(facts, { name: "x", mode: "own", indexed: ["b", "c"] }, 2, limits),
    ).toEqual(refuse("quota_exceeded", "at most 2 indexed fields a collection"));
    expect(createRefusal({ ...facts, documents: 999 }, FREE)).toBeNull();
    expect(createRefusal({ ...facts, documents: 1_000 }, FREE)).toEqual(
      refuse("quota_exceeded", "a collection holds at most 1000 documents"),
    );
  });

  it("refuses growth only past the data size or the file's reserve, and only when growing", () => {
    const limits = { ...FREE, bytesPerArtifact: 1_000 };
    const reserve = ARTIFACT_DATA.controlReserveBytes;
    const full = refuse("quota_exceeded", "this artifact's data is full");
    expect(
      growthRefusal({ dataBytes: 1_000, fileBefore: 0, fileAfter: 0, grew: 1 }, limits),
    ).toBeNull();
    expect(
      growthRefusal({ dataBytes: 1_001, fileBefore: 0, fileAfter: 0, grew: 1 }, limits),
    ).toEqual(full);
    expect(
      growthRefusal({ dataBytes: 1_001, fileBefore: 0, fileAfter: 0, grew: 0 }, limits),
    ).toBeNull();
    expect(
      growthRefusal({ dataBytes: 0, fileBefore: 0, fileAfter: 1_000 + reserve, grew: 0 }, limits),
    ).toBeNull();
    expect(
      growthRefusal({ dataBytes: 0, fileBefore: 0, fileAfter: 1_001 + reserve, grew: 0 }, limits),
    ).toEqual(full);
    expect(
      growthRefusal(
        { dataBytes: 0, fileBefore: 2_000 + reserve, fileAfter: 2_000 + reserve, grew: 0 },
        limits,
      ),
    ).toBeNull();
    expect([replaceClass(5, 6), replaceClass(5, 5), replaceClass(5, 4)]).toEqual([
      "growth",
      "cleanup",
      "cleanup",
    ]);
    expect([
      removeClass(a, (a as { author: string }).author),
      removeClass(a, "other"),
      removeClass(OWNER, "owner"),
    ]).toEqual(["rights", "cleanup", "cleanup"]);
  });
});

describe("queries", () => {
  const a = visitor("a");
  it("plans each bounded shape and refuses the rest", () => {
    expect(planQuery({ collection: "c" }, "own", READER, [])).toEqual({
      ok: true,
      value: { kind: "empty" },
    });
    expect(planQuery({ collection: "c" }, "own", a, [])).toEqual({
      ok: true,
      value: {
        kind: "seek",
        index: "author",
        collection: "c",
        author: (a as { author: string }).author,
        field: null,
        value: null,
        range: null,
        descending: false,
        fetch: 21,
        limit: 20,
        after: null,
      },
    });
    expect(
      planQuery({ collection: "c", equals: { field: "_by", value: "x" } }, "own", a, []),
    ).toEqual(refuse("invalid_input", "own collections are filtered only by _created"));
    expect(
      planQuery({ collection: "c", order: "-created", limit: 100 }, "append", a, []),
    ).toMatchObject({ value: { index: "created", author: null, descending: true, fetch: 101 } });
    expect(
      planQuery({ collection: "c", equals: { field: "_by", value: "x" } }, "append", READER, []),
    ).toMatchObject({ value: { index: "author", author: "x" } });
    expect(
      planQuery({ collection: "c", equals: { field: "_by", value: 1 } }, "append", OWNER, []),
    ).toEqual(refuse("invalid_input", "_by is a string"));
    expect(
      planQuery({ collection: "c", equals: { field: "n", value: true } }, "own", OWNER, ["n"]),
    ).toMatchObject({ value: { index: "values", field: "n", value: "true" } });
    expect(
      planQuery({ collection: "c", equals: { field: "n", value: 1 } }, "append", OWNER, []),
    ).toEqual(refuse("invalid_input", "filter only on _by or a declared, built indexed field"));
    const long = "x".repeat(ARTIFACT_DATA.indexValueBytes - 1);
    expect(
      planQuery(
        { collection: "c", equals: { field: "n", value: long.slice(1) } },
        "append",
        OWNER,
        ["n"],
      ).ok,
    ).toBe(true);
    expect(
      planQuery({ collection: "c", equals: { field: "n", value: long } }, "append", OWNER, ["n"]),
    ).toEqual(refuse("invalid_input", "values that long are not indexed"));
    expect(planQuery({ collection: "c", after: "%%%" }, "append", OWNER, [])).toEqual(
      refuse("invalid_input", "invalid cursor"),
    );
    expect(planQuery({ collection: "c", limit: 0 }, "append", OWNER, [])).toMatchObject({
      value: { limit: 1, fetch: 2 },
    });
    expect(planQuery({ collection: "c", limit: 1_000 }, "append", OWNER, [])).toMatchObject({
      value: { limit: 100 },
    });
    expect(
      planQuery(
        { collection: "c", after: encodeCursor(5, "i"), created: { op: "gt", value: 1 } },
        "append",
        OWNER,
        [],
      ),
    ).toMatchObject({ value: { after: [5, "i"], range: { op: "gt", value: 1 } } });
  });

  it("keeps every plan bounded: the fetch is at most the page cap plus one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 10_000 }),
        fc.constantFrom("own", "append", "read", "shared"),
        (limit, mode) => {
          const plan = planQuery({ collection: "c", limit }, mode as "own", a, []);
          if (plan.ok && plan.value.kind === "seek") {
            expect(plan.value.fetch).toBeLessThanOrEqual(ARTIFACT_DATA.caps.pageDocuments + 1);
            expect(plan.value.fetch).toBe(plan.value.limit + 1);
            if (mode === "own") expect(plan.value.author).toBe((a as { author: string }).author);
          }
        },
      ),
    );
  });

  it("round-trips cursors and refuses malformed ones", () => {
    expect(decodeCursor(encodeCursor(17, "abc"))).toEqual([17, "abc"]);
    for (const bad of [
      "",
      "e30",
      btoa("[1]"),
      btoa('["1","a"]'),
      btoa('[1.5,"a"]'),
      btoa("[1,2]"),
      btoa('[1,"a",3]'),
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
    expect(encodeCursor(1, "a")).not.toContain("=");
  });

  it("matches documents to a plan as the indexes would", () => {
    const plan = (overrides: object) => ({
      kind: "seek" as const,
      index: "created" as const,
      collection: "c",
      author: null,
      field: null,
      value: null,
      range: null,
      descending: false,
      fetch: 21,
      limit: 20,
      after: null,
      ...overrides,
    });
    const doc = { author: "v", created: 10, id: "m", values: { n: "1" } };
    expect(planMatches(plan({}), doc)).toBe(true);
    expect(planMatches(plan({ author: "w" }), doc)).toBe(false);
    expect(planMatches(plan({ author: "v" }), doc)).toBe(true);
    expect(planMatches(plan({ field: "n", value: "2" }), doc)).toBe(false);
    expect(planMatches(plan({ field: "n", value: "1" }), doc)).toBe(true);
    const ranges = [
      ["gt", 10, false],
      ["gt", 9, true],
      ["gte", 10, true],
      ["gte", 11, false],
      ["lt", 10, false],
      ["lt", 11, true],
      ["lte", 10, true],
      ["lte", 9, false],
    ] as const;
    for (const [op, at, expected] of ranges)
      expect(planMatches(plan({ range: { op, value: at } }), doc), `${op} ${at}`).toBe(expected);
    expect(planMatches(plan({ after: [10, "l"] }), doc)).toBe(true);
    expect(planMatches(plan({ after: [10, "m"] }), doc)).toBe(false);
    expect(planMatches(plan({ after: [10, "n"], descending: true }), doc)).toBe(true);
    expect(planMatches(plan({ after: [10, "m"], descending: true }), doc)).toBe(false);
    expect([
      compareKeys([1, "a"], [2, "a"]),
      compareKeys([2, "a"], [1, "b"]),
      compareKeys([1, "a"], [1, "b"]),
      compareKeys([1, "b"], [1, "a"]),
      compareKeys([1, "a"], [1, "a"]),
    ]).toEqual([-1, 1, -1, 1, 0]);
    expect(
      pageOf(
        [
          { created: 1, id: "a" },
          { created: 2, id: "b" },
        ],
        1,
      ),
    ).toEqual({ rows: [{ created: 1, id: "a" }], next: encodeCursor(1, "a") });
    expect(pageOf([{ created: 1, id: "a" }], 1)).toEqual({
      rows: [{ created: 1, id: "a" }],
      next: null,
    });
    expect(pageOf([], 1)).toEqual({ rows: [], next: null });
  });
});

describe("index builds", () => {
  const field = (collection: string, name: string, state: "building" | "ready" = "building") => ({
    collection,
    field: name,
    state,
    cursor: null,
  });
  it("steps the first building field and ends when a step covers less than the cap", () => {
    expect(nextBuild([])).toBeNull();
    expect(nextBuild([field("b", "x", "ready")])).toBeNull();
    expect(
      nextBuild([field("b", "a"), field("a", "z"), field("a", "c", "ready"), field("a", "y")]),
    ).toEqual(field("a", "y"));
    const full = Array.from(
      { length: ARTIFACT_DATA.caps.indexStepDocuments },
      (_, index) => `d${index}`,
    );
    expect(afterStep(field("a", "x"), full)).toEqual({ ...field("a", "x"), cursor: full.at(-1) });
    expect(afterStep(field("a", "x"), full.slice(1))).toEqual(field("a", "x", "ready"));
    expect(afterStep(field("a", "x"), [])).toEqual(field("a", "x", "ready"));
    const fields = [field("a", "x", "ready"), field("a", "y"), field("b", "z", "ready")];
    expect(readyFields(fields, "a")).toEqual(["x"]);
    expect(declaredFields(fields, "a")).toEqual(["x", "y"]);
  });
});

describe("author erasure rules", () => {
  it("refuses barred paths and bounds chunks", () => {
    expect(barrierRefusal({ kind: "own_command" })).toEqual(
      refuse("forbidden", "this author's data was erased"),
    );
    expect(barrierRefusal({ kind: "settle" })).toMatchObject({ code: "forbidden" });
    expect(barrierRefusal({ kind: "edit_created_by" })).toEqual(
      refuse("conflict", "this document's creator is being erased"),
    );
    expect([
      chunkSize(0),
      chunkSize(1),
      chunkSize(2.7),
      chunkSize(Number.NaN),
      chunkSize(501),
      chunkSize(-3),
    ]).toEqual([1, 1, 2, 1, 500, 1]);
    const none = { documents: 0, edits: 0, operations: 0, rates: 0, rights: 0 };
    expect(chunkLeavesMore(none, 3)).toBe(false);
    for (const part of ["documents", "edits", "operations", "rates", "rights"] as const) {
      expect(chunkLeavesMore({ ...none, [part]: 3 }, 3)).toBe(true);
      expect(chunkLeavesMore({ ...none, [part]: 2 }, 3)).toBe(false);
    }
    expect([
      completes({ created: 0, edited: 0, rights: 0 }),
      completes({ created: 0, edited: 0, rights: 1 }),
      completes({ created: 1, edited: 0, rights: 0 }),
      completes({ created: 0, edited: 1, rights: 0 }),
    ]).toEqual([true, false, false, false]);
  });
});

describe("live", () => {
  const attachmentInput = {
    socketId: "s",
    author: "v",
    principal: "p",
    generation: 2,
    liveEpoch: 0,
    deadline: NOW + 60_000,
    now: NOW,
    limits: ROOMY,
  };
  const attachment: LiveAttachment = newAttachment(attachmentInput);
  it("admits connections within their bounds", () => {
    const input = {
      hasData: true,
      barred: false,
      deadline: NOW + 1,
      now: NOW,
      open: 0,
      openForAuthor: 0,
      limits: { ...FREE, connectionsPerArtifact: 2, connectionsPerAuthor: 1 },
    };
    expect(connectDecision(input)).toEqual({ ok: true, value: null });
    expect(connectDecision({ ...input, hasData: false })).toEqual(refuse("not_found", "no data"));
    expect(connectDecision({ ...input, barred: true })).toEqual(
      refuse("forbidden", "this author's data was erased"),
    );
    expect(connectDecision({ ...input, deadline: NOW })).toEqual(
      refuse("forbidden", "the connection's deadline is not valid"),
    );
    expect(connectDecision({ ...input, deadline: NOW + ARTIFACT_DATA.live.deadlineMs }).ok).toBe(
      true,
    );
    expect(
      connectDecision({ ...input, deadline: NOW + ARTIFACT_DATA.live.deadlineMs + 1 }).ok,
    ).toBe(false);
    expect(connectDecision({ ...input, open: 1 }).ok).toBe(true);
    expect(connectDecision({ ...input, open: 2 })).toEqual(
      refuse("rate_limited", "too many connections"),
    );
    expect(connectDecision({ ...input, openForAuthor: 1 })).toEqual(
      refuse("rate_limited", "too many connections"),
    );
    expect(attachment).toEqual({
      socketId: "s",
      author: "v",
      principal: "p",
      generation: 2,
      liveEpoch: 0,
      subscriptions: [],
      deadline: NOW + 60_000,
      window: minuteOf(NOW),
      messagesIn: 0,
      bytesOut: 0,
      reserved: 0,
      reservedDay: dayOf(NOW),
      liveMessagesPerDay: ROOMY.liveMessagesPerDay,
    });
  });

  it("re-admits against the control record and the deadline", () => {
    const control = { ...newControl(envelope({ generation: 2 }), NOW) };
    expect(liveCheck(control, attachment, false, NOW)).toEqual({ attachment });
    expect(liveCheck(control, attachment, false, NOW + 60_000)).toEqual({ close: 4001 });
    expect(liveCheck(control, attachment, true, NOW)).toEqual({ close: 4410 });
    expect(liveCheck(null, attachment, false, NOW)).toEqual({ close: 4003 });
    expect(
      liveCheck({ ...control, hold: { transition: "t", epoch: 1 } }, attachment, false, NOW),
    ).toEqual({ close: 4003 });
    expect(
      liveCheck({ ...control, quarantine: { reason: "owner", at: 1 } }, attachment, false, NOW),
    ).toEqual({ close: 4003 });
    expect(
      liveCheck(
        { ...control, erasing: { id: id(), generation: 2, epoch: 0 } },
        attachment,
        false,
        NOW,
      ),
    ).toEqual({ close: 4003 });
    expect(liveCheck({ ...control, generation: 3 }, attachment, false, NOW)).toEqual({
      close: 4003,
    });
    const busy = { ...attachment, messagesIn: 3, bytesOut: 9, deadline: NOW + 120_000 };
    expect(liveCheck(control, busy, false, NOW + 59_999)).toEqual({ attachment: busy });
    expect(liveCheck(control, busy, false, NOW + 60_000)).toEqual({
      attachment: { ...busy, window: minuteOf(NOW) + 1, messagesIn: 0, bytesOut: 0 },
    });
  });

  it("closes a connection opened before any later closing transition, so a lost close never outlives it", () => {
    const base = envelope({ generation: 2 });
    const control = newControl(base, NOW);
    expect(liveCheck(control, attachment, false, NOW)).toEqual({ attachment });
    // Every transition that closes connections raises the live epoch, even when it leaves no
    // other trace the check could see (a release after a hold, a transfer, an adopted quarantine).
    const fenced = applyFence(control, base, { kind: "epoch", transition: "e1" }, NOW);
    const transferred = applyFence(
      control,
      base,
      { kind: "transfer", toOwner: "owner_b", transition: "m1" },
      NOW,
    );
    const quarantined = quarantine(control, base, "owner", NOW);
    expect(fenced.ok && transferred.ok && quarantined.ok).toBe(true);
    const adopted = resolveQuarantine(
      (quarantined as { value: { control: typeof control } }).value.control,
      base,
      "adopt",
    );
    const prepared = prepareErase(control, base, id(), null, NOW);
    for (const next of [fenced, transferred, quarantined, adopted, prepared]) {
      const after = (next as { ok: true; value: { control: typeof control } }).value.control;
      expect(after.liveEpoch).toBe(control.liveEpoch + (next === adopted ? 2 : 1));
      expect(
        liveCheck({ ...after, quarantine: null, erasing: null }, attachment, false, NOW),
      ).toEqual({
        close: 4003,
      });
    }
    const prepare = (prepared as { ok: true; value: { control: typeof control } }).value.control;
    const erasing = prepare.erasing as { id: string };
    const committed = commitErase(prepare, base, erasing.id, null);
    const cancelled = cancelErase(prepare, base, erasing.id, null);
    expect(committed.ok && committed.value.control?.liveEpoch).toBe(prepare.liveEpoch + 1);
    expect(cancelled.ok && cancelled.value.control?.liveEpoch).toBe(prepare.liveEpoch);
    // A repeated fence and a refused one leave it.
    const once = (fenced as { ok: true; value: { control: typeof control } }).value.control;
    const repeat = applyFence(once, base, { kind: "epoch", transition: "e1" }, NOW);
    expect(repeat.ok && repeat.value.control.liveEpoch).toBe(once.liveEpoch);
    expect(newAttachment({ ...attachmentInput, liveEpoch: once.liveEpoch }).liveEpoch).toBe(
      once.liveEpoch,
    );
  });

  it("renews only for the same principal, up to the longest deadline", () => {
    expect(renewDecision(attachment, "q", NOW + 1, NOW, FREE)).toEqual({ refused: true });
    expect(renewDecision(attachment, "p", NOW, NOW, FREE)).toEqual({ close: 4001 });
    expect(
      renewDecision(attachment, "p", NOW + ARTIFACT_DATA.live.deadlineMs + 1, NOW, FREE),
    ).toEqual({ refused: true });
    expect(renewDecision(attachment, "p", NOW + 5, NOW, FREE)).toEqual({
      attachment: { ...attachment, deadline: NOW + 5, liveMessagesPerDay: FREE.liveMessagesPerDay },
    });
  });

  it("bounds messages in and out, reserving before sending", () => {
    expect(inbound(attachment, ARTIFACT_DATA.live.messageBytes)).toEqual({
      attachment: { ...attachment, messagesIn: 1 },
    });
    expect(inbound(attachment, ARTIFACT_DATA.live.messageBytes + 1)).toEqual({ close: 4008 });
    expect(
      inbound({ ...attachment, messagesIn: ARTIFACT_DATA.live.messagesInPerMinute - 1 }, 1),
    ).toMatchObject({ attachment: {} });
    expect(
      inbound({ ...attachment, messagesIn: ARTIFACT_DATA.live.messagesInPerMinute }, 1),
    ).toEqual({ close: 4008 });
    expect(outbound(attachment, 10, null, NOW)).toEqual({ reserve: true });
    expect(outbound(attachment, 10, 0, NOW)).toEqual({ close: 4029 });
    expect(outbound(attachment, 10, 5, NOW)).toEqual({
      attachment: { ...attachment, bytesOut: 10, reserved: 4 },
    });
    expect(outbound({ ...attachment, reserved: 1 }, 10, null, NOW)).toEqual({
      attachment: { ...attachment, bytesOut: 10, reserved: 0 },
    });
    expect(
      outbound(
        { ...attachment, reserved: 1, bytesOut: ARTIFACT_DATA.live.bytesOutPerMinute - 10 },
        10,
        null,
        NOW,
      ),
    ).toMatchObject({ attachment: {} });
    expect(
      outbound(
        { ...attachment, reserved: 1, bytesOut: ARTIFACT_DATA.live.bytesOutPerMinute - 9 },
        10,
        null,
        NOW,
      ),
    ).toEqual({ close: 4009 });
  });

  it("subscribes up to the cap and fans out by mode", () => {
    let current = attachment;
    for (let index = 0; index < 30; index++) current = subscribed(current, `c${index % 25}`);
    expect(current.subscriptions).toHaveLength(ARTIFACT_DATA.live.subscriptions);
    expect(subscribed(subscribed(attachment, "x"), "x").subscriptions).toEqual(["x"]);
    const listening = subscribed(attachment, "c");
    expect(receives(listening, "c", "own", "v")).toBe(true);
    expect(receives(listening, "c", "own", "w")).toBe(false);
    expect(receives(listening, "c", "append", "w")).toBe(true);
    expect(receives(listening, "d", "append", "w")).toBe(false);
    expect(receives({ ...listening, author: null }, "c", "own", "w")).toBe(false);
  });
});

describe("export", () => {
  const row = (collection: string, rowId: string, body = '{"n":1}'): ExportDocument => ({
    collection,
    id: rowId,
    by: "v",
    editedBy: null,
    created: 1,
    updated: 2,
    body,
  });
  it("writes lines with the stored body spliced in", () => {
    expect(exportLine(row("c", "i", '{"x": 1.50}'))).toBe(
      '{"collection":"c","id":"i","by":"v","editedBy":null,"created":1,"updated":2,"body":{"x": 1.50}}\n',
    );
    expect(keyBefore({ collection: "a", id: "z" }, { collection: "b", id: "a" })).toBe(true);
    expect(keyBefore({ collection: "a", id: "a" }, { collection: "a", id: "b" })).toBe(true);
    expect(keyBefore({ collection: "a", id: "b" }, { collection: "a", id: "b" })).toBe(false);
    expect(keyBefore({ collection: "b", id: "a" }, { collection: "a", id: "z" })).toBe(false);
  });

  it("cuts pages by rows and bytes, a single large row still making a page", () => {
    const rows = ["a", "b", "c"].map((key) => row("c", key));
    expect(cutPage(rows, 2, 7)).toMatchObject({
      rows: rows.slice(0, 2),
      next: { collection: "c", id: "b" },
      revision: 7,
    });
    expect(cutPage(rows, 3, 7)).toMatchObject({ rows, next: null });
    expect(cutPage(rows, 0, 7).rows).toHaveLength(1);
    expect(cutPage([], 5, 1)).toEqual({ rows: [], next: null, revision: 1, bytes: 0 });
    const big = `{"pad":"${"x".repeat(ARTIFACT_DATA.caps.exportBytes)}"}`;
    const page = cutPage([row("c", "a", big), row("c", "b")], 10, 1);
    expect(page.rows).toHaveLength(1);
    expect(page.next).toEqual({ collection: "c", id: "a" });
    const line = exportLine(rows[0] as ExportDocument).length;
    const fits = Math.floor(ARTIFACT_DATA.caps.exportBytes / line);
    const many = Array.from({ length: fits + 1 }, (_, index) =>
      row("c", `k${index.toString().padStart(6, "0")}`),
    );
    const exact = cutPage(
      many.map((item) => ({ ...item, id: item.id })),
      500,
      1,
    );
    expect(exact.bytes).toBeLessThanOrEqual(ARTIFACT_DATA.caps.exportBytes);
    expect(
      cutPage(
        Array.from({ length: 600 }, (_, index) => row("c", `${index}`)),
        9_999,
        1,
      ).rows,
    ).toHaveLength(500);
  });

  it("parses its own files and refuses broken, reordered, incomplete or newer ones", () => {
    const header = exportHeader({
      artifact: "abcdefgh23",
      generation: 0,
      revision: 3,
      collections: [],
    });
    const lines = [row("a", "aaaaaaaaaaaaaaa1"), row("a", "aaaaaaaaaaaaaaa2")]
      .map(exportLine)
      .join("");
    const good = header + lines + exportFooter(3, 3, 2);
    expect(parseExportFile(good)).toMatchObject({
      ok: true,
      value: { header: { version: 1, revision: 3 }, footer: { consistent: true, documents: 2 } },
    });
    expect(parseExportFile(header + lines + exportFooter(3, 4, 2))).toMatchObject({
      value: { footer: { consistent: false, revision: 4 } },
    });
    expect(parseExportFile(`${header}nope\n`)).toEqual(
      refuse("invalid_input", "every line of an export is JSON"),
    );
    expect(parseExportFile(`{}\n${exportFooter(0, 0, 0)}`)).toEqual(
      refuse("invalid_input", "the export has no valid header"),
    );
    const newer = header.replace('"version":1', '"version":2');
    expect(parseExportFile(newer + exportFooter(3, 3, 0))).toEqual(
      refuse("invalid_input", "export version 2 is newer than this reader"),
    );
    expect(parseExportFile(header)).toEqual(refuse("invalid_input", "the export is incomplete"));
    expect(parseExportFile(header + lines)).toEqual(
      refuse("invalid_input", "the export is incomplete"),
    );
    expect(parseExportFile(header + lines + exportFooter(3, 3, 3))).toEqual(
      refuse("invalid_input", "the export is incomplete"),
    );
    const reversed = [row("a", "aaaaaaaaaaaaaaa2"), row("a", "aaaaaaaaaaaaaaa1")]
      .map(exportLine)
      .join("");
    expect(parseExportFile(header + reversed + exportFooter(3, 3, 2))).toEqual(
      refuse("invalid_input", "the export's documents are out of order"),
    );
    expect(parseExportFile(`${header}{"collection":"a"}\n${exportFooter(3, 3, 1)}`)).toEqual(
      refuse("invalid_input", "the export has an invalid document line"),
    );
    expect(parseExportFile((header + exportFooter(3, 3, 0)).trimEnd())).toMatchObject({ ok: true });
  });
});

describe("housekeeping", () => {
  const control = newControl(envelope(), NOW);
  it("prunes only an open object, by each class's age", () => {
    expect(pruneAllowed(null)).toBe(false);
    expect(pruneAllowed(control)).toBe(true);
    expect(pruneAllowed({ ...control, hold: { transition: "t", epoch: 0 } })).toBe(false);
    expect(pruneAllowed({ ...control, quarantine: { reason: "owner", at: 0 } })).toBe(false);
    expect(pruneCutoffs(NOW)).toEqual({
      operationsBefore: NOW - ARTIFACT_DATA.replayMs,
      deliveredBefore: NOW - ARTIFACT_DATA.deliveredMs,
      rateWindowBefore: minuteOf(NOW) - ARTIFACT_DATA.rateKeepMinutes,
      dayBefore: dayOf(NOW) - ARTIFACT_DATA.dayKeepDays,
    });
    expect(passLeftMore([0, ARTIFACT_DATA.caps.pruneRows - 1])).toBe(false);
    expect(passLeftMore([0, ARTIFACT_DATA.caps.pruneRows])).toBe(true);
  });

  it("sets the next alarm at the earliest eligible moment, never sooner than the floor", () => {
    const none = { operation: null, delivered: null, rateWindow: null, day: null };
    const input = {
      control,
      deadlines: [] as number[],
      oldest: none,
      more: false,
      pendingFlushAt: null as number | null,
      now: NOW,
    };
    expect(nextAlarm(input)).toBeNull();
    expect(nextAlarm({ ...input, deadlines: [NOW + 5_000, NOW + 4_000] })).toBe(NOW + 4_000);
    expect(nextAlarm({ ...input, deadlines: [NOW] })).toBe(NOW + ARTIFACT_DATA.alarmFloorMs);
    expect(nextAlarm({ ...input, more: true })).toBe(NOW + ARTIFACT_DATA.morePruneMs);
    const hour = ARTIFACT_DATA.alarmBatchMs;
    const up = (due: number) => Math.ceil(due / hour) * hour;
    expect(nextAlarm({ ...input, oldest: { ...none, operation: NOW } })).toBe(
      up(NOW + ARTIFACT_DATA.replayMs + 1),
    );
    expect(nextAlarm({ ...input, oldest: { ...none, delivered: NOW } })).toBe(
      up(NOW + ARTIFACT_DATA.deliveredMs + 1),
    );
    const minute = minuteOf(NOW);
    expect(nextAlarm({ ...input, oldest: { ...none, rateWindow: minute } })).toBe(
      up((minute + ARTIFACT_DATA.rateKeepMinutes + 1) * 60_000),
    );
    const day = dayOf(NOW);
    expect(nextAlarm({ ...input, oldest: { ...none, day } })).toBe(
      (day + ARTIFACT_DATA.dayKeepDays + 1) * 86_400_000,
    );
    expect([batched(hour), batched(hour + 1), batched(1)]).toEqual([hour, 2 * hour, hour]);
    expect(nextAlarm({ ...input, pendingFlushAt: NOW + 30_000 })).toBe(NOW + 30_000);
    expect(
      nextAlarm({
        ...input,
        pendingFlushAt: NOW + 30_000,
        oldest: { ...none, operation: NOW - ARTIFACT_DATA.replayMs },
      }),
    ).toBe(NOW + 30_000);
    const held = {
      ...input,
      control: { ...control, hold: { transition: "t", epoch: 0 } },
      more: true,
      oldest: { operation: NOW, delivered: NOW, rateWindow: minute, day },
    };
    expect(nextAlarm(held)).toBeNull();
    expect(nextAlarm({ ...held, pendingFlushAt: NOW + 30_000 })).toBeNull();
    expect(nextAlarm({ ...held, deadlines: [NOW + 9_000] })).toBe(NOW + 9_000);
    // Each class's moment is when its oldest row passes the cutoff the alarm then uses.
    const due = NOW + ARTIFACT_DATA.replayMs + 1;
    expect(pruneCutoffs(due).operationsBefore).toBeGreaterThan(NOW);
    expect(
      pruneCutoffs((minute + ARTIFACT_DATA.rateKeepMinutes + 1) * 60_000).rateWindowBefore,
    ).toBeGreaterThan(minute);
    expect(
      pruneCutoffs((day + ARTIFACT_DATA.dayKeepDays + 1) * 86_400_000).dayBefore,
    ).toBeGreaterThan(day);
  });
});

describe("journal and grants", () => {
  const entry: JournalEntry = { visitorId: "v_aaaaaaaaaaaaaaaa", firstGrantAt: NOW };
  it("claims, retires and prunes by the one retention rule", () => {
    expect(journalKey("u", "a")).toBe("system/data-authors/u/a");
    expect(claimOutcome(null, "v_new")).toEqual({ ok: true, value: "v_new" });
    expect(claimOutcome(entry, "v_new")).toEqual({ ok: true, value: entry.visitorId });
    expect(claimOutcome({ ...entry, retiredAt: NOW }, "v_new")).toEqual(
      refuse("forbidden", "this account's data in this artifact was erased"),
    );
    expect(claimOutcome({ visitorId: null, firstGrantAt: NOW }, "v_new")).toMatchObject({
      code: "forbidden",
    });
    expect(retired(entry, NOW)).toEqual({ ...entry, retiredAt: NOW });
    expect(retired({ ...entry, retiredAt: 5 }, NOW)).toEqual({ ...entry, retiredAt: 5 });
    expect(retired(null, NOW)).toEqual({ visitorId: null, firstGrantAt: NOW, retiredAt: NOW });
    expect(journalPrunable(entry, NOW + 10 * ARTIFACT_DATA.journalRetiredMs)).toBe(false);
    expect(
      journalPrunable({ ...entry, retiredAt: NOW }, NOW + ARTIFACT_DATA.journalRetiredMs - 1),
    ).toBe(false);
    expect(
      journalPrunable({ ...entry, retiredAt: NOW }, NOW + ARTIFACT_DATA.journalRetiredMs),
    ).toBe(true);
  });

  it("gates the API, the start and the redemption by fetch metadata", () => {
    const h = (values: Record<string, string>) => new Headers(values);
    const origin = "https://abcdefgh23.portifact.dev";
    expect(apiGate(h({ "Sec-Fetch-Site": "same-origin" }), origin, false)).toBe("allowed");
    expect(apiGate(h({}), origin, false)).toBe("refused");
    expect(
      apiGate(
        h({
          "Sec-Fetch-Site": "same-origin",
          Origin: origin,
          "Content-Type": "Application/JSON; charset=utf-8",
        }),
        origin,
        true,
      ),
    ).toBe("allowed");
    expect(
      apiGate(
        h({ "Sec-Fetch-Site": "same-origin", Origin: origin, "Content-Type": "text/plain" }),
        origin,
        true,
      ),
    ).toBe("refused");
    expect(
      apiGate(
        h({ "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }),
        origin,
        true,
      ),
    ).toBe("refused");
    expect(apiGate(h({ "Sec-Fetch-Site": "same-origin", Origin: origin }), origin, true)).toBe(
      "refused",
    );
    expect(
      apiGate(h({ "Sec-Fetch-Site": "same-origin", Upgrade: "WebSocket" }), origin, false),
    ).toBe("refused");
    expect(
      apiGate(
        h({ "Sec-Fetch-Site": "same-origin", Upgrade: "websocket", Origin: origin }),
        origin,
        false,
      ),
    ).toBe("allowed");
    const nav = (site: string, dest: string, mode = "navigate") =>
      h({ "Sec-Fetch-Mode": mode, "Sec-Fetch-Site": site, "Sec-Fetch-Dest": dest });
    expect(beginGate("POST", nav("same-origin", "document"))).toBe("refused");
    expect(beginGate("GET", nav("same-origin", "document", "cors"))).toBe("refused");
    expect(beginGate("GET", nav("same-origin", "iframe"))).toBe("refused");
    expect(beginGate("GET", nav("cross-site", "document"))).toBe("refused");
    expect(redeemGate("GET", nav("cross-site", "iframe"), "frame")).toBe("allowed");
    expect(redeemGate("GET", nav("cross-site", "document"), "frame")).toBe("refused");
    expect(redeemGate("GET", nav("cross-site", "iframe"), "top")).toBe("refused");
    expect(redeemGate("POST", nav("cross-site", "document"), "top")).toBe("refused");
    expect(redeemGate("GET", nav("cross-site", "document", "no-cors"), "top")).toBe("refused");
  });

  it("redeems a code only unused, unexpired, on its host, in its browser", () => {
    const pending = {
      codeHash: "c",
      nonceHash: "n",
      host: "h",
      grantId: "g",
      expiresAt: NOW + 1,
      used: false,
    };
    const presented = { codeHash: "c", nonceHash: "n", host: "h" };
    expect(redeemable(pending, presented, NOW)).toBe(true);
    expect(redeemable(null, presented, NOW)).toBe(false);
    expect(redeemable(pending, presented, NOW + 1)).toBe(false);
    expect(redeemable(pending, { ...presented, codeHash: "x" }, NOW)).toBe(false);
    expect(redeemable(pending, { ...presented, host: "x" }, NOW)).toBe(false);
    expect(redeemable(pending, { ...presented, nonceHash: null }, NOW)).toBe(false);
  });
});

describe("pipelines", () => {
  const control = newControl(envelope(), NOW);
  const e = envelope();
  it("plans reads: empty objects, the caller's minute, the barrier and the read class", () => {
    const input = {
      stored: control,
      envelope: e,
      caller: visitor("a"),
      limits: { ...FREE, readsPerCallerPerMinute: 2, rowsReadPerDay: 10 },
      callerReads: 2,
      used: 9,
      barred: false,
    };
    expect(planRead(input)).toEqual({ decision: "proceed" });
    expect(planRead({ ...input, stored: null })).toEqual({ decision: "empty" });
    expect(planRead({ ...input, envelope: { ...e, region: "eu" } })).toMatchObject({
      decision: "refused",
      refusal: { code: "forbidden" },
    });
    expect(planRead({ ...input, callerReads: 3 })).toEqual({
      decision: "refused",
      refusal: refuse("rate_limited", "too many reads, try again in a minute"),
    });
    expect(planRead({ ...input, caller: OWNER, callerReads: 3 })).toEqual({ decision: "proceed" });
    expect(planRead({ ...input, used: 10 })).toMatchObject({ refusal: { code: "quota_exceeded" } });
    expect(planRead({ ...input, barred: true })).toMatchObject({ refusal: { code: "forbidden" } });
  });

  it("plans exports by who asks", () => {
    const input = {
      stored: control,
      envelope: e,
      who: "owner" as const,
      limits: { ...FREE, exportRowsPerDay: 10, rightsRowsPerDay: 5 },
      used: () => 9,
      barred: false,
    };
    expect(planExport(input)).toEqual({ decision: "proceed", charge: "export" });
    expect(
      planExport({ ...input, who: "visitor", used: (charge) => (charge === "rights" ? 4 : 99) }),
    ).toEqual({ decision: "proceed", charge: "rights" });
    expect(
      planExport({ ...input, who: "visitor", used: (charge) => (charge === "rights" ? 5 : 0) }),
    ).toMatchObject({ refusal: { code: "rate_limited" } });
    expect(planExport({ ...input, who: "visitor", barred: true })).toMatchObject({
      refusal: { code: "forbidden" },
    });
    expect(planExport({ ...input, who: "owner", barred: true })).toEqual({
      decision: "proceed",
      charge: "export",
    });
    expect(planExport({ ...input, used: () => 10 })).toMatchObject({
      refusal: { code: "rate_limited" },
    });
    expect(planExport({ ...input, who: "operator", used: () => 99 })).toEqual({
      decision: "proceed",
      charge: "export",
    });
    const held = { ...control, hold: { transition: "t", epoch: 0 } };
    expect(planExport({ ...input, stored: held })).toMatchObject({ refusal: { code: "held" } });
    expect(planExport({ ...input, stored: held, who: "operator" })).toMatchObject({
      decision: "proceed",
    });
    expect(planExport({ ...input, stored: null })).toEqual({ decision: "empty" });
  });

  it("plans connections", () => {
    const input = {
      stored: control,
      envelope: e,
      barred: false,
      deadline: NOW + 1,
      now: NOW,
      open: 0,
      openForAuthor: 0,
      limits: { ...FREE, rowsWrittenPerDay: 10, connectsPerAuthorPerMinute: 2 },
      usedGrowth: 9,
      connectsThisMinute: 1,
    };
    expect(planConnect(input)).toBeNull();
    expect(planConnect({ ...input, stored: null })).toMatchObject({ code: "not_found" });
    expect(planConnect({ ...input, envelope: { ...e, epoch: 0, ownerId: "x" } })).toMatchObject({
      code: "stale",
    });
    expect(planConnect({ ...input, usedGrowth: 10 })).toMatchObject({ code: "quota_exceeded" });
    expect(planConnect({ ...input, connectsThisMinute: 2 })).toMatchObject({
      code: "rate_limited",
    });
    expect(planConnect({ ...input, barred: true })).toMatchObject({ code: "forbidden" });
  });

  it("meters every terminal outcome through one path", () => {
    const today = dayOf(NOW);
    const days = new Map([[today - 1, { ...emptyDay(today - 1), read: 1 }]]);
    const day = (d: number) => days.get(d) ?? emptyDay(d);
    const cost = { rowsRead: 1, rowsWritten: 2 };
    const pending = { day: today, rows: 3, refused: 1, since: NOW, deferred: 0 };
    expect(
      meter({
        terminal: { kind: "charged", charge: "growth" },
        cost,
        pending,
        day,
        bound: true,
        now: NOW,
      }),
    ).toEqual({
      days: [{ ...emptyDay(today), growth: 7, read: 3, refused: 1 }],
      rights: null,
      pending: noPendingReads(NOW),
    });
    expect(
      meter({
        terminal: { kind: "charged", charge: "rights", author: "v" },
        cost,
        pending,
        day,
        rightsUsed: 10,
        bound: true,
        now: NOW,
      }).rights,
    ).toEqual({ author: "v", used: 17 });
    expect(
      meter({
        terminal: { kind: "charged", charge: "rights", author: null },
        cost,
        pending,
        day,
        bound: true,
        now: NOW,
      }).rights,
    ).toBeNull();
    expect(
      meter({
        terminal: { kind: "charged", charge: "protected" },
        cost,
        pending,
        day,
        bound: false,
        now: NOW,
      }),
    ).toEqual({
      days: [],
      rights: null,
      pending: { ...pending, rows: 6 },
    });
    expect(
      meter({
        terminal: { kind: "uncharged", refused: true },
        cost,
        pending,
        day,
        bound: true,
        now: NOW + 1,
      }),
    ).toEqual({
      days: [],
      rights: null,
      pending: { ...pending, rows: 6, refused: 2 },
    });
    const due = meter({
      terminal: { kind: "uncharged", refused: false },
      cost,
      pending,
      day,
      bound: true,
      now: NOW + ARTIFACT_DATA.readFlush.ms,
    });
    expect(due.days).toEqual([
      { ...emptyDay(today), read: 6, refused: 1, protected: COUNTER_WRITE_ROWS },
    ]);
    expect(due.pending).toEqual(noPendingReads(NOW + ARTIFACT_DATA.readFlush.ms));
    const yesterday = { day: today - 1, rows: 4, refused: 0, since: NOW - 86_400_000, deferred: 0 };
    const rolled = meter({
      terminal: { kind: "uncharged", refused: false },
      cost,
      pending: yesterday,
      day,
      bound: true,
      now: NOW,
    });
    expect(rolled.days).toEqual([
      { ...emptyDay(today - 1), read: 5, protected: COUNTER_WRITE_ROWS },
    ]);
    expect(rolled.pending).toEqual({ day: today, rows: 3, refused: 0, since: NOW, deferred: 0 });
    const unbound = meter({
      terminal: { kind: "uncharged", refused: false },
      cost,
      pending: yesterday,
      day,
      bound: false,
      now: NOW,
    });
    expect(unbound).toEqual({
      days: [],
      rights: null,
      pending: { ...yesterday, day: today, rows: 7 },
    });
    // An alarm's pruning is deferred, with no counter write of its own.
    expect(
      meter({ terminal: { kind: "housekeeping" }, cost, pending, day, bound: true, now: NOW }),
    ).toEqual({ days: [], rights: null, pending: { ...pending, deferred: 3 } });
  });

  it("flushes pending usage but never deferred usage alone, across midnight included", () => {
    const today = dayOf(NOW);
    const day = (d: number) => emptyDay(d);
    const deferredOnly = { ...noPendingReads(NOW), deferred: 9 };
    expect(flushPending({ pending: deferredOnly, day, bound: true, now: NOW })).toEqual({
      days: [],
      pending: deferredOnly,
    });
    const tomorrow = NOW + 86_400_000;
    expect(flushPending({ pending: deferredOnly, day, bound: true, now: tomorrow })).toEqual({
      days: [],
      pending: { ...noPendingReads(tomorrow), deferred: 9 },
    });
    const withReads = { ...deferredOnly, rows: 2 };
    expect(flushPending({ pending: withReads, day, bound: true, now: NOW })).toEqual({
      days: [{ ...emptyDay(today), read: 2, protected: 9 + COUNTER_WRITE_ROWS }],
      pending: noPendingReads(NOW),
    });
    expect(flushPending({ pending: withReads, day, bound: false, now: NOW })).toEqual({
      days: [],
      pending: withReads,
    });
  });

  it("orders storage reports", () => {
    expect(newerReport(null, { generation: 0, seq: 0, bytes: 0 })).toBe(true);
    expect(
      newerReport({ generation: 1, seq: 0, bytes: 0 }, { generation: 1, seq: 1, bytes: 0 }),
    ).toBe(true);
  });
});

export type { DataEnvelope };
