// Question 2: the Drizzle tables in schema.ts hold every field the three plugins declare, so the
// Drizzle adapter's runtime check passes and an upgrade that adds a field fails here first.
import { getAuthTables } from "better-auth/db";
import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { scimTables, spikeAuthSchema, ssoTables, workspaceTables } from "./schema.ts";
import { createHarness } from "./test/harness.ts";

const h = createHarness({
  transactions: "sequential",
  scimConnections: [{ workspaceId: "ws_schema", token: "spike-schema-token" }],
});

describe("plugin tables", () => {
  const tables = getAuthTables(h.auth.options);
  const schema = spikeAuthSchema as Record<string, Table>;

  it.each(Object.entries(tables))("%s has a Drizzle table with every field", (_key, table) => {
    const drizzle = schema[`${table.modelName}s`];
    expect(drizzle, `${table.modelName}s`).toBeDefined();
    const columns = Object.keys(getTableColumns(drizzle as Table));
    for (const [field, attribute] of Object.entries(table.fields)) {
      expect(columns, `${table.modelName}.${field}`).toContain(attribute.fieldName ?? field);
    }
  });

  it("adds three workspace tables, one SSO table and seven SCIM tables, plus one session column", () => {
    const names = (group: Record<string, Table>) =>
      Object.values(group).map((t) => getTableName(t));
    expect(names(workspaceTables)).toEqual(["organizations", "members", "invitations"]);
    expect(names(ssoTables)).toEqual(["sso_providers"]);
    expect(names(scimTables)).toHaveLength(7);
    expect(Object.keys(tables.session?.fields ?? {})).toContain("activeOrganizationId");
  });
});
