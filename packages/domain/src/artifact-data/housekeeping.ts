// Housekeeping (decision 0026, "Housekeeping" and "Storage accounting"): what one alarm may prune,
// the cutoffs of each retained control class, and when the next alarm is due. Under a hold or a
// quarantine nothing is pruned and only connection deadlines set an alarm, so a held object with
// no connections sleeps; a release or a resolution re-arms it.
import { ARTIFACT_DATA, type DataControl } from "@portifact/contracts/artifact-data";
import { dayOf, minuteOf } from "./charging.ts";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Whether the object may prune now. */
export function pruneAllowed(control: DataControl | null): boolean {
  return control !== null && control.hold === null && control.quarantine === null;
}

/**
 * The cutoffs of one pass: operation records and ended erase intents older than `replayMs`,
 * delivered audit obligations older than `deliveredMs`, rate rows of minutes more than a day old
 * and day counters (with each visitor's rights rows of that day) more than `dayKeepDays` old. Each class is pruned through an index that leads
 * with its age, at most `pruneRows` a pass.
 */
export function pruneCutoffs(now: number) {
  return {
    operationsBefore: now - ARTIFACT_DATA.replayMs,
    deliveredBefore: now - ARTIFACT_DATA.deliveredMs,
    rateWindowBefore: minuteOf(now) - ARTIFACT_DATA.rateKeepMinutes,
    dayBefore: dayOf(now) - ARTIFACT_DATA.dayKeepDays,
  };
}

/** Whether a pass left more: some class deleted a full batch. */
export function passLeftMore(deleted: readonly number[]): boolean {
  return deleted.some((count) => count >= ARTIFACT_DATA.caps.pruneRows);
}

/** The oldest row of each retained class, as the age-leading indexes give them (null: none). */
export interface Oldest {
  operation: number | null;
  delivered: number | null;
  rateWindow: number | null;
  day: number | null;
}

/** A retention deadline rounded up to the batch window: one alarm prunes everything due by then. */
export function batched(due: number): number {
  return Math.ceil(due / ARTIFACT_DATA.alarmBatchMs) * ARTIFACT_DATA.alarmBatchMs;
}

/**
 * The next alarm: the earliest moment any eligible maintenance can run, never sooner than
 * `alarmFloorMs` from now; null when nothing is due. Connection deadlines are exact. When pruning
 * is allowed, pending usage is due at its flush deadline, a full pass comes back after
 * `morePruneMs`, and each retained class's oldest row is due when it reaches its age, rounded up
 * to the batch window (`batched`), so rows due within one window cost one alarm. Under a hold or a
 * quarantine only connection deadlines wake the object; pending usage is written with the next
 * write or the release.
 */
export function nextAlarm(input: {
  control: DataControl | null;
  deadlines: readonly number[];
  oldest: Oldest;
  more: boolean;
  /** When pending reads are due (`pendingDeadline`), or null. */
  pendingFlushAt: number | null;
  now: number;
}): number | null {
  const candidates = [...input.deadlines];
  if (pruneAllowed(input.control)) {
    const { operation, delivered, rateWindow, day } = input.oldest;
    if (input.pendingFlushAt !== null) candidates.push(input.pendingFlushAt);
    if (input.more) candidates.push(input.now + ARTIFACT_DATA.morePruneMs);
    if (operation !== null) candidates.push(batched(operation + ARTIFACT_DATA.replayMs + 1));
    if (delivered !== null) candidates.push(batched(delivered + ARTIFACT_DATA.deliveredMs + 1));
    if (rateWindow !== null) {
      candidates.push(batched((rateWindow + ARTIFACT_DATA.rateKeepMinutes + 1) * MINUTE_MS));
    }
    if (day !== null) candidates.push(batched((day + ARTIFACT_DATA.dayKeepDays + 1) * DAY_MS));
  }
  if (candidates.length === 0) return null;
  return Math.max(Math.min(...candidates), input.now + ARTIFACT_DATA.alarmFloorMs);
}
