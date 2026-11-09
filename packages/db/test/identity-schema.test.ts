import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const db = () => createDb(env.DB);

describe("identity schema and seeded OAuth data", () => {
  it("seeds the API and MCP resources", async () => {
    const rows = await db()
      .select({ identifier: schema.oauthResources.identifier, name: schema.oauthResources.name })
      .from(schema.oauthResources);
    expect(rows).toEqual(
      expect.arrayContaining([
        { identifier: "https://app.portifact.com/api/v1", name: "Portifact API" },
        { identifier: "https://app.portifact.com/mcp", name: "Portifact MCP" },
      ]),
    );
  });

  it("seeds the CLI as a public device-grant client linked only to the API", async () => {
    const [client] = await db()
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, "portifact-cli"));
    expect(client).toMatchObject({
      name: "Portifact CLI",
      clientSecret: null,
      disabled: false,
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
    });
    expect(JSON.parse(client?.grantTypes ?? "[]")).toEqual([
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ]);
    expect(JSON.parse(client?.scopes ?? "[]")).toEqual([
      "artifacts:read",
      "artifacts:write",
      "artifacts:share",
      "artifacts:delete",
      "annotations:read",
      "annotations:write",
      "annotations:moderate",
      "credentials:manage",
      "offline_access",
    ]);
    const links = await db()
      .select({ resource: schema.oauthClientResources.resourceId })
      .from(schema.oauthClientResources)
      .where(eq(schema.oauthClientResources.clientId, "portifact-cli"));
    expect(links).toEqual([{ resource: "https://app.portifact.com/api/v1" }]);
  });

  it("allows one user per email and removes sessions and identities with the user", async () => {
    const now = new Date(Date.UTC(2026, 10, 8));
    const user = {
      id: "u1",
      name: "",
      email: "ada@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    };
    await db().insert(schema.users).values(user);
    await expect(
      db()
        .insert(schema.users)
        .values({ ...user, id: "u2" }),
    ).rejects.toThrow();
    await db().insert(schema.sessions).values({
      id: "s1",
      token: "t1",
      userId: "u1",
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db().insert(schema.accounts).values({
      id: "a1",
      accountId: "github-123",
      providerId: "github",
      userId: "u1",
      createdAt: now,
      updatedAt: now,
    });

    await db().delete(schema.users).where(eq(schema.users.id, "u1"));

    expect(await db().select().from(schema.sessions)).toEqual([]);
    expect(await db().select().from(schema.accounts)).toEqual([]);
  });
});
