// The job dispatcher: a job whose sender or binding is missing in this Worker throws, so its row
// stays and runs again where they are bound, instead of being reported done; a job without a
// subject ends without touching anything.
import { env } from "cloudflare:test";
import type { JobMessage, OutboxTopic } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { describe, expect, it } from "vitest";
import { runJob } from "../src/outbox.ts";
import { db, NOW } from "./fixtures.ts";

async function run(topic: OutboxTopic, payload: unknown = {}, subject: string | null = null) {
  const [row] = await db()
    .insert(schema.outbox)
    .values({ topic, payload, availableAt: NOW, createdAt: NOW, subject })
    .returning();
  if (!row) throw new Error("no row");
  return runJob(db(), env.ARTIFACTS, { id: row.id, topic } as JobMessage, NOW, {});
}

describe("the job dispatcher", () => {
  it("throws, keeping the row, for every job whose sender or binding this Worker lacks", async () => {
    const needs: [OutboxTopic, unknown, string][] = [
      ["erase_access_events", { kind: "user" }, "access log"],
      ["owner_retention", {}, "access log"],
      ["access_history_move", {}, "access log"],
      ["expiry_notice", {}, "notifier"],
      ["comment_notice", {}, "comment notifier"],
      ["webhook_delivery", {}, "webhook keys"],
      ["domain_notice", {}, "domain notifier"],
      ["review_notice", {}, "review notifier"],
      ["directory_notice", {}, "directory notifier"],
      ["comment_retention_notice", {}, "comment retention notifier"],
      ["retention_notice", {}, "retention notifier"],
      ["thread_issue", {}, "integration deps"],
      ["plan_grace_notice", {}, "grace notifier"],
      ["moderation_notice", {}, "moderation notifier"],
      ["report_outcome", {}, "report notifier"],
    ];
    for (const [topic, payload, what] of needs) {
      await expect(run(topic, payload, "subject"), topic).rejects.toThrow(what);
    }
  });

  it("ends jobs whose subject is missing without acting", async () => {
    for (const topic of [
      "purge_artifact",
      "account_deletion",
      "workspace_deletion",
      "abort_multipart",
      "legal_hold_release",
      "plan_region",
    ] as const) {
      expect(["done", "stale"], topic).toContain(await run(topic));
    }
    // Audit streams without their keys end, and the scan re-arms them later.
    expect(await run("audit_stream")).toBe("stale");
  });
});
