// What a transfer leaves behind in storage and in the access database: renderings go to the key
// the owner's row holds, and the access history moves in bounded rounds.
import { env } from "cloudflare:test";
import { type AccessDb, accessSchema, regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ANALYTICS_ROW_BATCH, moveAccessHistory } from "../src/analytics.ts";
import { storeRenderings } from "../src/documents.ts";
import { db, NOW, sha256 } from "./fixtures.ts";

const access = () => regionsFromEnv(env).get("default").accessDb as AccessDb;

function recordingBucket() {
  const puts: string[] = [];
  const bucket = {
    put: async (key: string) => {
      puts.push(key);
      return null;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

describe("storing renderings", () => {
  it("writes to the key of an existing pending row, skips a verified one, and uses the owner's key otherwise", async () => {
    const owner = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    const bytes = (text: string) => new TextEncoder().encode(text);
    const files = await Promise.all(
      ["pending", "verified", "new"].map(async (name) => ({
        kind: "rendered" as const,
        sha256: await sha256(name),
        bytes: bytes(name),
        contentType: "text/html",
      })),
    );
    const [pending, verified, fresh] = files as [
      (typeof files)[number],
      (typeof files)[number],
      (typeof files)[number],
    ];
    await db()
      .insert(schema.objects)
      .values([
        {
          ownerId: owner,
          sha256: pending.sha256,
          size: 7,
          r2Key: "objects/u_old/pending",
          state: "pending",
        },
        {
          ownerId: owner,
          sha256: verified.sha256,
          size: 8,
          r2Key: "objects/u_old/verified",
          state: "verified",
        },
      ]);
    const { bucket, puts } = recordingBucket();
    await storeRenderings(db(), bucket, owner, files as never);
    expect(puts.sort()).toEqual(
      ["objects/u_old/pending", `objects/${owner}/${fresh.sha256}`].sort(),
    );
  });
});

describe("moving the access history", () => {
  it("is done for an artifact that no longer exists", async () => {
    expect(await moveAccessHistory(db(), access(), "zzzzzzzzzz", NOW)).toBe("done");
  });

  it("moves more rows than one round holds in several rounds", async () => {
    const id = "histmovea2";
    await db()
      .insert(schema.artifacts)
      .values({ id, ownerId: "ws_target", type: "site", name: "H" });
    const rows = Array.from({ length: ANALYTICS_ROW_BATCH + 1 }, (_, i) => ({
      artifactId: id,
      day: NOW - (i + 1) * 86_400_000,
      ownerId: "u_source",
      views: 1,
      signedInViews: 0,
      expiresAt: NOW,
    }));
    for (let i = 0; i < rows.length; i += 14) {
      await access()
        .insert(accessSchema.artifactViews)
        .values(rows.slice(i, i + 14));
    }
    expect(await moveAccessHistory(db(), access(), id, NOW, 1)).toBe("pending");
    expect(await moveAccessHistory(db(), access(), id, NOW, 1)).toBe("done");
    const left = await access()
      .select({ ownerId: accessSchema.artifactViews.ownerId })
      .from(accessSchema.artifactViews)
      .where(eq(accessSchema.artifactViews.artifactId, id));
    expect(left.every((row) => row.ownerId === "ws_target")).toBe(true);
    expect(left).toHaveLength(ANALYTICS_ROW_BATCH + 1);
  });
});
