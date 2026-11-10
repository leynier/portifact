import { PLANS } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkPin,
  checkRestore,
  checkUnpin,
  effectiveArchivedAt,
  effectivePurgeAt,
  effectiveState,
  type LifecycleRecord,
  nextExpiry,
  type PinRecord,
  pinsLapse,
  purgeDate,
} from "./lifecycle.ts";
import { entitlements } from "./plans.ts";

const at = (iso: string) => new Date(iso);

const FREE = PLANS.free.limits;
const PRO = PLANS.pro.limits;

describe("expiry and purge dates", () => {
  it("expires 30 days after publishing", () => {
    expect(nextExpiry(at("2026-11-07T10:00:00Z")).toISOString()).toBe("2026-12-07T10:00:00.000Z");
  });

  it("purges six calendar months after archiving, in UTC", () => {
    expect(purgeDate(at("2026-01-15T08:30:00Z"), 6).toISOString()).toBe("2026-07-15T08:30:00.000Z");
    expect(purgeDate(at("2026-09-30T23:59:59Z"), 6).toISOString()).toBe("2027-03-30T23:59:59.000Z");
  });

  it("purges after the plan's months: twelve on paid plans", () => {
    expect(purgeDate(at("2026-01-15T08:30:00Z"), PRO.archiveMonths).toISOString()).toBe(
      "2027-01-15T08:30:00.000Z",
    );
    expect(purgeDate(at("2027-02-28T12:00:00Z"), 12).toISOString()).toBe(
      "2028-02-28T12:00:00.000Z",
    );
    expect(purgeDate(at("2026-11-30T00:00:00Z"), 3).toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });

  it("clamps to the last day of shorter months", () => {
    expect(purgeDate(at("2026-08-31T12:00:00Z"), 6).toISOString()).toBe("2027-02-28T12:00:00.000Z");
    expect(purgeDate(at("2027-08-31T12:00:00Z"), 6).toISOString()).toBe("2028-02-29T12:00:00.000Z");
  });

  it("always purges between 181 and 184 days after archiving", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: at("2000-01-01T00:00:00Z"),
          max: at("2100-01-01T00:00:00Z"),
          noInvalidDate: true,
        }),
        (archived) => {
          const days = (purgeDate(archived, 6).getTime() - archived.getTime()) / 86_400_000;
          expect(days).toBeGreaterThanOrEqual(181);
          expect(days).toBeLessThanOrEqual(184);
        },
      ),
    );
  });
});

describe("effective state", () => {
  const active: LifecycleRecord = {
    state: "active",
    expiresAt: at("2026-12-01T00:00:00Z"),
    archivedAt: null,
  };

  it("stays active before the expiry", () => {
    expect(effectiveState(active, at("2026-11-30T23:59:59Z"))).toBe("active");
    expect(effectiveArchivedAt(active, at("2026-11-30T23:59:59Z"))).toBeNull();
  });

  it("is archived from the expiry even if maintenance has not run", () => {
    expect(effectiveState(active, at("2026-12-01T00:00:00Z"))).toBe("archived");
    expect(effectiveArchivedAt(active, at("2026-12-02T00:00:00Z"))).toEqual(
      at("2026-12-01T00:00:00Z"),
    );
  });

  it("keeps other states as they are", () => {
    const suspended: LifecycleRecord = { ...active, state: "suspended" };
    expect(effectiveState(suspended, at("2027-01-01T00:00:00Z"))).toBe("suspended");
  });
});

describe("restore", () => {
  const archived: LifecycleRecord = {
    state: "archived",
    expiresAt: at("2026-12-01T00:00:00Z"),
    archivedAt: at("2026-12-01T00:00:00Z"),
  };

  it("grants another 30 days within the archive period", () => {
    const result = checkRestore(archived, at("2027-01-10T00:00:00Z"), 3, FREE);
    expect(result).toEqual({ ok: true, value: { expiresAt: at("2027-02-09T00:00:00Z") } });
  });

  it("restores an expired artifact that maintenance has not archived yet", () => {
    const lapsed: LifecycleRecord = {
      state: "active",
      expiresAt: at("2026-12-01T00:00:00Z"),
      archivedAt: null,
    };
    expect(checkRestore(lapsed, at("2026-12-05T00:00:00Z"), 0, FREE).ok).toBe(true);
  });

  it("keeps the purge date set at archiving, whatever the plan is now", () => {
    const set = { ...archived, purgeAt: at("2027-06-01T00:00:00Z") };
    expect(effectivePurgeAt(set, at("2027-01-10T00:00:00Z"), 12)).toEqual(
      at("2027-06-01T00:00:00Z"),
    );
    expect(effectivePurgeAt(set, at("2027-01-10T00:00:00Z"), 1)).toEqual(
      at("2027-06-01T00:00:00Z"),
    );
    expect(checkRestore(set, at("2027-05-31T23:59:59Z"), 0, FREE).ok).toBe(true);
    expect(checkRestore(set, at("2027-06-01T00:00:00Z"), 0, PRO)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("counts an expired, unarchived artifact's archive with the plan's months", () => {
    const lapsed: LifecycleRecord = {
      state: "active",
      expiresAt: at("2026-12-01T00:00:00Z"),
      archivedAt: null,
      purgeAt: at("2026-12-02T00:00:00Z"),
    };
    expect(effectivePurgeAt(lapsed, at("2026-12-05T00:00:00Z"), 6)).toEqual(
      at("2027-06-01T00:00:00Z"),
    );
    expect(effectivePurgeAt(lapsed, at("2026-12-05T00:00:00Z"), 12)).toEqual(
      at("2027-12-01T00:00:00Z"),
    );
    expect(checkRestore(lapsed, at("2027-07-01T00:00:00Z"), 0, FREE).ok).toBe(false);
    expect(checkRestore(lapsed, at("2027-07-01T00:00:00Z"), 0, PRO).ok).toBe(true);
    expect(effectivePurgeAt(lapsed, at("2026-11-30T00:00:00Z"), 6)).toBeNull();
  });

  it("falls back to the plan's months for an archived row without a purge date", () => {
    expect(effectivePurgeAt(archived, at("2027-01-10T00:00:00Z"), 12)).toEqual(
      at("2027-12-01T00:00:00Z"),
    );
  });

  it("refuses after the purge date", () => {
    expect(checkRestore(archived, at("2027-06-01T00:00:00Z"), 0, FREE)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("refuses when all active slots are used", () => {
    expect(checkRestore(archived, at("2027-01-10T00:00:00Z"), 50, FREE)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
  });

  it("refuses artifacts that are not archived", () => {
    const live: LifecycleRecord = {
      state: "active",
      expiresAt: at("2027-12-01T00:00:00Z"),
      archivedAt: null,
    };
    expect(checkRestore(live, at("2027-01-10T00:00:00Z"), 0, FREE)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(
      checkRestore({ ...archived, state: "purging" }, at("2027-01-10T00:00:00Z"), 0, FREE).ok,
    ).toBe(false);
  });
});

describe("pins", () => {
  const active: PinRecord = {
    state: "active",
    expiresAt: at("2026-12-01T00:00:00Z"),
    archivedAt: null,
    pinned: false,
  };
  const pinned: PinRecord = { ...active, expiresAt: null, pinned: true };
  const now = at("2026-11-10T00:00:00Z");

  it("pins an active artifact, and pinning again changes nothing", () => {
    expect(checkPin(active, now)).toEqual({ ok: true, value: { changed: true } });
    expect(checkPin(pinned, now)).toEqual({ ok: true, value: { changed: false } });
  });

  it("keeps a pinned artifact active forever", () => {
    expect(effectiveState(pinned, at("2099-01-01T00:00:00Z"))).toBe("active");
  });

  it("refuses to pin what is not active at now", () => {
    for (const record of [
      { ...active, state: "archived" as const },
      { ...active, state: "suspended" as const },
      { ...active, state: "draft" as const },
      { ...active, state: "purging" as const },
    ]) {
      expect(checkPin(record, now)).toEqual({
        ok: false,
        code: "artifact_archived",
        message: "Only active artifacts can be pinned; restore it first.",
      });
    }
    expect(checkPin(active, at("2026-12-01T00:00:00Z")).ok).toBe(false);
    expect(checkPin(active, at("2026-11-30T23:59:59Z")).ok).toBe(true);
  });

  it("unpins with a fresh 30-day expiry, like a renewal", () => {
    expect(checkUnpin(pinned, now)).toEqual({
      ok: true,
      value: { changed: true, expiresAt: at("2026-12-10T00:00:00Z") },
    });
  });

  it("unpinning an unpinned artifact keeps its expiry", () => {
    expect(checkUnpin(active, now)).toEqual({
      ok: true,
      value: { changed: false, expiresAt: at("2026-12-01T00:00:00Z") },
    });
  });

  it("unpins only active artifacts", () => {
    expect(checkUnpin({ ...pinned, state: "suspended" }, now)).toEqual({
      ok: false,
      code: "invalid_input",
      message: "Only active artifacts can be unpinned.",
    });
    expect(checkUnpin({ ...active, state: "archived" }, now).ok).toBe(false);
  });

  it("lapses when the owner's plan no longer includes pin", () => {
    const NOW = Date.parse("2026-11-10T00:00:00Z");
    expect(pinsLapse(entitlements(null, NOW))).toBe(true);
    expect(
      pinsLapse(entitlements({ plan: "pro", seats: 1, validUntil: null, overrides: null }, NOW)),
    ).toBe(false);
    expect(
      pinsLapse(entitlements({ plan: "pro", seats: 1, validUntil: NOW, overrides: null }, NOW)),
    ).toBe(true);
    expect(
      pinsLapse(
        entitlements(
          { plan: "pro", seats: 1, validUntil: null, overrides: { features: { pin: false } } },
          NOW,
        ),
      ),
    ).toBe(true);
  });
});
