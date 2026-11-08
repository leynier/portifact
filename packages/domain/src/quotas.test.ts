import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type AccountUsage, checkPublish, type PublishRequest } from "./quotas.ts";

const empty: AccountUsage = {
  activeArtifacts: 0,
  storedBytes: 0,
  publishesLast24h: 0,
  openUploads: 0,
  newFilesLast24h: 0,
  newBytesLast24h: 0,
  newObjectsThisMonth: 0,
};
const small: PublishRequest = {
  createsArtifact: true,
  versionBytes: 1_000,
  files: 3,
  newBytes: 1_000,
  newFiles: 3,
};

describe("checkPublish", () => {
  it("reserves a slot, bytes and files for a new artifact", () => {
    expect(checkPublish(empty, small)).toEqual({
      ok: true,
      value: { activeSlots: 1, bytes: 1_000, files: 3 },
    });
  });

  it("reserves no slot when updating an existing artifact", () => {
    const result = checkPublish(
      { ...empty, activeArtifacts: 50 },
      { ...small, createsArtifact: false },
    );
    expect(result).toMatchObject({ ok: true, value: { activeSlots: 0 } });
  });

  it.each<[string, Partial<AccountUsage>, Partial<PublishRequest>]>([
    ["version larger than 250 MB", {}, { versionBytes: 250_000_001 }],
    ["more than 1,000 files", {}, { files: 1_001 }],
    ["51st active artifact", { activeArtifacts: 50 }, {}],
    ["storage above 2.5 GB", { storedBytes: 2_500_000_000 - 999 }, {}],
    ["101st publish in 24 hours", { publishesLast24h: 100 }, {}],
    ["third concurrent upload", { openUploads: 2 }, {}],
    ["too many new files in 24 hours", { newFilesLast24h: 9_998 }, {}],
    ["too many new bytes in 24 hours", { newBytesLast24h: 5_000_000_000 - 999 }, {}],
    ["monthly new object limit", { newObjectsThisMonth: 99_998 }, {}],
  ])("rejects a %s", (_, usage, request) => {
    expect(checkPublish({ ...empty, ...usage }, { ...small, ...request })).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
  });

  it("accepts usage exactly at each limit", () => {
    const usage = {
      ...empty,
      activeArtifacts: 49,
      storedBytes: 2_500_000_000 - 1_000,
      publishesLast24h: 99,
      openUploads: 1,
    };
    expect(checkPublish(usage, small).ok).toBe(true);
    expect(checkPublish(empty, { ...small, versionBytes: 250_000_000, files: 1_000 }).ok).toBe(
      true,
    );
  });

  it("accepts new files and bytes that land exactly on the rolling and monthly limits", () => {
    const atLimits = {
      ...empty,
      newFilesLast24h: 10_000 - 3,
      newBytesLast24h: 5_000_000_000 - 1_000,
      newObjectsThisMonth: 100_000 - 3,
    };
    expect(checkPublish(atLimits, small)).toEqual({
      ok: true,
      value: { activeSlots: 1, bytes: 1_000, files: 3 },
    });
  });

  it("never lets reservations push storage past the account limit", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 400_000_000 }), { minLength: 1, maxLength: 30 }),
        (sizes) => {
          let stored = 0;
          for (const size of sizes) {
            const result = checkPublish(
              { ...empty, storedBytes: stored },
              {
                createsArtifact: false,
                versionBytes: Math.min(size, 250_000_000),
                files: 1,
                newBytes: size,
                newFiles: 1,
              },
            );
            if (result.ok) stored += result.value.bytes;
          }
          expect(stored).toBeLessThanOrEqual(2_500_000_000);
        },
      ),
    );
  });
});
