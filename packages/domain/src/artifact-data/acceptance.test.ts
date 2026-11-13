// "Acceptance tests for delivery 3" of decision 0026 (A01 to A34) against the in-memory reference
// object. The same suite drives the real documents object in workerd (apps/data/test).
import { DatabaseSync } from "node:sqlite";
import { memoryObject } from "../testing/artifact-data-object.ts";
import {
  acceptanceSuite,
  EXPORT_COUNT,
  EXPORT_INSERT,
  EXPORT_SELECT,
  EXPORT_TABLE,
  exportRows,
} from "../testing/artifact-data-suites/acceptance.ts";

acceptanceSuite(memoryObject, {
  async loadExport(file) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(EXPORT_TABLE);
      const insert = database.prepare(EXPORT_INSERT);
      for (const row of exportRows(file)) insert.run(...row);
      const b = database.prepare(EXPORT_SELECT).get() as { text: string; big: number };
      const count = database.prepare(EXPORT_COUNT).get() as { n: number };
      return { b: { text: b.text, big: b.big }, documents: count.n };
    } finally {
      database.close();
    }
  },
});
