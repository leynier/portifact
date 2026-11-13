import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { expect, it } from "vitest";
import { db, NOW, user } from "./fixtures.ts";
import { publishDoc } from "./suggestion-support.ts";

it("R8: an empty expiry scan must not read every live attempt", async () => {
  const owner = await user("Owner");
  const doc = await publishDoc(owner.id);
  for (let i = 0; i < 300; i++) {
    await db().insert(schema.acceptanceAttempts).values({id: `scan-${i}`, artifactId: doc.artifactId, ownerId: owner.id, origin: "draft", userId: owner.id, digest: "a".repeat(64), baseVersionId: doc.versionId, state: "running", deliveries: 0, createdAt: NOW, updatedAt: NOW});
  }
  const result = await env.DB.prepare("select * from acceptance_attempts where state = 'running' and (deliveries >= 3 or created_at <= ?) order by updated_at asc limit 50").bind(NOW - 1_800_000).all();
  expect(result.results).toEqual([]);
  expect(result.meta.rows_read).toBeLessThanOrEqual(50);
});

it("R8b: a draft cursor page must seek rather than scan the prefix", async () => {
  const result = await env.DB.prepare("explain query plan select artifact_id, user_id, owner_id from edit_drafts where artifact_id || '|' || user_id > ? order by artifact_id, user_id limit 200").bind("zz|zz").all<{detail: string}>();
  expect(result.results.map(row => row.detail).join("\n")).not.toMatch(/SCAN edit_drafts/);
});

it("R8c: attempt retention must use an expiry index", async () => {
  const result = await env.DB.prepare("explain query plan select id from acceptance_attempts where state <> 'running' and created_at <= ? limit 500").bind(NOW - 30 * 86_400_000).all<{detail: string}>();
  expect(result.results.map(row => row.detail).join("\n")).not.toMatch(/SCAN acceptance_attempts/);
});
