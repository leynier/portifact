import {
  type GraceNoticeMark,
  type GraceNoticeMoment,
  type GraceSlot,
  PLAN_GRACE_MS,
  PLANS,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  graceNoticeCheck,
  graceNoticeDue,
  graceNoticeMoment,
  graceNoticeRank,
  graceNoticeStillDue,
  planGraceNotices,
  readGraceNotices,
} from "./plan-grace-notices.ts";
import { graceForecastSteps, graceHoldEndDrops } from "./plans.ts";

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

const MINUTE = 60_000;

/** A hold of the Team plan's values, which keep more than Pro's. */
function teamHold(from: number): GraceSlot {
  const { limits } = PLANS.team;
  return {
    ...slot(from),
    plan: "team",
    limits: {
      archiveMonths: limits.archiveMonths,
      retainedPreviousVersions: limits.retainedPreviousVersions,
      previousVersionRetentionDays: limits.previousVersionRetentionDays,
      accessLogRetentionDays: limits.accessLogRetentionDays,
      auditRetentionDays: limits.auditRetentionDays,
    },
    features: ["pin", "audit"],
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

  it.each([
    [59, "start"],
    [14.0001, "start"],
    [14, "two_weeks"],
    [13, "two_weeks"],
    [3.0001, "two_weeks"],
    [3, "three_days"],
    [2, "three_days"],
    [0.5, "three_days"],
  ] as const)("with %d days left is %s, for the rule and the email due", (days, moment) => {
    const short = slot(NOW - DAY, NOW + days * DAY);
    expect(graceNoticeMoment(short, NOW)).toBe(moment);
    expect(graceNoticeDue(record([short]), NOW)?.moment).toBe(moment);
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

  it("sends one email when several holds are due, marks each, and keeps their later moments", () => {
    // Team lowered to Pro (keeps more, ends first), then Pro removed: both new at once.
    const first = teamHold(NOW - 10 * DAY);
    const second = slot(NOW);
    const gone = slot(NOW - 70 * DAY, NOW - 10 * DAY);
    const due = graceNoticeDue(
      record([second, first], JSON.stringify([mark(gone, "three_days")])),
      NOW,
      "scan",
    );
    // One email, for the hold ending first (both are at their start), both marked with its token.
    expect(due?.slot).toEqual(first);
    expect(due?.moment).toBe("start");
    expect(due?.marks).toEqual([
      { ...mark(first, "start"), claim: "scan" },
      { ...mark(second, "start"), claim: "scan" },
    ]);
    expect(graceNoticeDue(record([second, first], due?.marks), NOW + MINUTE)).toBeNull();
    // Each still gets its own later moments.
    const firstLater = graceNoticeDue(record([second, first], due?.marks), first.until - 10 * DAY);
    expect([firstLater?.slot, firstLater?.moment]).toEqual([first, "two_weeks"]);
    const secondLater = graceNoticeDue(
      record([second], JSON.stringify([mark(second, "start")])),
      second.until - 2 * DAY,
    );
    expect(secondLater?.moment).toBe("three_days");
  });

  it("picks the most urgent moment when due holds are at different moments", () => {
    const first = teamHold(NOW - 50 * DAY); // 10 days left: two_weeks
    const second = slot(NOW); // start
    const due = graceNoticeDue(record([second, first]), NOW, "scan");
    expect([due?.slot, due?.moment]).toEqual([first, "two_weeks"]);
    expect(due?.marks.map((m) => m.moment)).toEqual(["two_weeks", "start"]);
  });

  it("breaks a tie on the end by the earlier drop", () => {
    const a = slot(NOW - DAY, NOW + 30 * DAY);
    const b = slot(NOW - 2 * DAY, NOW + 30 * DAY);
    expect(graceNoticeDue(record([a, b]), NOW)?.slot).toEqual(b);
  });

  it("after unreadable marks, sends one email per hold, for its most urgent moment, then nothing", () => {
    const held = slot(NOW - 50 * DAY);
    const due = graceNoticeDue(record([held], "{bad"), NOW);
    expect(due?.moment).toBe("two_weeks");
    expect(graceNoticeDue(record([held], JSON.stringify(due?.marks)), NOW)).toBeNull();
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
  const notice = { ...mark(held, "start"), claim: "scan-1" };
  const marked = (slots: GraceSlot[] | string | null, claim = "scan-1") =>
    record(slots, JSON.stringify([{ ...mark(held, "start"), claim }]));
  it("sends while the hold runs, ends on that date, is at that moment and the mark is its own", () => {
    expect(graceNoticeStillDue(marked([held]), notice, NOW + DAY)).toEqual(held);
  });
  it.each([
    ["the plan was granted again (no grace)", marked(null), NOW],
    ["--no-grace or a fold ended it", marked([slot(NOW - DAY)]), NOW],
    ["it ends on another date", marked([slot(NOW, NOW + 30 * DAY)]), NOW],
    ["a later moment is due since", marked([held]), held.until - 10 * DAY],
    ["it ended", marked([held]), held.until],
    ["the grace cannot be read", marked("nope"), NOW],

    ["another scan's mark won", marked([held], "scan-2"), NOW],
    ["a later hold now covers its end", marked([held, teamHold(NOW + DAY)]), NOW + DAY],
  ])("is moot when %s", (_, row, now) => {
    expect(graceNoticeStillDue(row, notice, now)).toBeNull();
  });
  it("is moot without a plan row", () => {
    expect(graceNoticeStillDue(null, notice, NOW)).toBeNull();
  });

  it("waits while its mark has not landed, and is moot once another token holds the moment", () => {
    const three = { ...mark(slot(NOW - 58 * DAY), "three_days"), claim: "scan-1" };
    const held58 = slot(NOW - 58 * DAY);
    const below = record([held58], JSON.stringify([mark(held58, "two_weeks")]));
    // The job was written first and runs before the scan's mark: it waits.
    expect(graceNoticeCheck(below, three, NOW)).toEqual({ status: "wait" });
    expect(graceNoticeCheck(record([held58]), three, NOW)).toEqual({ status: "wait" });
    // The mark lands with its token: it sends.
    const landed = record([held58], JSON.stringify([three]));
    expect(graceNoticeCheck(landed, three, NOW)).toEqual({ status: "send", slot: held58 });
    // The scan crashed and the next one wrote its own token: this one is moot.
    const other = record([held58], JSON.stringify([{ ...three, claim: "scan-2" }]));
    expect(graceNoticeCheck(other, three, NOW)).toEqual({ status: "moot" });
  });
});

describe("which holds are announced", () => {
  it("only those on whose end a forecast step falls", () => {
    // Enterprise lowered to Team: the same retention, only features lost; nothing goes.
    const enterprise = slot(NOW);
    const { limits } = PLANS.enterprise;
    enterprise.plan = "enterprise";
    enterprise.limits = {
      archiveMonths: limits.archiveMonths,
      retainedPreviousVersions: limits.retainedPreviousVersions,
      previousVersionRetentionDays: limits.previousVersionRetentionDays,
      accessLogRetentionDays: limits.accessLogRetentionDays,
      auditRetentionDays: limits.auditRetentionDays,
    };
    enterprise.features = [...PLANS.enterprise.features];
    const team = { ...record([enterprise]), plan: "team" };
    expect(graceHoldEndDrops(team, enterprise)).toBe(
      graceForecastSteps(team, enterprise.until - 1).some((s) => s.from === enterprise.until),
    );
    expect(planGraceNotices(team, NOW).notice).toBeNull();
    // Archive months alone: dates only archives made meanwhile, so nothing goes either.
    const archive = { ...slot(NOW), limits: { ...slot(NOW).limits } };
    const own = PLANS.pro.limits;
    archive.limits = {
      archiveMonths: own.archiveMonths + 12,
      retainedPreviousVersions: own.retainedPreviousVersions,
      previousVersionRetentionDays: own.previousVersionRetentionDays,
      accessLogRetentionDays: own.accessLogRetentionDays,
      auditRetentionDays: own.auditRetentionDays,
    };
    const pro = { ...record([archive]), plan: "pro" };
    expect(graceHoldEndDrops(pro, archive)).toBe(false);
    expect(planGraceNotices(pro, NOW).notice).toBeNull();
  });
});

describe("holds another hold covers past their end", () => {
  it("are not announced but marked covered, until the holds change", () => {
    // Hand-applied: a later Team hold covers an earlier Pro one (the services end such a hold).
    const a = slot(NOW - 10 * DAY);
    const b = teamHold(NOW);
    const plan = planGraceNotices(record([a, b]), NOW + MINUTE, "scan");
    expect(plan.notice?.slot).toEqual(b);
    expect(plan.marks).toEqual([
      { ...mark(a, "three_days"), covered: 2 },
      { ...mark(b, "start"), claim: "scan" },
    ]);
    // Nothing more for A while the holds stay the same: no email, no write.
    const after = record([a, b], JSON.stringify(plan.marks));
    for (const now of [a.until - 13 * DAY, a.until - 2 * DAY]) {
      expect(planGraceNotices(after, now).notice?.slot ?? null).not.toEqual(a);
    }
    expect(planGraceNotices(after, NOW + 2 * MINUTE)).toMatchObject({
      notice: null,
      changed: false,
    });
    // A covered mark recorded with another number of holds is decided again.
    const changed = record([a], JSON.stringify(plan.marks));
    expect(planGraceNotices(changed, NOW + 2 * MINUTE).notice?.slot).toEqual(a);
  });

  it("records a covered hold without an email when nothing else is due", () => {
    const a = slot(NOW - 10 * DAY);
    const b = teamHold(NOW);
    const plan = planGraceNotices(
      record([a, b], JSON.stringify([{ ...mark(b, "start"), claim: "x" }])),
      NOW + MINUTE,
    );
    expect(plan).toEqual({
      notice: null,
      marks: [
        { ...mark(a, "three_days"), covered: 2 },
        { ...mark(b, "start"), claim: "x" },
      ],
      changed: true,
    });
  });

  it("are announced when the later hold keeps less", () => {
    const a = teamHold(NOW - 10 * DAY);
    const b = slot(NOW);
    expect(graceNoticeDue(record([a, b]), NOW + MINUTE)?.slot).toEqual(a);
  });
});
