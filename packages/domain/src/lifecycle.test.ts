import { PLANS } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkRestore,
  effectiveArchivedAt,
  effectiveState,
  type LifecycleRecord,
  nextExpiry,
  purgeDate,
} from "./lifecycle.ts";

const at = (iso: string) => new Date(iso);

const FREE = PLANS.free.limits;

describe("expiry and purge dates", () => {
  it("expires 30 days after publishing", () => {
    expect(nextExpiry(at("2026-11-07T10:00:00Z")).toISOString()).toBe("2026-12-07T10:00:00.000Z");
  });

  it("purges six calendar months after archiving, in UTC", () => {
    expect(purgeDate(at("2026-01-15T08:30:00Z")).toISOString()).toBe("2026-07-15T08:30:00.000Z");
    expect(purgeDate(at("2026-09-30T23:59:59Z")).toISOString()).toBe("2027-03-30T23:59:59.000Z");
  });

  it("clamps to the last day of shorter months", () => {
    expect(purgeDate(at("2026-08-31T12:00:00Z")).toISOString()).toBe("2027-02-28T12:00:00.000Z");
    expect(purgeDate(at("2027-08-31T12:00:00Z")).toISOString()).toBe("2028-02-29T12:00:00.000Z");
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
          const days = (purgeDate(archived).getTime() - archived.getTime()) / 86_400_000;
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
