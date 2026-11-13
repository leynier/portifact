// "Acceptance tests for delivery 3" of decision 0026 (A01 to A34), unchanged, through the real
// documents object on SQLite (delivery 4's acceptance). The export file of A32 is loaded into a
// real SQLite database: another Durable Object's storage.

import { env, runInDurableObject } from "cloudflare:test";
import {
  acceptanceSuite,
  EXPORT_COUNT,
  EXPORT_INSERT,
  EXPORT_SELECT,
  EXPORT_TABLE,
  exportRows,
} from "@portifact/domain/testing/artifact-data";
import { realObject } from "./driver.ts";

let loads = 0;

acceptanceSuite(realObject, {
  async loadExport(file) {
    loads += 1;
    const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName(`export-load-${loads}`));
    return runInDurableObject(stub, (_instance, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(EXPORT_TABLE);
      for (const row of exportRows(file)) sql.exec(EXPORT_INSERT, ...row);
      const [b] = sql.exec(EXPORT_SELECT).toArray();
      const [count] = sql.exec(EXPORT_COUNT).toArray();
      return {
        b: { text: String(b?.text), big: Number(b?.big) },
        documents: Number(count?.n),
      };
    });
  },
});
