import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createArtifact } from "../src/create.ts";
import { openReadSession, refreshReadSession } from "../src/read-session.ts";
import { count, randomId, regionsFor, seedUser, seedWorkspace, uid } from "./harness.ts";

describe("read sessions across databases", () => {
  it("cannot keep today's foreign keys to users and sessions in a regional database", async () => {
    const regions = regionsFor("separate");
    const { userId, sessionId } = await seedUser(regions);
    // Where the identity rows are (the global database) today's shape works...
    await env.GLOBAL.prepare("insert into read_sessions_today values (?, ?, ?)")
      .bind(uid("rs"), userId, sessionId)
      .run();
    // ...in the EU database the same insert fails: D1 enforces the keys and the rows are global.
    await expect(
      env.DB_EU.prepare("insert into read_sessions_today values (?, ?, ?)")
        .bind(uid("rs"), userId, sessionId)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
  });

  it("opens and renews an EU read session only while the global app session lives", async () => {
    const regions = regionsFor("separate");
    const { sessionId } = await seedUser(regions);
    const workspace = await seedWorkspace(regions, "eu");
    const created = await createArtifact(regions, { ownerId: workspace, name: "x", now: 1 });
    if (!created.ok) throw new Error(created.code);
    const readId = uid("rs");
    const now = Date.now();
    expect(
      await openReadSession(regions, {
        artifactId: created.id,
        authSessionId: sessionId,
        sessionId: readId,
        now,
      }),
    ).toBe(true);
    expect(
      await count(env.DB_EU, "select count(*) as n from read_sessions where id = ?", readId),
    ).toBe(1);
    expect(await refreshReadSession(regions, "eu", { sessionId: readId, now })).toBe(true);

    // Signing out deletes the global session; no cascade reaches the EU row, but renewal stops.
    await env.GLOBAL.prepare("delete from sessions where id = ?").bind(sessionId).run();
    expect(
      await count(env.DB_EU, "select count(*) as n from read_sessions where id = ?", readId),
    ).toBe(1);
    expect(await refreshReadSession(regions, "eu", { sessionId: readId, now })).toBe(false);
    expect(
      await openReadSession(regions, {
        artifactId: created.id,
        authSessionId: sessionId,
        sessionId: uid("rs"),
        now,
      }),
    ).toBe(false);
  });

  it("opens nothing for an unknown artifact, a claimed ID without a row, or an unknown session", async () => {
    const regions = regionsFor("separate");
    const { sessionId } = await seedUser(regions);
    const now = Date.now();
    expect(
      await openReadSession(regions, {
        artifactId: randomId(),
        authSessionId: sessionId,
        sessionId: uid("rs"),
        now,
      }),
    ).toBe(false);
    const claimed = randomId();
    await env.GLOBAL.prepare("insert into artifact_directory values (?, 'eu', 1)")
      .bind(claimed)
      .run();
    expect(
      await openReadSession(regions, {
        artifactId: claimed,
        authSessionId: sessionId,
        sessionId: uid("rs"),
        now,
      }),
    ).toBe(false);
    expect(await refreshReadSession(regions, "eu", { sessionId: uid("rs"), now })).toBe(false);
  });
});
