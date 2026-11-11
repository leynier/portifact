import { AUDIT_STREAM } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildStreamBatch,
  classifyStreamAttempt,
  deliveredThrough,
  gapLine,
  needsAttention,
  nextStreamAttemptAt,
  parseRetryAfter,
  type StreamLine,
  settledBefore,
  statusClass,
  streamBatchKey,
  streamCutoff,
  streamRead,
  testLine,
} from "./audit-streams.ts";

const NOW = Date.UTC(2026, 10, 8, 12, 34, 56);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const line = (at: number, id: string, text = `{"id":"${id}"}\n`): StreamLine => ({
  at,
  id,
  line: text,
});

describe("where a stream reads", () => {
  it("rounds the retention cutoff down to the hour, so a retried batch keeps its start", () => {
    const cutoff = streamCutoff(90, NOW);
    expect(cutoff % HOUR).toBe(0);
    expect(cutoff).toBeLessThanOrEqual(NOW - 90 * DAY);
    expect(cutoff).toBeGreaterThan(NOW - 90 * DAY - HOUR);
    expect(streamCutoff(90, NOW + 1_000)).toBe(cutoff);
  });

  it("sends only settled events", () => {
    expect(settledBefore(NOW)).toBe(NOW - AUDIT_STREAM.settleMs);
  });

  it.each([
    [
      "a backfill starts at the cutoff with no gap",
      { at: null, id: "" },
      { at: 100, id: "" },
      null,
    ],
    [
      "a position after the cutoff reads on",
      { at: 150, id: "ae_x" },
      { at: 150, id: "ae_x" },
      null,
    ],
    ["a position at the cutoff reads on", { at: 100, id: "" }, { at: 100, id: "" }, null],
    [
      "a position past retention says so and skips to the cutoff",
      { at: 40, id: "ae_y" },
      { at: 100, id: "" },
      { from: 40, to: 100 },
    ],
  ])("%s", (_name, position, after, gap) => {
    expect(streamRead(position, 100)).toEqual({ after, gap });
  });
});

describe("building a batch", () => {
  it("is null when there is nothing to say", () => {
    expect(buildStreamBatch({ source: "regional", gap: null, lines: [] })).toBeNull();
  });

  it("puts the gap line first, then the events in order, and ends at the last event", () => {
    const batch = buildStreamBatch({
      source: "global",
      gap: { from: 0, to: DAY },
      lines: [line(DAY + 1, "ae_a"), line(DAY + 2, "ae_b")],
    });
    expect(batch?.body.split("\n").filter(Boolean)).toEqual([
      JSON.stringify({
        record: "gap",
        source: "global",
        from: new Date(0).toISOString(),
        to: new Date(DAY).toISOString(),
        reason: "retention",
      }),
      '{"id":"ae_a"}',
      '{"id":"ae_b"}',
    ]);
    expect(batch).toMatchObject({
      events: 2,
      first: { at: 0, id: "" },
      through: { at: DAY + 2, id: "ae_b" },
    });
  });

  it("ends a gap-only batch at the gap's end", () => {
    const batch = buildStreamBatch({ source: "regional", gap: { from: 5, to: 9 }, lines: [] });
    expect(batch).toMatchObject({
      events: 0,
      first: { at: 5, id: "" },
      through: { at: 9, id: "" },
    });
    expect(batch?.body).toBe(gapLine("regional", { from: 5, to: 9 }));
  });

  it("stops at the event bound and at the byte bound, but always sends one event", () => {
    const many = Array.from({ length: 10 }, (_, i) => line(i, `ae_${i}`));
    expect(
      buildStreamBatch({
        source: "regional",
        gap: null,
        lines: many,
        bounds: { events: 3, bytes: 1e6 },
      })?.events,
    ).toBe(3);
    const big = [line(1, "ae_big", `${"x".repeat(100)}\n`), line(2, "ae_next", "{}\n")];
    const one = buildStreamBatch({
      source: "regional",
      gap: null,
      lines: big,
      bounds: { events: 10, bytes: 10 },
    });
    expect(one).toMatchObject({ events: 1, through: { at: 1, id: "ae_big" } });
  });

  it("never exceeds its bounds after the first event, never reorders and never skips (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { maxLength: 30 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 400 }),
        (texts, events, bytes) => {
          const lines = texts.map((text, i) =>
            line(i, `ae_${String(i).padStart(3, "0")}`, `${text}\n`),
          );
          const batch = buildStreamBatch({
            source: "regional",
            gap: null,
            lines,
            bounds: { events, bytes },
          });
          if (lines.length === 0) return batch === null;
          if (!batch) return false;
          const size = new TextEncoder().encode(batch.body).byteLength;
          const taken = lines.slice(0, batch.events);
          return (
            batch.events >= 1 &&
            batch.events <= events &&
            (batch.events === 1 || size <= bytes) &&
            batch.body === taken.map((l) => l.line).join("") &&
            batch.through.id === taken.at(-1)?.id
          );
        },
      ),
    );
  });
});

describe("the batch key", () => {
  it("is stable for the same batch and differs for any other", async () => {
    const first = { at: 1, id: "ae_a" };
    const last = { at: 2, id: "ae_b" };
    const key = await streamBatchKey("as_1", "regional", first, last);
    expect(key).toMatch(/^asb_[0-9a-f]{32}$/);
    expect(await streamBatchKey("as_1", "regional", first, last)).toBe(key);
    for (const other of [
      await streamBatchKey("as_2", "regional", first, last),
      await streamBatchKey("as_1", "global", first, last),
      await streamBatchKey("as_1", "regional", { at: 1, id: "ae_z" }, last),
      await streamBatchKey("as_1", "regional", first, { at: 3, id: "ae_b" }),
    ]) {
      expect(other).not.toBe(key);
    }
  });
});

describe("the test line", () => {
  it("is marked as a test and carries nothing of the owner's", () => {
    expect(JSON.parse(testLine("ast_1", "as_1", NOW))).toEqual({
      record: "test",
      id: "ast_1",
      at: new Date(NOW).toISOString(),
      stream: "as_1",
    });
  });
});

describe("classifying an answer", () => {
  it.each([
    [200, "2xx", true, null],
    [204, "2xx", true, null],
    [301, "3xx", false, "redirect"],
    [308, "3xx", false, "redirect"],
    [400, "4xx", false, "refused"],
    [410, "4xx", false, "refused"],
    [500, "5xx", false, "refused"],
    [503, "5xx", false, "refused"],
  ])("%i is %s", (status, cls, delivered, error) => {
    expect(classifyStreamAttempt({ kind: "status", status }, NOW)).toMatchObject({
      delivered,
      statusClass: cls,
      error,
    });
  });

  it("names timeouts, certificates and unreachable endpoints", () => {
    expect(classifyStreamAttempt({ kind: "timeout" }, NOW).error).toBe("timeout");
    expect(
      classifyStreamAttempt({ kind: "network", message: "TLS certificate has expired" }, NOW).error,
    ).toBe("certificate");
    expect(classifyStreamAttempt({ kind: "network", message: "refused" }, NOW).error).toBe(
      "unreachable",
    );
    expect(classifyStreamAttempt({ kind: "network" }, NOW).error).toBe("unreachable");
  });

  it("honors Retry-After only on 429 and 503", () => {
    expect(
      classifyStreamAttempt({ kind: "status", status: 429, retryAfter: "120" }, NOW).retryAfterMs,
    ).toBe(120_000);
    expect(
      classifyStreamAttempt({ kind: "status", status: 503, retryAfter: "600" }, NOW).retryAfterMs,
    ).toBe(600_000);
    expect(
      classifyStreamAttempt({ kind: "status", status: 500, retryAfter: "600" }, NOW).retryAfterMs,
    ).toBeNull();
  });

  it("returns no class for a status outside HTTP's", () => {
    expect(statusClass(99)).toBeNull();
    expect(statusClass(600)).toBeNull();
  });
});

describe("Retry-After", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["soon", null],
    ["0", AUDIT_STREAM.retryAfterMinMs],
    ["90", 90_000],
    ["999999", AUDIT_STREAM.retryAfterMaxMs],
    [new Date(NOW + 10 * 60_000).toUTCString(), 10 * 60_000],
    [new Date(NOW - 60_000).toUTCString(), AUDIT_STREAM.retryAfterMinMs],
  ])("%s gives %s", (value, expected) => {
    expect(parseRetryAfter(value, NOW)).toBe(expected);
  });
});

describe("backoff and attention", () => {
  it("follows the delays, repeats the last, and prefers the endpoint's Retry-After", () => {
    const delays = AUDIT_STREAM.retryDelaysMs;
    expect(nextStreamAttemptAt(1, NOW)).toBe(NOW + delays[0]);
    expect(nextStreamAttemptAt(3, NOW)).toBe(NOW + delays[2]);
    expect(nextStreamAttemptAt(50, NOW)).toBe(NOW + (delays.at(-1) as number));
    expect(nextStreamAttemptAt(0, NOW)).toBe(NOW + delays[0]);
    expect(nextStreamAttemptAt(2, NOW, 1_234)).toBe(NOW + 1_234);
  });

  it("needs attention only after failing for the whole period", () => {
    expect(needsAttention(null, NOW)).toBe(false);
    expect(needsAttention(NOW - AUDIT_STREAM.attentionAfterMs + 1, NOW)).toBe(false);
    expect(needsAttention(NOW - AUDIT_STREAM.attentionAfterMs, NOW)).toBe(true);
  });

  it("delivered through is the older position, unknown while either is", () => {
    expect(deliveredThrough(null, 5)).toBeNull();
    expect(deliveredThrough(5, null)).toBeNull();
    expect(deliveredThrough(5, 9)).toBe(5);
  });
});
