// The region guard knows no crossing (decision 0005, "Two-region audit"): `KNOWN_CROSS_DATABASE`
// is empty, and any entry would have to name a file and a function that exist, so an entry that
// never matched anything fails here too.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_CROSS_DATABASE } from "../packages/db/src/known-crossings.ts";

const ROOT = join(import.meta.dirname, "..");

/** The entries whose file is missing or declares no function of that name. */
function staleEntries(keys: readonly string[], read: (file: string) => string | null): string[] {
  return keys.filter((key) => {
    const [file = "", name = ""] = key.split("#");
    const text = read(file);
    if (text === null || name === "") return true;
    return !new RegExp(`\\b(?:function ${name}\\s*[(<]|const ${name}\\s*=)`).test(text);
  });
}

const fromDisk = (file: string) => {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

describe("the region guard's known crossings", () => {
  it("each name a function that exists in the file it names", () => {
    expect(staleEntries(Object.keys(KNOWN_CROSS_DATABASE), fromDisk)).toEqual([]);
  });

  it("are none", () => {
    // The list is empty (decision 0005): a future crossing must be fixed, not listed.
    expect(Object.keys(KNOWN_CROSS_DATABASE)).toEqual([]);
  });

  it("fails for an entry that matches nothing", () => {
    expect(
      staleEntries(
        [
          "packages/services/src/plans.ts#setOwnerPlan",
          "packages/services/src/plans.ts#noSuchFunction",
          "packages/services/src/gone.ts#setOwnerPlan",
          "packages/services/src/plans.ts",
        ],
        fromDisk,
      ),
    ).toEqual([
      "packages/services/src/plans.ts#noSuchFunction",
      "packages/services/src/gone.ts#setOwnerPlan",
      "packages/services/src/plans.ts",
    ]);
  });
});
