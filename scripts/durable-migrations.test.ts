// Durable Object classes are only ever added (decision 0026, "One object"): a `deleted_classes`
// migration deletes every object of the class with its data, and renaming or transferring a class
// moves stored objects in ways no reconciliation covers. Every Worker configuration of the product
// and the test stack lists only `new_sqlite_classes` (spikes, never deployed, are not scanned).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function configs(): string[] {
  const roots = [
    ...readdirSync(join(ROOT, "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `apps/${entry.name}`),
    "e2e",
  ];
  return roots.flatMap((root) =>
    readdirSync(join(ROOT, root))
      .filter((name) => /^([a-z.]*\.)?wrangler\.jsonc$/.test(name))
      .map((name) => `${root}/${name}`),
  );
}

/** Migration keys a configuration may use. */
export function forbiddenMigrations(text: string): string[] {
  return [
    ...text.matchAll(/"(deleted_classes|renamed_classes|transferred_classes|new_classes)"/g),
  ].map((match) => match[1] as string);
}

describe("Durable Object migrations", () => {
  it("only add SQLite classes, in every Worker configuration", () => {
    const found = configs();
    expect(found).toContain("apps/data/wrangler.jsonc");
    for (const config of found) {
      expect(forbiddenMigrations(readFileSync(join(ROOT, config), "utf8")), config).toEqual([]);
    }
  });

  it("refuses each key that removes, moves or adds a class without SQLite storage", () => {
    for (const key of [
      "deleted_classes",
      "renamed_classes",
      "transferred_classes",
      "new_classes",
    ]) {
      expect(forbiddenMigrations(`{"migrations":[{"tag":"v2","${key}":["X"]}]}`)).toEqual([key]);
    }
    expect(forbiddenMigrations(`{"migrations":[{"tag":"v1","new_sqlite_classes":["X"]}]}`)).toEqual(
      [],
    );
  });
});
