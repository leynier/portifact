// PR 276 review: reproductions of the owner erase and author delete findings, on real D1 and SQLite objects.
import { ARTIFACT_DATA, type OwnerDataCommand } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { HELD_MESSAGE } from "@portifact/domain";
import { LIFECYCLE_LIMITS } from "@portifact/domain/artifact-data";
import {
  createDataDocument,
  createWorkspace,
  type DataObjectRpc,
  type DataObjects,
  declareDataCollection,
  deleteAuthorData,
  eraseArtifactData,
  lifecycleId,
  type OwnerDataDeps,
  placeLegalHold,
  registerDataObject,
  releaseLegalHold,
  runDataReset,
  runJob,
  transferArtifact,
} from "@portifact/services";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  artifactId,
  artifactRow,
  bucketOf,
  controlOf,
  dataRowOf,
  db,
  documentsOf,
  inside,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  quiet,
  visitorId,
  withData,
} from "./lifecycle.ts";

const key = () => crypto.randomUUID();
const value = <T>(result: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!result.ok) throw new Error(result.message);
  return result.value;
};
function deps(objects = objectsFor("default", { createsObjects: true })): OwnerDataDeps {
  return { objects, bucket: bucketOf(), enabled: true };
}
function wrapped(
  objects: DataObjects,
  call: (
    command: OwnerDataCommand,
    run: () => ReturnType<DataObjectRpc["ownerCommand"]>,
  ) => ReturnType<DataObjectRpc["ownerCommand"]>,
): DataObjects {
  return {
    ...objects,
    object(id) {
      const rpc = objects.object(id);
      return new Proxy(rpc, {
        get(target, property) {
          if (property === "ownerCommand") {
            return (...args: Parameters<DataObjectRpc["ownerCommand"]>) =>
              call(args[2], () => target.ownerCommand(...args));
          }
          return Reflect.get(target, property);
        },
      });
    },
  };
}
async function writeNew(id: string, ownerId: string, now = NOW + 3) {
  const input = { userId: ownerId, artifactId: id, now };
  value(
    await declareDataCollection(db(), deps(), {
      ...input,
      idempotencyKey: key(),
      declaration: { name: "new_notes", mode: "shared", indexed: [] },
    }),
  );
  return value(
    await createDataDocument(db(), deps(), {
      ...input,
      idempotencyKey: key(),
      collection: "new_notes",
      body: { keep: "created after the confirmed erase" },
    }),
  );
}
async function createVisitor(id: string, author: string, now: number) {
  await inside(id, (object) => {
    const control = object.store.controlRecord();
    if (control === null) throw new Error("no control");
    const answer = object.store.create(
      { ...control, opId: lifecycleId(now) },
      { kind: "visitor", author, canWrite: true },
      "notes",
      { keep: "a later visitor write" },
      { now, limits: LIFECYCLE_LIMITS },
    );
    if (!answer.ok) throw new Error(answer.code);
  });
}
async function erasedEvents(id: string) {
  return db()
    .select()
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.artifactId, id), eq(schema.auditEvents.kind, "data.erased")));
}
async function hold(id: string, now = NOW) {
  await db()
    .update(schema.artifacts)
    .set({ state: "suspended" })
    .where(eq(schema.artifacts.id, id));
  value(await placeLegalHold(db(), { artifactId: id, ground: "pf276", releaseAt: null, now }));
}

describe("PR 276 adversarial review on real D1 and SQLite objects", () => {
  it.each(["after_claim", "after_prepare", "after_commit", "before_audit", "after_audit"] as const)(
    "C1: finishes a crash at %s exactly once",
    async (point) => {
      const { id, ownerId } = await withData();
      const input = { userId: ownerId, artifactId: id, now: NOW, idempotencyKey: key() };
      let fired = false;
      const crash = wrapped(objectsFor(), async (command, run) => {
        if (
          !fired &&
          point === "after_claim" &&
          command.kind === "erase" &&
          command.step === "prepare"
        ) {
          fired = true;
          throw new Error("injected");
        }
        const answer = await run();
        if (
          !fired &&
          command.kind === "erase" &&
          ((point === "after_prepare" && command.step === "prepare") ||
            (point === "after_commit" && command.step === "commit"))
        ) {
          fired = true;
          throw new Error("injected");
        }
        return answer;
      });
      let batches = 0;
      const crashedDb = new Proxy(db(), {
        get(target, property) {
          if (property === "batch")
            return async (statements: Parameters<ReturnType<typeof db>["batch"]>[0]) => {
              batches += 1;
              if (!fired && point === "before_audit" && batches === 2) {
                fired = true;
                throw new Error("injected");
              }
              const answer = await target.batch(statements);
              if (!fired && point === "after_audit" && batches === 2) {
                fired = true;
                throw new Error("injected");
              }
              return answer;
            };
          return Reflect.get(target, property);
        },
      });
      await expect(eraseArtifactData(crashedDb, deps(crash), input)).rejects.toThrow("injected");
      expect(fired).toBe(true);
      const jobs = await jobsOf(db(), ["data_reset"], id);
      expect(jobs).toHaveLength(point === "after_audit" ? 0 : 1);
      for (const job of jobs) {
        expect(await runDataReset(db(), objectsFor(), job, NOW + 60_000)).toBe("done");
        expect(await runDataReset(db(), objectsFor(), job, NOW + 60_000)).toBe("done");
      }
      expect(value(await eraseArtifactData(db(), deps(), { ...input, now: NOW + 60_000 }))).toEqual(
        { erased: true, generation: 1 },
      );
      expect(await documentsOf(id)).toBe(0);
      expect(await erasedEvents(id)).toHaveLength(1);
      expect(await jobsOf(db(), ["data_reset"], id)).toHaveLength(0);
    },
  );

  it("B1: a kept caller key must not retarget an unprepared erase to a later generation", async () => {
    const { id, ownerId } = await withData();
    const input = { userId: ownerId, artifactId: id, now: NOW, idempotencyKey: key() };
    const crash = wrapped(objectsFor(), async (command, run) => {
      if (command.kind === "erase" && command.step === "prepare")
        throw new Error("crash after claim");
      return run();
    });
    await expect(eraseArtifactData(db(), deps(crash), input)).rejects.toThrow("crash after claim");
    const [oldJob] = await jobsOf(db(), ["data_reset"], id);
    expect(oldJob?.payload).toMatchObject({ generation: 0 });
    value(await eraseArtifactData(db(), deps(), { ...input, now: NOW + 1, idempotencyKey: key() }));
    await writeNew(id, ownerId);
    expect(await documentsOf(id)).toBe(1);
    const retry = await eraseArtifactData(db(), deps(), { ...input, now: NOW + 4 });
    expect(await documentsOf(id)).toBe(1);
    expect(retry.ok).toBe(false);
  });

  it("B2: retrying delete-author with the same key must not delete a later document", async () => {
    const author = visitorId();
    const { id, ownerId } = await withData({ visitors: [author] });
    const input = { userId: ownerId, artifactId: id, now: NOW, idempotencyKey: key(), author };
    expect(value(await deleteAuthorData(db(), deps(), input))).toEqual({ removed: 1, more: false });
    await createVisitor(id, author, NOW + 1);
    expect(await documentsOf(id, author)).toBe(1);
    value(await deleteAuthorData(db(), deps(), { ...input, now: NOW + 2 }));
    expect(await documentsOf(id, author)).toBe(1);
  });

  it("B3: a row registered before a failed declaration must not bind an empty object while off", async () => {
    const id = artifactId();
    const ownerId = `u_${crypto.randomUUID()}`;
    await artifactRow(id, ownerId);
    await registerDataObject(db(), bucketOf(), "default", id, NOW);
    await quiet(id);
    expect(await controlOf(id)).toBeNull();
    const off = { ...deps(objectsFor("default", { createsObjects: false })), enabled: false };
    value(
      await eraseArtifactData(db(), off, {
        userId: ownerId,
        artifactId: id,
        now: NOW,
        idempotencyKey: key(),
      }),
    );
    expect(await controlOf(id)).toBeNull();
  });

  it("B4: a crash after commit must still record its audit after the ended receipt expires", async () => {
    const { id, ownerId } = await withData();
    const crash = wrapped(objectsFor(), async (command, run) => {
      const result = await run();
      if (command.kind === "erase" && command.step === "commit")
        throw new Error("lost commit answer");
      return result;
    });
    await expect(
      eraseArtifactData(db(), deps(crash), {
        userId: ownerId,
        artifactId: id,
        now: NOW,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow("lost commit answer");
    expect(await documentsOf(id)).toBe(0);
    const [job] = await jobsOf(db(), ["data_reset"], id);
    if (!job) throw new Error("no recovery job");
    const later = NOW + ARTIFACT_DATA.replayMs + 1;
    await inside(id, (object) => object.store.alarm(later));
    await runJob(db(), bucketOf(), { id: job.id, topic: job.topic, region: "default" }, later, {
      data: objectsFor(),
    });
    expect(await jobsOf(db(), ["data_reset"], id)).toHaveLength(0);
    expect({
      events: (await erasedEvents(id)).length,
      generation: (await dataRowOf(id))?.generation,
    }).toEqual({ events: 1, generation: 1 });
  });

  it("B5: a reset job must not erase under the old owner after a transfer before its fence", async () => {
    const adminId = `u_${crypto.randomUUID()}`;
    const editorId = `u_${crypto.randomUUID()}`;
    for (const id of [adminId, editorId]) {
      await db()
        .global.insert(schema.users)
        .values({
          id,
          name: "Reviewer fixture",
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
        });
    }
    const source = value(
      await createWorkspace(db().global, {
        slug: `s${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        name: "Source",
        adminUserId: adminId,
        now: NOW,
      }),
    );
    const destination = value(
      await createWorkspace(db().global, {
        slug: `d${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        name: "Destination",
        adminUserId: adminId,
        now: NOW,
      }),
    );
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: source.id, userId: editorId, role: "editor", updatedAt: NOW });
    const { id } = await withData({ ownerId: source.id });
    const crash = wrapped(objectsFor(), async (command, run) => {
      if (command.kind === "erase" && command.step === "prepare")
        throw new Error("after claim before prepare");
      return run();
    });
    await expect(
      eraseArtifactData(db(), deps(crash), {
        userId: editorId,
        artifactId: id,
        now: NOW,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow("after claim before prepare");
    const [job] = await jobsOf(db(), ["data_reset"], id);
    if (!job) throw new Error("no recovery job");
    value(
      await transferArtifact(db(), bucketOf(), {
        userId: adminId,
        artifactId: id,
        workspace: destination.slug,
        now: NOW + 1,
      }),
    );
    expect(await jobsOf(db(), ["data_fence"], id)).toHaveLength(1);
    expect((await controlOf(id))?.ownerId).toBe(source.id);
    expect(
      await eraseArtifactData(db(), deps(), {
        userId: editorId,
        artifactId: id,
        now: NOW + 2,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    await runDataReset(db(), objectsFor(), job, NOW + 60_000);
    expect(await documentsOf(id)).toBe(1);
  });

  it("B6: a refused concurrent request must not retire an erase key another retry already committed", async () => {
    const { id, ownerId } = await withData();
    const input = { userId: ownerId, artifactId: id, now: NOW, idempotencyKey: key() };
    let raced = false;
    const delayedClaim = new Proxy(db(), {
      get(target, property) {
        if (property === "batch")
          return async (statements: Parameters<ReturnType<typeof db>["batch"]>[0]) => {
            const answer = await target.batch(statements);
            if (!raced) {
              raced = true;
              // A's claim committed; its response is delayed. Another copy of A completes it.
              value(await eraseArtifactData(db(), deps(), { ...input, now: NOW + 1 }));
              await writeNew(id, ownerId, NOW + 2);
              await hold(id, NOW + 3);
            }
            return answer;
          };
        return Reflect.get(target, property);
      },
    });
    expect(await eraseArtifactData(delayedClaim, deps(), input)).toMatchObject({
      ok: false,
      message: HELD_MESSAGE,
    });
    expect(await documentsOf(id)).toBe(1);
    expect(await erasedEvents(id)).toHaveLength(1);
    expect(await releaseLegalHold(db(), { artifactId: id, now: NOW + 4 })).toEqual({
      released: true,
    });
    await db().update(schema.artifacts).set({ state: "active" }).where(eq(schema.artifacts.id, id));
    for (const job of await jobsOf(db(), ["data_fence"], id)) {
      await runJob(db(), bucketOf(), { id: job.id, topic: job.topic, region: "default" }, NOW + 5, {
        data: objectsFor(),
      });
    }
    expect((await controlOf(id))?.hold).toBeNull();
    value(await eraseArtifactData(db(), deps(), { ...input, now: NOW + 6 }));
    expect({ documents: await documentsOf(id), events: (await erasedEvents(id)).length }).toEqual({
      documents: 1,
      events: 1,
    });
  });

  it("H1: asks D1 again if a hold is placed between prepare and commit", async () => {
    const { id, ownerId } = await withData();
    let placed = false;
    const raced = wrapped(objectsFor(), async (command, run) => {
      const answer = await run();
      if (!placed && command.kind === "erase" && command.step === "prepare") {
        placed = true;
        await hold(id);
      }
      return answer;
    });
    const answer = await eraseArtifactData(db(), deps(raced), {
      userId: ownerId,
      artifactId: id,
      now: NOW,
      idempotencyKey: key(),
    });
    expect(answer).toMatchObject({ ok: false, message: HELD_MESSAGE });
    expect((await controlOf(id))?.hold).toBeNull();
    expect(await documentsOf(id)).toBe(1);
    expect(await jobsOf(db(), ["data_reset"], id)).toHaveLength(1);
  });

  it("H2: a reset job resumes no step while a D1 hold has an undelivered fence", async () => {
    const { id, ownerId } = await withData();
    const crash = wrapped(objectsFor(), async (command, run) => {
      if (command.kind === "erase" && command.step === "commit") throw new Error("before commit");
      return run();
    });
    await expect(
      eraseArtifactData(db(), deps(crash), {
        userId: ownerId,
        artifactId: id,
        now: NOW,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow("before commit");
    await hold(id);
    const [job] = await jobsOf(db(), ["data_reset"], id);
    if (!job) throw new Error("no recovery job");
    let steps = 0;
    const counted = wrapped(objectsFor(), async (_command, run) => {
      steps += 1;
      return run();
    });
    expect(await runDataReset(db(), counted, job, NOW + 60_000)).toBe("kept");
    // D1 answered first: no object step ran while held.
    expect(steps).toBe(0);
    expect((await controlOf(id))?.hold).toBeNull();
    expect(await documentsOf(id)).toBe(1);
  });

  it("H3: author deletion rechecks D1 before its second page", async () => {
    const author = visitorId();
    const { id, ownerId } = await withData({ documents: 0 });
    for (let n = 0; n < 101; n += 1) await createVisitor(id, author, NOW + n * 60_000);
    let placed = false;
    const raced = wrapped(objectsFor(), async (command, run) => {
      const answer = await run();
      if (!placed && command.kind === "bulk_remove") {
        placed = true;
        await hold(id, NOW + 101 * 60_000);
      }
      return answer;
    });
    const answer = await deleteAuthorData(db(), deps(raced), {
      userId: ownerId,
      artifactId: id,
      now: NOW + 101 * 60_000,
      idempotencyKey: key(),
      author,
    });
    expect(answer).toMatchObject({ ok: false, message: HELD_MESSAGE });
    expect(await documentsOf(id, author)).toBe(1);
  });

  it("R1: a duplicate job keeps documents created under the next declaration", async () => {
    const { id, ownerId } = await withData();
    let oldJob: Awaited<ReturnType<typeof jobsOf>>[number] | undefined;
    const capture = wrapped(objectsFor(), async (command, run) => {
      if (command.kind === "erase" && command.step === "prepare")
        [oldJob] = await jobsOf(db(), ["data_reset"], id);
      return run();
    });
    value(
      await eraseArtifactData(db(), deps(capture), {
        userId: ownerId,
        artifactId: id,
        now: NOW,
        idempotencyKey: key(),
      }),
    );
    if (!oldJob) throw new Error("no captured job");
    await writeNew(id, ownerId);
    expect(await runDataReset(db(), objectsFor(), oldJob, NOW + 60_000)).toBe("done");
    expect(await documentsOf(id)).toBe(1);
    expect(await erasedEvents(id)).toHaveLength(1);
  });

  it("G1: the claim refuses an owner the request did not authorize, whatever the epoch", async () => {
    const adminId = `u_${crypto.randomUUID()}`;
    const editorId = `u_${crypto.randomUUID()}`;
    for (const userId of [adminId, editorId]) {
      await db()
        .global.insert(schema.users)
        .values({
          id: userId,
          name: "Reviewer fixture",
          email: `${userId}@example.test`,
          emailVerified: true,
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
        });
    }
    const slug = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    const source = value(
      await createWorkspace(db().global, {
        slug: `s${slug()}`,
        name: "Source",
        adminUserId: adminId,
        now: NOW,
      }),
    );
    const destination = value(
      await createWorkspace(db().global, {
        slug: `d${slug()}`,
        name: "Destination",
        adminUserId: adminId,
        now: NOW,
      }),
    );
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: source.id, userId: editorId, role: "editor", updatedAt: NOW });
    const { id } = await withData({ ownerId: source.id });
    // The transfer lands between authorization (the source's owner) and the read of the data
    // envelope (the destination's epoch): only the claim's owner condition can refuse it.
    let selects = 0;
    const racing = new Proxy(db(), {
      get(target, property) {
        if (property !== "select") return Reflect.get(target, property);
        return (...args: Parameters<ReturnType<typeof db>["select"]>) => {
          selects += 1;
          const builder = target.select(...args);
          if (selects !== 2) return builder;
          const from = builder.from.bind(builder);
          return Object.assign(builder, {
            from: (...source: Parameters<typeof from>) => {
              const query = from(...source);
              const run = query.then.bind(query);
              return Object.assign(query, {
                // biome-ignore lint/suspicious/noThenProperty: delays the second read past the transfer
                then: async (...handlers: Parameters<typeof run>) => {
                  value(
                    await transferArtifact(db(), bucketOf(), {
                      userId: adminId,
                      artifactId: id,
                      workspace: destination.slug,
                      now: NOW + 1,
                    }),
                  );
                  return run(...handlers);
                },
              });
            },
          });
        };
      },
    });
    const answer = await eraseArtifactData(racing, deps(), {
      userId: editorId,
      artifactId: id,
      now: NOW + 2,
      idempotencyKey: key(),
    });
    expect(answer.ok).toBe(false);
    expect(await jobsOf(db(), ["data_reset"], id)).toHaveLength(0);
    expect(await documentsOf(id)).toBe(1);
  });
});
