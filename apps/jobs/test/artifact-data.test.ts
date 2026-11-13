// The jobs Worker's half of artifact data (decision 0026, delivery 4): its configuration binds
// the documents class of `portifact-data` by `script_name`, the queue consumer gives each data job
// its region's objects, and the operator's data commands write the jobs reconciliation needs.
// Here the data Worker is its real bundle (vitest.config.ts), so these jobs cross the same RPC
// boundary they cross deployed. The lifecycle itself is tested against the real object in
// apps/data.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2031, 0, 1);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const db = () => regionsFromEnv(env).get("default").db;

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

interface Control {
  hold: unknown;
}

const control = (id: string) =>
  (
    env.ARTIFACT_DOCUMENTS.get(env.ARTIFACT_DOCUMENTS.idFromName(id)) as unknown as {
      lifecycleControl(): Promise<Control | null>;
    }
  ).lifecycleControl();

async function deliver(id: number, topic: "data_fence" | "data_erase") {
  const batch = createMessageBatch("portifact-jobs", [
    { id: "m0", timestamp: NOW, attempts: 1, body: { id, topic } },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

describe("the jobs Worker reaches the documents objects", () => {
  it("runs a data job through its binding, and creates no object while data is off", async () => {
    const id = artifactId();
    const ownerId = `u_${crypto.randomUUID()}`;
    await db()
      .insert(schema.artifacts)
      .values({ id, ownerId, type: "site", name: "Plan", state: "suspended" });
    await db().insert(schema.artifactData).values({ artifactId: id, epoch: 1, updatedAt: NOW });
    const [job] = await db()
      .insert(schema.outbox)
      .values({
        topic: "data_fence",
        payload: {
          ownerId,
          generation: 0,
          epoch: 1,
          fence: { kind: "hold", transition: "hold_jobs" },
        },
        availableAt: NOW,
        subject: id,
      })
      .returning();
    const result = await deliver(job?.id ?? 0, "data_fence");
    expect(result.explicitAcks).toEqual(["m0"]);
    // The object answered over RPC: nothing bound it, and with the switch off nothing does.
    expect(await control(id)).toBeNull();
    expect(
      await db()
        .select()
        .from(schema.outbox)
        .where(and(eq(schema.outbox.subject, id), eq(schema.outbox.topic, "data_fence"))),
    ).toEqual([]);
  });
});

describe("the operator's data commands", () => {
  const now = Date.UTC(2026, 10, 12);

  it("queues a region's reconciliation, a resolution and an export, and lists findings", async () => {
    const id = artifactId();
    const reconcile = await runOperator(regionsFromEnv(env), ["data-reconcile"], now);
    expect(reconcile.exitCode).toBe(0);
    const state = `${id}:default:1:orphan:u_owner:0:0`;
    const resolve = await runOperator(
      regionsFromEnv(env),
      ["data-resolve", id, "erase", "--state", state],
      now,
    );
    expect(resolve.output).toContain(`for the state ${state}`);
    expect(resolve.exitCode).toBe(0);
    const exported = await runOperator(regionsFromEnv(env), ["data-export", id], now);
    expect(exported.output).toContain(`system/data-exports/${id}.${now}/`);
    const jobs = await db().select().from(schema.outbox).where(eq(schema.outbox.createdAt, now));
    expect(jobs.map((job) => [job.topic, job.payload]).sort()).toEqual(
      [
        ["data_export", { key: `system/data-exports/${id}.${now}`, after: null, page: 0 }],
        ["data_reconcile", { phase: "inventory", cursor: null }],
        [
          "data_resolve",
          {
            decision: "erase",
            resolutionId: expect.stringMatching(/^[0-9]{13}\./),
            expected: {
              artifactId: id,
              region: "default",
              incarnation: 1,
              reason: "orphan",
              ownerId: "u_owner",
              generation: 0,
              epoch: 0,
            },
          },
        ],
      ].sort(),
    );
    expect((await runOperator(regionsFromEnv(env), ["data-findings"], now)).output).toBe(
      "No artifact data findings.",
    );
    await db().insert(schema.dataFindings).values({
      artifactId: id,
      action: "quarantined",
      reason: "orphan",
      firstSeenAt: now,
      lastSeenAt: now,
    });
    expect((await runOperator(regionsFromEnv(env), ["data-findings"], now)).output).toContain(
      `${id}  quarantined (orphan)`,
    );
  });

  it("refuses incomplete data commands", async () => {
    for (const argv of [
      ["data-resolve"],
      ["data-resolve", "abcdefghij", "keep"],
      // A resolution needs the state the operator reviewed.
      ["data-resolve", "abcdefghij", "erase"],
      ["data-resolve", "abcdefghij", "erase", "--state", "abcdefghij:default:1:orphan:u:0"],
      ["data-export"],
    ]) {
      expect((await runOperator(regionsFromEnv(env), argv, now)).exitCode).toBe(2);
    }
    expect(
      (await runOperator(regionsFromEnv(env), ["data-findings", "--limit", "0"], now)).exitCode,
    ).toBe(2);
  });
});
