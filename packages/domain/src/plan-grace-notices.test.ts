import {
  type GraceNoticeMark,
  type GraceNoticeMoment,
  type GraceSlot,
  PLAN_GRACE_MS,
  PLANS,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  graceNoticeDue,
  graceNoticeMoment,
  graceNoticeRank,
  graceNoticeStillDue,
  readGraceNotices,
} from "./plan-grace-notices.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 12);

function slot(from: number, until = from + PLAN_GRACE_MS): GraceSlot {
  return {
    plan: "pro",
    reason: "lowered",
    from,
    until,
    limits: {
      archiveMonths: PLANS.pro.limits.archiveMonths,
      retainedPreviousVersions: PLANS.pro.limits.retainedPreviousVersions,
      previousVersionRetentionDays: PLANS.pro.limits.previousVersionRetentionDays,
      accessLogRetentionDays: PLANS.pro.limits.accessLogRetentionDays,
      auditRetentionDays: PLANS.pro.limits.auditRetentionDays,
    },
    features: ["pin"],
  };
}

function record(slots: GraceSlot[] | string | null, marks: unknown = null) {
  return {
    plan: "free",
    seats: 1,
    validUntil: null,
    overrides: null,
    grace: typeof slots === "string" || slots === null ? slots : JSON.stringify(slots),
    graceNotices: marks,
  };
}

const mark = (held: GraceSlot, moment: GraceNoticeMoment): GraceNoticeMark => ({
  from: held.from,
  until: held.until,
  moment,
});

describe("the moment a hold has reached", () => {
  const held = slot(NOW);
  it.each([
    ["at the drop", NOW, "start"],
    ["with 15 days left", held.until - 15 * DAY, "start"],
    ["with exactly 14 days left", held.until - 14 * DAY, "two_weeks"],
    ["with 4 days left", held.until - 4 * DAY, "two_weeks"],
    ["with exactly 3 days left", held.until - 3 * DAY, "three_days"],
    ["with a minute left", held.until - 60_000, "three_days"],
    ["at its end", held.until, null],
    ["after its end", held.until + DAY, null],
  ] as const)("%s", (_, now, expected) => {
    expect(graceNoticeMoment(held, now)).toBe(expected);
  });

  it("ranks the moments from the start to the last days", () => {
    expect(graceNoticeRank("start")).toBe(0);
    expect(graceNoticeRank("two_weeks")).toBe(1);
    expect(graceNoticeRank("three_days")).toBe(2);
  });
});

describe("which email is due", () => {
  const held = slot(NOW);
  const cases: {
    name: string;
    slots: GraceSlot[];
    marks: GraceNoticeMark[];
    now: number;
    due: GraceNoticeMoment | null;
  }[] = [
    { name: "a new hold: the start", slots: [held], marks: [], now: NOW, due: "start" },
    {
      name: "the start already sent",
      slots: [held],
      marks: [mark(held, "start")],
      now: NOW + DAY,
      due: null,
    },
    {
      name: "14 days left after the start",
      slots: [held],
      marks: [mark(held, "start")],
      now: held.until - 14 * DAY,
      due: "two_weeks",
    },
    {
      name: "the 14-day email already sent",
      slots: [held],
      marks: [mark(held, "two_weeks")],
      now: held.until - 5 * DAY,
      due: null,
    },
    {
      name: "3 days left after the 14-day email",
      slots: [held],
      marks: [mark(held, "two_weeks")],
      now: held.until - 3 * DAY,
      due: "three_days",
    },
    {
      name: "everything sent",
      slots: [held],
      marks: [mark(held, "three_days")],
      now: held.until - DAY,
      due: null,
    },
    {
      name: "a late scan with 10 days left: only the 14-day email, no start",
      slots: [held],
      marks: [],
      now: held.until - 10 * DAY,
      due: "two_weeks",
    },
    {
      name: "a late scan with 2 days left: only the 3-day email",
      slots: [held],
      marks: [],
      now: held.until - 2 * DAY,
      due: "three_days",
    },
    {
      name: "the start sent, then the scan was down past 14 days: the 3-day email only",
      slots: [held],
      marks: [mark(held, "start")],
      now: held.until - DAY,
      due: "three_days",
    },
    {
      name: "a short hold (10 days from its drop): its first email is the 14-day one",
      slots: [slot(NOW, NOW + 10 * DAY)],
      marks: [],
      now: NOW,
      due: "two_weeks",
    },
    {
      name: "a short hold (2 days): the 3-day email only",
      slots: [slot(NOW, NOW + 2 * DAY)],
      marks: [],
      now: NOW,
      due: "three_days",
    },
    { name: "a hold that ended", slots: [held], marks: [], now: held.until, due: null },
    { name: "no grace", slots: [], marks: [], now: NOW, due: null },
  ];
  it.each(cases)("$name", ({ slots, marks, now, due }) => {
    expect(graceNoticeDue(record(slots, JSON.stringify(marks)), now)?.moment ?? null).toBe(due);
  });

  it("never sends a moment twice or after a later one, minute by minute over a hold", () => {
    for (const length of [PLAN_GRACE_MS, 20 * DAY, 10 * DAY, 2 * DAY, 60_000]) {
      const short = slot(NOW, NOW + length);
      let marks: GraceNoticeMark[] = [];
      const sent: GraceNoticeMoment[] = [];
      for (let now = NOW; now < short.until + DAY; now += Math.max(60_000, length / 500)) {
        const due = graceNoticeDue(record([short], marks), now);
        if (due) {
          sent.push(due.moment);
          marks = due.marks;
        }
      }
      expect(new Set(sent).size).toBe(sent.length);
      expect(sent.map(graceNoticeRank)).toEqual([...sent.map(graceNoticeRank)].sort());
      expect(sent.at(-1)).toBe("three_days");
    }
  });

  it("picks the hold ending first and keeps only the marks of live holds", () => {
    const first = slot(NOW - 10 * DAY);
    const second = slot(NOW);
    const gone = slot(NOW - 70 * DAY, NOW - 10 * DAY);
    const due = graceNoticeDue(
      record([second, first], JSON.stringify([mark(gone, "three_days")])),
      NOW,
    );
    expect(due?.slot).toEqual(first);
    expect(due?.moment).toBe("start");
    expect(due?.marks).toEqual([mark(first, "start")]);
    // Next run: the second hold, keeping the first's mark.
    const next = graceNoticeDue(record([second, first], due?.marks), NOW + 60_000);
    expect(next?.slot).toEqual(second);
    expect(next?.marks).toEqual([mark(first, "start"), mark(second, "start")]);
    expect(graceNoticeDue(record([second, first], next?.marks), NOW + 120_000)).toBeNull();
  });

  it("breaks a tie on the end by the earlier drop", () => {
    const a = slot(NOW - DAY, NOW + 30 * DAY);
    const b = slot(NOW - 2 * DAY, NOW + 30 * DAY);
    expect(graceNoticeDue(record([a, b]), NOW)?.slot).toEqual(b);
  });

  it("announces nothing for an unreadable grace and reads unreadable marks as none", () => {
    expect(graceNoticeDue(record("not json"), NOW)).toBeNull();
    expect(graceNoticeDue(record(JSON.stringify([{ plan: "x" }])), NOW)).toBeNull();
    expect(graceNoticeDue(record([held], "not json"), NOW)?.moment).toBe("start");
    expect(graceNoticeDue(record([held], '[{"from":1}]'), NOW)?.moment).toBe("start");
  });

  it("does not announce a natural expiry before the grace scan stores it", () => {
    expect(
      graceNoticeDue({ plan: "pro", seats: 1, validUntil: NOW - DAY, overrides: null }, NOW),
    ).toBeNull();
  });
});

describe("reading the marks", () => {
  const held = slot(NOW);
  it.each([
    [null, []],
    [undefined, []],
    ["", []],
    ["{}", []],
    [JSON.stringify([mark(held, "start")]), [mark(held, "start")]],
    [[mark(held, "two_weeks")], [mark(held, "two_weeks")]],
    [JSON.stringify(Array(9).fill(mark(held, "start"))), []],
  ])("%j", (value, expected) => {
    expect(readGraceNotices(value)).toEqual(expected);
  });
});

describe("whether a scheduled email is still due when it is sent", () => {
  const held = slot(NOW);
  const notice = mark(held, "start");
  it("sends while the hold still runs, ends on that date and is at that moment", () => {
    expect(graceNoticeStillDue(record([held]), notice, NOW + DAY)).toEqual(held);
  });
  it.each([
    ["the plan was granted again (no grace)", record(null), NOW],
    ["--no-grace or a fold ended it", record([slot(NOW - DAY)]), NOW],
    ["it ends on another date", record([slot(NOW, NOW + 30 * DAY)]), NOW],
    ["a later moment is due since", record([held]), held.until - 10 * DAY],
    ["it ended", record([held]), held.until],
    ["the grace cannot be read", record("nope"), NOW],
  ])("is moot when %s", (_, row, now) => {
    expect(graceNoticeStillDue(row, notice, now)).toBeNull();
  });
  it("is moot without a plan row", () => {
    expect(graceNoticeStillDue(null, notice, NOW)).toBeNull();
  });
});
