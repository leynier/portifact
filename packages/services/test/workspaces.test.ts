// The owner as a workspace (premium plan F3, decisions 0004 and 0005): every service resolves the
// acting user's role on the artifact's owner, admins and editors manage, members manage nothing,
// and a user with no role on the owner cannot tell its artifacts exist. Workspaces and members
// are inserted as rows: nothing creates them yet.
import { env } from "cloudflare:test";
import { type AnnotationTarget, DEFAULT_POLICY, type WorkspaceRole } from "@portifact/contracts";
import {
  type AccessDb,
  accessSchema,
  type RegionHandles,
  type Regions,
  regionsFromEnv,
  schema,
} from "@portifact/db";
import { personalActor } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAccess, updateAccess } from "../src/access.ts";
import { getAccessLog, recordOpenings } from "../src/access-log.ts";
import { requestAccountDeletion, soleAdminOf } from "../src/account-data.ts";
import { updateAccountSettings } from "../src/account-settings.ts";
import {
  actorHandles,
  actorOn,
  artifactHandles,
  ownerRecipients,
  ownerSide,
  personalHandles,
  resolveActor,
} from "../src/actors.ts";
import {
  createAnnotationThread,
  deleteAnnotationThread,
  type HumanCheck,
  listAnnotations,
  moderateAnnotationMessage,
  setAnnotationMode,
} from "../src/annotations.ts";
import { getArtifact, listArtifacts } from "../src/artifacts.ts";
import { rebuildArtifactDirectory } from "../src/backups.ts";
import { CLAIM_ATTEMPTS, claimArtifactId, claimNewArtifactId } from "../src/directory.ts";
import { type ExpiryNotifier, scheduleExpiryNotices } from "../src/expiry-notices.ts";
import {
  archiveArtifact,
  deleteArtifact,
  renewArtifact,
  restoreArtifact,
} from "../src/lifecycle.ts";
import { runJob } from "../src/outbox.ts";
import {
  abortPublish,
  commitPublish,
  type ManifestEntry,
  preparePublish,
  uploadProgress,
} from "../src/publish.ts";
import { checkReadAccess } from "../src/read-access.ts";
import { recordTraffic } from "../src/traffic.ts";
import { getAccountUsage } from "../src/usage.ts";
import {
  getVersionDownload,
  getVersionManifest,
  listVersions,
  rollbackArtifact,
} from "../src/versions.ts";
import { getViewerArtifact } from "../src/viewer.ts";
import { DAY, db, grantPlan, NOW, session, sha256, user, value } from "./fixtures.ts";

const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
const MISSING = "zzzzzzzzzz";

function workspaceId(): string {
  return `ws_${crypto.randomUUID().replaceAll("-", "")}`;
}

interface Team {
  id: string;
  admin: { id: string; email: string };
  editor: { id: string; email: string };
  member: { id: string; email: string };
  outsider: { id: string; email: string };
}

/** A workspace with one user per role and one user with no role. */
async function team(): Promise<Team> {
  const id = workspaceId();
  const [admin, editor, member, outsider] = [
    await user(),
    await user(),
    await user(),
    await user(),
  ];
  await db()
    .insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  return { id, admin, editor, member, outsider };
}

async function manifest(body: string): Promise<ManifestEntry[]> {
  return [
    {
      path: "index.html",
      kind: "published",
      sha256: await sha256(body),
      size: body.length,
      contentType: "text/html",
    },
  ];
}

/** Publishes a site in `ownerId` as `userId` and returns its IDs. */
async function publishAs(
  userId: string,
  ownerId: string,
  body = `<p>${crypto.randomUUID()}</p>`,
  base?: { artifactId: string; versionId: string },
) {
  const prepared = value(
    await preparePublish(db(), {
      userId,
      targetOwnerId: ownerId,
      ...(base ? { artifactId: base.artifactId } : {}),
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: base?.versionId ?? null,
      files: await manifest(body),
      now: NOW,
    }),
  );
  await env.ARTIFACTS.put(`objects/${ownerId}/${await sha256(body)}`, body);
  const committed = value(
    await commitPublish(db(), env.ARTIFACTS, {
      userId,
      sessionId: prepared.sessionId,
      now: NOW,
    }),
  );
  return { artifactId: committed.artifactId, versionId: committed.versionId };
}

/** A role, the user with no role, and what each is expected to get. */
type Who = WorkspaceRole | "outsider";
const WHO: Who[] = ["admin", "editor", "member", "outsider"];
const userOf = (t: Team, who: Who) => t[who].id;

/**
 * Asserts the matrix for one operation: admins and editors succeed, members are forbidden, and
 * the user with no role gets exactly what a missing artifact gives.
 */
async function matrix<T>(
  t: Team,
  run: (userId: string) => Promise<{ ok: boolean } & T>,
  missing: () => Promise<unknown>,
  /**
   * `missing` when the member cannot read the artifact either: annotations answer everyone who
   * cannot read an artifact like a missing one, members included.
   */
  member: "forbidden" | "missing" = "forbidden",
) {
  for (const who of WHO) {
    const result = await run(userOf(t, who));
    if (who === "admin" || who === "editor") {
      expect(result.ok, `${who} should be allowed`).toBe(true);
    } else if (who === "member" && member === "forbidden") {
      expect(result, "a member manages nothing").toEqual({
        ok: false,
        code: "forbidden",
        message: "Your role on this workspace does not allow this.",
      });
    } else {
      expect(result, "a user with no role cannot tell it exists").toEqual(await missing());
    }
  }
}

describe("resolveActor", () => {
  it("makes a user the admin of their personal space without reading anything", async () => {
    const ada = await user();
    expect(await resolveActor(db().global, ada.id, ada.id)).toEqual({
      ok: true,
      value: personalActor(ada.id),
    });
  });

  it("gives each member their role, in the workspace's region", async () => {
    const t = await team();
    for (const role of ["admin", "editor", "member"] as const) {
      expect(value(await resolveActor(db().global, t[role].id, t.id))).toEqual({
        userId: t[role].id,
        ownerId: t.id,
        role,
        region: "default",
        // The policies come with the membership (decision 0015).
        policy: DEFAULT_POLICY,
        domainVerified: true,
      });
    }
  });

  it("answers someone else's space and a workspace the user is not in like a missing owner", async () => {
    const t = await team();
    const missing = await resolveActor(db().global, t.outsider.id, workspaceId());
    expect(missing).toEqual({ ok: false, code: "not_found", message: "Not found." });
    expect(await resolveActor(db().global, t.outsider.id, t.id)).toEqual(missing);
    expect(await resolveActor(db().global, t.outsider.id, t.admin.id)).toEqual(missing);
  });

  it("refuses a workspace stored in a region this code does not know", async () => {
    const id = workspaceId();
    const ada = await user();
    await env.DB.prepare(
      "INSERT INTO workspaces (id, slug, name, region, created_by, updated_at) VALUES (?, ?, 'X', 'mars', ?, ?)",
    )
      .bind(id, id.slice(3, 23), ada.id, NOW)
      .run();
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId: ada.id, role: "admin", updatedAt: NOW });
    await expect(actorOn(db().global, ada.id, id)).rejects.toThrow("unknown region");
  });

  it("lists who acts for an owner and who receives its notices", async () => {
    const t = await team();
    const ada = await user();
    expect(await ownerSide(db().global, ada.id)).toEqual([ada.id]);
    expect(await ownerSide(db().global, t.id)).toEqual([t.admin.id, t.editor.id].sort());
    expect(await ownerRecipients(db().global, ada.id)).toEqual([ada.id]);
    expect(await ownerRecipients(db().global, t.id)).toEqual([t.admin.id]);
  });
});

describe("regions", () => {
  it("finds an artifact's region in the directory when there is more than one", async () => {
    const ada = await user();
    const { artifactId } = await publishAs(ada.id, ada.id);
    const base = db();
    const handles = (region: string) =>
      ({ region, db: base, accessDb: undefined }) as RegionHandles;
    // A fake second region: only the directory decides which one an artifact is in.
    const regions: Regions = {
      global: base.global,
      get: (region) => handles(region),
      all: () => [handles("default"), handles("eu")],
    };
    expect((await artifactHandles(regions, artifactId))?.region).toBe("default");
    expect(await artifactHandles(regions, MISSING)).toBeNull();
    expect(actorHandles(regions, personalActor(ada.id)).region).toBe("default");
  });

  it("needs no directory read with one region, and finds the personal space there", async () => {
    const single = regionsFromEnv(env);
    // Unknown to the directory, yet the only region is the answer: nothing to look up.
    expect((await artifactHandles(single, MISSING))?.region).toBe("default");
    expect(personalHandles(single)).toBe(single.get("default"));
  });
});

describe("the role matrix through the services", () => {
  it("decides reading, listing and the access policy", async () => {
    const t = await team();
    const { artifactId } = await publishAs(t.editor.id, t.id);
    await matrix(
      t,
      (userId) => getArtifact(db(), { userId, artifactId }),
      () => getArtifact(db(), { userId: t.outsider.id, artifactId: MISSING }),
    );
    await matrix(
      t,
      (userId) => getAccess(db(), { userId, artifactId }),
      () => getAccess(db(), { userId: t.admin.id, artifactId: MISSING }),
    );
    await matrix(
      t,
      (userId) => updateAccess(db(), { userId, artifactId, change: { bar: false }, now: NOW }),
      () =>
        updateAccess(db(), {
          userId: t.admin.id,
          artifactId: MISSING,
          change: { bar: false },
          now: NOW,
        }),
    );
    // Listing goes through the actor the adapter resolved for the owner.
    for (const who of ["admin", "editor", "member"] as const) {
      const actor = value(await resolveActor(db().global, t[who].id, t.id));
      const page = await listArtifacts(db(), { actor, limit: 10, now: NOW });
      if (who === "member") expect(page).toMatchObject({ ok: false, code: "forbidden" });
      else expect(value(page).items.map((row) => row.id)).toEqual([artifactId]);
    }
  });

  it("decides versions, downloads and rollback", async () => {
    const t = await team();
    const first = await publishAs(t.editor.id, t.id, "<p>one</p>");
    const second = await publishAs(t.admin.id, t.id, "<p>two</p>", first);
    const { artifactId } = first;
    await matrix(
      t,
      (userId) => listVersions(db(), { userId, artifactId, now: NOW, limit: 10 }),
      () => listVersions(db(), { userId: t.admin.id, artifactId: MISSING, now: NOW, limit: 10 }),
    );
    await matrix(
      t,
      (userId) =>
        getVersionManifest(db(), { userId, artifactId, versionId: first.versionId, now: NOW }),
      () =>
        getVersionManifest(db(), {
          userId: t.admin.id,
          artifactId: MISSING,
          versionId: first.versionId,
          now: NOW,
        }),
    );
    // Sources of any version are for admins and editors; anyone else gets a missing version.
    for (const who of WHO) {
      const download = await getVersionDownload(db(), {
        userId: userOf(t, who),
        artifactId,
        versionId: first.versionId,
        kind: "source",
        now: NOW,
      });
      expect(download.ok, who).toBe(who === "admin" || who === "editor");
    }
    const member = await rollbackArtifact(db(), {
      userId: t.member.id,
      artifactId,
      versionId: first.versionId,
      baseVersionId: second.versionId,
      now: NOW,
    });
    expect(member).toMatchObject({ ok: false, code: "forbidden" });
    const outsider = await rollbackArtifact(db(), {
      userId: t.outsider.id,
      artifactId,
      versionId: first.versionId,
      baseVersionId: second.versionId,
      now: NOW,
    });
    expect(outsider).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });
    const rolled = value(
      await rollbackArtifact(db(), {
        userId: t.editor.id,
        artifactId,
        versionId: first.versionId,
        baseVersionId: second.versionId,
        now: NOW,
      }),
    );
    const [version] = await db()
      .select({ authorId: schema.versions.authorId })
      .from(schema.versions)
      .where(eq(schema.versions.id, rolled.versionId));
    // The rollback is the editor's, the publish counts against the workspace.
    expect(version?.authorId).toBe(t.editor.id);
  });

  it("decides the lifecycle", async () => {
    const t = await team();
    const { artifactId } = await publishAs(t.editor.id, t.id);
    const input = (userId: string, id = artifactId) => ({ userId, artifactId: id, now: NOW });
    await matrix(
      t,
      (userId) => renewArtifact(db(), input(userId)),
      () => renewArtifact(db(), input(t.admin.id, MISSING)),
    );
    for (const who of ["member", "outsider"] as const) {
      expect(await archiveArtifact(db(), input(userOf(t, who)))).toEqual(
        who === "member"
          ? {
              ok: false,
              code: "forbidden",
              message: "Your role on this workspace does not allow this.",
            }
          : await archiveArtifact(db(), input(t.admin.id, MISSING)),
      );
    }
    expect((await archiveArtifact(db(), input(t.editor.id))).ok).toBe(true);
    expect(await restoreArtifact(db(), input(t.member.id))).toMatchObject({ code: "forbidden" });
    expect((await restoreArtifact(db(), input(t.admin.id))).ok).toBe(true);
    expect(await deleteArtifact(db(), env.ARTIFACTS, input(t.member.id))).toMatchObject({
      code: "forbidden",
    });
    expect(await deleteArtifact(db(), env.ARTIFACTS, input(t.outsider.id))).toEqual(
      await deleteArtifact(db(), env.ARTIFACTS, input(t.outsider.id, MISSING)),
    );
    expect((await deleteArtifact(db(), env.ARTIFACTS, input(t.editor.id))).ok).toBe(true);
  });

  it("decides publishing, updates and uploads", async () => {
    const t = await team();
    const { artifactId, versionId } = await publishAs(t.editor.id, t.id);
    const prepare = (userId: string, extra: { artifactId?: string; base?: string | null }) =>
      manifest(`<p>${crypto.randomUUID()}</p>`).then((files) =>
        preparePublish(db(), {
          userId,
          targetOwnerId: t.id,
          ...(extra.artifactId ? { artifactId: extra.artifactId } : {}),
          type: "site",
          name: "Plan",
          entrypoint: "index.html",
          baseVersionId: extra.base ?? null,
          files,
          now: NOW,
        }),
      );
    // A new artifact in the workspace: a member is forbidden, a user with no role finds nothing.
    expect(await prepare(t.member.id, {})).toMatchObject({ ok: false, code: "forbidden" });
    expect(await prepare(t.outsider.id, {})).toEqual({
      ok: false,
      code: "not_found",
      message: "Artifact not found.",
    });
    // An update names the artifact, whose owner decides the role.
    expect(await prepare(t.member.id, { artifactId, base: versionId })).toMatchObject({
      code: "forbidden",
    });
    expect(await prepare(t.outsider.id, { artifactId, base: versionId })).toEqual(
      await prepare(t.outsider.id, { artifactId: MISSING, base: versionId }),
    );
    const upload = value(await prepare(t.admin.id, { artifactId, base: versionId }));
    // The upload belongs to the workspace: its admins and editors may resume, commit or cancel it.
    const sessionInput = (userId: string) => ({ userId, sessionId: upload.sessionId, now: NOW });
    expect(await uploadProgress(db(), sessionInput(t.member.id))).toMatchObject({
      code: "forbidden",
    });
    expect(await uploadProgress(db(), sessionInput(t.outsider.id))).toEqual({
      ok: false,
      code: "not_found",
      message: "Upload not found.",
    });
    expect(await commitPublish(db(), env.ARTIFACTS, sessionInput(t.outsider.id))).toEqual(
      await commitPublish(db(), env.ARTIFACTS, { ...sessionInput(t.admin.id), sessionId: "upl_x" }),
    );
    expect(await abortPublish(db(), sessionInput(t.member.id))).toMatchObject({
      code: "forbidden",
    });
    expect((await uploadProgress(db(), sessionInput(t.editor.id))).ok).toBe(true);
    expect(await abortPublish(db(), sessionInput(t.editor.id))).toEqual({ ok: true, value: true });
  });

  it("decides annotation moderation and the mode", async () => {
    const t = await team();
    const { artifactId, versionId } = await publishAs(t.editor.id, t.id);
    await matrix(
      t,
      (userId) => setAnnotationMode(db(), { userId, artifactId, mode: "open", now: NOW }),
      () =>
        setAnnotationMode(db(), {
          userId: t.admin.id,
          artifactId: MISSING,
          mode: "open",
          now: NOW,
        }),
      "missing",
    );
    await updateAccess(db(), {
      userId: t.admin.id,
      artifactId,
      change: { mode: "authenticated" },
      now: NOW,
    });
    const thread = value(
      await createAnnotationThread(db(), {
        userId: t.outsider.id,
        artifactId,
        versionId,
        target: DOC,
        body: "A visitor's note",
        humanCheck: HUMAN,
        now: NOW,
      }),
    );
    const messageId = thread.messages[0]?.id as string;
    const moderate = (userId: string) =>
      moderateAnnotationMessage(db(), { userId, artifactId, messageId, action: "hide", now: NOW });
    // The member reads it like any signed-in visitor of an authenticated artifact, but cannot
    // moderate it.
    expect(await moderate(t.member.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect((await moderate(t.editor.id)).ok).toBe(true);
    expect(
      await deleteAnnotationThread(db(), {
        userId: t.member.id,
        artifactId,
        threadId: thread.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      (
        await deleteAnnotationThread(db(), {
          userId: t.admin.id,
          artifactId,
          threadId: thread.id,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
  });

  it("decides the access log and the owner's usage", async () => {
    const t = await team();
    const { artifactId } = await publishAs(t.editor.id, t.id);
    const accessDb = accessLog();
    await matrix(
      t,
      (userId) => getAccessLog(db(), accessDb, { userId, artifactId, limit: 10, now: NOW }),
      () =>
        getAccessLog(db(), accessDb, {
          userId: t.admin.id,
          artifactId: MISSING,
          limit: 10,
          now: NOW,
        }),
    );
    for (const who of ["admin", "editor", "member"] as const) {
      const actor = value(await resolveActor(db().global, t[who].id, t.id));
      const usage = await getAccountUsage(db(), { actor, now: NOW });
      expect(usage.ok, who).toBe(who !== "member");
    }
  });
});

/** The access log database of the test environment. */
function accessLog(): AccessDb {
  return regionsFromEnv(env).get("default").accessDb as AccessDb;
}

describe("'the owner' means an admin or editor of the owner", () => {
  it("lets admins and editors read a restricted workspace artifact; members need the list", async () => {
    const t = await team();
    const { artifactId } = await publishAs(t.editor.id, t.id);
    for (const who of WHO) {
      const read = await checkReadAccess(db(), { artifactId, userId: userOf(t, who), now: NOW });
      expect(read.ok, who).toBe(who === "admin" || who === "editor");
    }
    await updateAccess(db(), {
      userId: t.admin.id,
      artifactId,
      change: { addReaders: [t.member.email] },
      now: NOW,
    });
    expect((await checkReadAccess(db(), { artifactId, userId: t.member.id, now: NOW })).ok).toBe(
      true,
    );
  });

  it("tells the viewer that admins and editors are the owner and listed members are readers", async () => {
    const t = await team();
    const { artifactId } = await publishAs(t.editor.id, t.id);
    await updateAccess(db(), {
      userId: t.admin.id,
      artifactId,
      change: { addReaders: [t.member.email] },
      now: NOW,
    });
    const role = async (userId: string) =>
      (await getViewerArtifact(db(), { customDomains: true, artifactId, userId, now: NOW })) as {
        ok: boolean;
        value?: { role: string };
      };
    expect((await role(t.admin.id)).value?.role).toBe("owner");
    expect((await role(t.editor.id)).value?.role).toBe("owner");
    expect((await role(t.member.id)).value?.role).toBe("reader");
    expect((await role(t.outsider.id)).ok).toBe(false);
  });

  it("shows readers the threads of every admin and editor in the `owner` visibility", async () => {
    const t = await team();
    const reader = await user();
    const { artifactId, versionId } = await publishAs(t.editor.id, t.id);
    await setAnnotationMode(db(), { userId: t.admin.id, artifactId, mode: "open", now: NOW });
    await updateAccess(db(), {
      userId: t.admin.id,
      artifactId,
      change: { addReaders: [reader.email, t.member.email] },
      now: NOW,
    });
    const start = (userId: string, body: string) =>
      createAnnotationThread(db(), {
        userId,
        artifactId,
        versionId,
        target: DOC,
        body,
        humanCheck: HUMAN,
        now: NOW,
      }).then(value);
    await start(t.editor.id, "From the editor");
    await start(t.admin.id, "From the admin");
    await start(t.member.id, "From a member");
    await start(reader.id, "From the reader");
    const seen = async (userId: string) =>
      value(
        await listAnnotations(db(), {
          userId,
          artifactId,
          limit: 25,
          version: "current",
          now: NOW,
        }),
      )
        .threads.map((thread) => `${thread.messages[0]?.body}${thread.byOwner ? " (owner)" : ""}`)
        .sort();
    // A member is a reader here: they see the owner side's threads and their own.
    expect(await seen(reader.id)).toEqual([
      "From the admin (owner)",
      "From the editor (owner)",
      "From the reader",
    ]);
    expect(await seen(t.member.id)).toEqual([
      "From a member",
      "From the admin (owner)",
      "From the editor (owner)",
    ]);
    expect(await seen(t.editor.id)).toHaveLength(4);
  });

  it("never logs the openings of admins and editors, and lets them read the log", async () => {
    const t = await team();
    const { artifactId } = await publishAs(t.editor.id, t.id);
    const accessDb = accessLog();
    await recordOpenings(db(), accessDb, [
      { artifactId, userId: t.editor.id, at: NOW },
      { artifactId, userId: t.admin.id, at: NOW },
      { artifactId, userId: t.member.id, at: NOW },
    ]);
    const log = value(
      await getAccessLog(db(), accessDb, { userId: t.admin.id, artifactId, limit: 10, now: NOW }),
    );
    expect(log.entries.map((entry) => entry.email)).toEqual([t.member.email]);
    const rows = await accessDb
      .select({ ownerId: accessSchema.accessEvents.ownerId })
      .from(accessSchema.accessEvents)
      .where(eq(accessSchema.accessEvents.artifactId, artifactId));
    expect(rows).toEqual([{ ownerId: t.id }]);
  });

  it("applies personal defaults only in the personal space", async () => {
    const t = await team();
    await updateAccountSettings(db(), {
      userId: t.editor.id,
      update: { defaultAnnotations: "open", defaultBar: false },
      now: NOW,
    });
    const personal = await publishAs(t.editor.id, t.editor.id);
    const shared = await publishAs(t.editor.id, t.id);
    const row = async (id: string) =>
      (await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id)))[0];
    expect(await row(personal.artifactId)).toMatchObject({ annotations: "open", bar: false });
    expect(await row(shared.artifactId)).toMatchObject({
      ownerId: t.id,
      accessMode: "restricted",
      annotations: "off",
      bar: true,
      commentVisibility: "owner",
    });
  });

  it("sends a workspace's expiry notice to each admin, never to editors", async () => {
    await env.DB.exec(
      "UPDATE artifacts SET expiry_notice_for = expires_at, expiry_notice_at = NULL; DELETE FROM outbox; DELETE FROM email_counters",
    );
    const t = await team();
    const second = await user();
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: second.id, role: "admin", updatedAt: NOW });
    await updateAccountSettings(db(), {
      userId: second.id,
      update: { expiryNotices: false },
      now: NOW,
    });
    const third = await user();
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: third.id, role: "admin", updatedAt: NOW });
    const { artifactId } = await publishAs(t.editor.id, t.id);
    const soon = NOW + 29 * DAY + 12 * 3_600_000;
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: soon })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await scheduleExpiryNotices(db(), soon - 2 * DAY)).toMatchObject({ owners: 1 });
    const [job] = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "expiry_notice"), eq(schema.outbox.subject, t.id)));
    const sent: string[] = [];
    const notifier: ExpiryNotifier = {
      async send(notice) {
        sent.push(notice.to);
      },
    };
    const outcome = await runJob(
      db(),
      env.ARTIFACTS,
      { id: job?.id as number, topic: "expiry_notice" },
      soon - 2 * DAY,
      { notifier },
    );
    expect(outcome).toBe("done");
    // The admin who opted out gets nothing; the editor and the member are not recipients.
    expect(sent.sort()).toEqual([t.admin.email, third.email].sort());
  });
});

describe("quotas, traffic and comments are the workspace's", () => {
  it("charges slots, storage and publishes to the workspace, not to the editor", async () => {
    const t = await team();
    await publishAs(t.editor.id, t.id, "<p>charged</p>");
    const usage = async (ownerId: string) =>
      (
        await db()
          .select()
          .from(schema.accountUsage)
          .where(eq(schema.accountUsage.ownerId, ownerId))
      )[0];
    expect(await usage(t.id)).toMatchObject({
      activeArtifacts: 1,
      storedBytes: "<p>charged</p>".length,
    });
    expect(await usage(t.editor.id)).toBeUndefined();
    const objects = await db()
      .select({ ownerId: schema.objects.ownerId })
      .from(schema.objects)
      .where(eq(schema.objects.ownerId, t.id));
    expect(objects).toHaveLength(1);
  });

  it("reports the workspace's traffic and the seats of a Team plan", async () => {
    const t = await team();
    await publishAs(t.editor.id, t.id);
    await grantPlan(t.id, "team", { seats: 3 });
    await recordTraffic(
      db(),
      [{ ownerId: t.id, cycleStart: Date.UTC(2026, 10, 1), requests: 7, bytes: 70 }],
      NOW,
    );
    const actor = value(await resolveActor(db().global, t.editor.id, t.id));
    const report = value(await getAccountUsage(db(), { actor, now: NOW }));
    expect(report.plan).toMatchObject({ plan: "team", seats: 3 });
    expect(report.storage.limit).toBe(3 * 30_000_000_000);
    expect(report.trafficThisMonth.requests).toEqual({ used: 7, limit: 3 * 3_000_000 });
    expect(report.activeArtifacts).toEqual({ used: 1, limit: 2_000 });
    // The editor's personal space keeps the free plan.
    const own = value(await getAccountUsage(db(), { actor: personalActor(t.editor.id), now: NOW }));
    expect(own.plan).toMatchObject({ plan: "free" });
    expect(own.trafficThisMonth.requests.used).toBe(0);
  });

  it("counts comments against the workspace's annotation usage", async () => {
    const t = await team();
    const { artifactId, versionId } = await publishAs(t.editor.id, t.id);
    await setAnnotationMode(db(), { userId: t.admin.id, artifactId, mode: "open", now: NOW });
    value(
      await createAnnotationThread(db(), {
        userId: t.editor.id,
        artifactId,
        versionId,
        target: DOC,
        body: "Counted",
        humanCheck: HUMAN,
        now: NOW,
      }),
    );
    const usage = async (ownerId: string) =>
      (
        await db()
          .select()
          .from(schema.annotationUsage)
          .where(eq(schema.annotationUsage.ownerId, ownerId))
      )[0];
    // The body and its target count, as on a personal artifact.
    expect(await usage(t.id)).toMatchObject({
      messages: 1,
      bytes: "Counted".length + JSON.stringify(DOC).length,
    });
    expect(await usage(t.editor.id)).toBeUndefined();
  });
});

describe("the artifact directory", () => {
  it("lets exactly one of two concurrent claims win, and never the same ID twice", async () => {
    const id = "claimrace2";
    const claims = await Promise.all([
      claimArtifactId(db().global, id, "default", NOW),
      claimArtifactId(db().global, id, "default", NOW),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimArtifactId(db().global, id, "default", NOW + 1)).toBe(false);
  });

  it("never hands out a tombstoned ID", async () => {
    await db()
      .insert(schema.tombstones)
      .values({ kind: "artifact", id: "tombstone2", deletedAt: NOW });
    expect(await claimArtifactId(db().global, "tombstone2", "default", NOW)).toBe(false);
  });

  it("draws again when an ID is taken, and gives up after five draws", async () => {
    await claimArtifactId(db().global, "takenidaa2", "default", NOW);
    const draws = ["takenidaa2", "freshidaa2"];
    expect(
      await claimNewArtifactId(db().global, "default", NOW, () => draws.shift() as string),
    ).toBe("freshidaa2");
    let draws2 = 0;
    const taken = () => {
      draws2 += 1;
      return "takenidaa2";
    };
    expect(await claimNewArtifactId(db().global, "default", NOW, taken)).toBeNull();
    expect(draws2).toBe(CLAIM_ATTEMPTS);
  });

  it("claims a new artifact's ID before writing it, and answers a lost claim with a conflict", async () => {
    const ada = await user();
    const files = await manifest("<p>claimed</p>");
    const input = {
      userId: ada.id,
      type: "site" as const,
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: null,
      files,
      now: NOW,
    };
    const prepared = value(await preparePublish(db(), input, undefined, () => "directory2"));
    expect(prepared.artifactId).toBe("directory2");
    const [row] = await db()
      .select()
      .from(schema.artifactDirectory)
      .where(eq(schema.artifactDirectory.id, "directory2"));
    expect(row).toEqual({ id: "directory2", region: "default", createdAt: NOW });
    // Every draw is taken: the same answer as a lost race.
    expect(await preparePublish(db(), input, undefined, () => "directory2")).toEqual({
      ok: false,
      code: "version_conflict",
      message: "Try again.",
    });
  });
});

describe("the directory after a restore", () => {
  it("puts back the rows of artifacts that are still in the region, once", async () => {
    const ada = await user();
    const { artifactId } = await publishAs(ada.id, ada.id);
    // A restore of the global database rewinds the directory; the regional row survived.
    await env.DB.exec("DROP TRIGGER artifact_directory_refuse_delete");
    await db().delete(schema.artifactDirectory).where(eq(schema.artifactDirectory.id, artifactId));
    await env.DB.exec(
      "CREATE TRIGGER artifact_directory_refuse_delete BEFORE DELETE ON artifact_directory BEGIN SELECT RAISE(ABORT, 'artifact_directory_immutable'); END",
    );
    expect(await rebuildArtifactDirectory(db().global, db(), "default")).toBeGreaterThanOrEqual(1);
    const [row] = await db()
      .select()
      .from(schema.artifactDirectory)
      .where(eq(schema.artifactDirectory.id, artifactId));
    expect(row).toMatchObject({ id: artifactId, region: "default" });
    expect(await rebuildArtifactDirectory(db().global, db(), "default")).toBe(0);
  });
});

describe("expiry notices to several admins", () => {
  async function due() {
    await env.DB.exec(
      "UPDATE artifacts SET expiry_notice_for = expires_at, expiry_notice_at = NULL; DELETE FROM outbox; DELETE FROM email_counters; DELETE FROM email_suppressions",
    );
    const t = await team();
    const second = await user();
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: second.id, role: "admin", updatedAt: NOW });
    const { artifactId } = await publishAs(t.editor.id, t.id);
    const soon = NOW + 29 * DAY;
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: soon })
      .where(eq(schema.artifacts.id, artifactId));
    const at = soon - 2 * DAY;
    await scheduleExpiryNotices(db(), at);
    const [job] = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "expiry_notice"), eq(schema.outbox.subject, t.id)));
    const run = (notifier: ExpiryNotifier) =>
      runJob(db(), env.ARTIFACTS, { id: job?.id as number, topic: "expiry_notice" }, at, {
        notifier,
      });
    const requeued = () =>
      db()
        .select()
        .from(schema.outbox)
        .where(and(eq(schema.outbox.topic, "expiry_notice"), eq(schema.outbox.subject, t.id)));
    return { t, second, run, requeued };
  }

  it("never sends a second copy when one admin's send fails after another got it", async () => {
    const { run, requeued } = await due();
    let calls = 0;
    const outcome = await run({
      async send() {
        calls += 1;
        if (calls === 2) throw new Error("provider down");
      },
    });
    expect(outcome).toBe("done");
    expect(calls).toBe(2);
    expect(await requeued()).toEqual([]);
  });

  it("puts the job back when nobody got it yet", async () => {
    const { run, requeued } = await due();
    await expect(
      run({
        async send() {
          throw new Error("provider down");
        },
      }),
    ).rejects.toThrow("provider down");
    expect(await requeued()).toHaveLength(1);
  });

  it("skips admins the provider refuses and still reaches the others", async () => {
    const { t, second, run } = await due();
    const sent: string[] = [];
    const { RecipientSuppressedError } = await import("../src/email.ts");
    const outcome = await run({
      async send(notice) {
        if (notice.to === t.admin.email) throw new RecipientSuppressedError();
        sent.push(notice.to);
      },
    });
    expect(outcome).toBe("done");
    expect(sent).toEqual([second.email]);
  });
});

describe("account deletion with memberships", () => {
  async function deletion(u: { id: string; email: string }) {
    const sessionId = await session(u.id);
    return requestAccountDeletion(db(), {
      userId: u.id,
      sessionId,
      confirmEmail: u.email,
      now: NOW,
    });
  }

  it("refuses the only admin of a workspace, and changes nothing", async () => {
    const t = await team();
    const { artifactId } = await publishAs(t.admin.id, t.admin.id);
    expect(await soleAdminOf(db().global, t.admin.id)).toBe(t.id);
    expect(await deletion(t.admin)).toEqual({
      ok: false,
      code: "sole_workspace_admin",
      message:
        "You are the only admin of a workspace. Make another member its admin first, or ask Portifact at hello@portifact.com to delete the workspace, then delete your account.",
    });
    const [account] = await db().select().from(schema.users).where(eq(schema.users.id, t.admin.id));
    expect(account).toBeDefined();
    const [own] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(own?.state).toBe("active");
  });

  it("fails the whole batch when the last other admin leaves between the check and the delete", async () => {
    const t = await team();
    const other = await user();
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: other.id, role: "admin", updatedAt: NOW });
    const sessionId = await session(t.admin.id);
    const base = db();
    let raced = false;
    // The other admin's membership disappears right before the deletion batch runs.
    const racing = new Proxy(base, {
      get(target, property, receiver) {
        if (property !== "batch" || raced) return Reflect.get(target, property, receiver);
        return async (statements: Parameters<typeof base.batch>[0]) => {
          raced = true;
          await base
            .delete(schema.workspaceMembers)
            .where(
              and(
                eq(schema.workspaceMembers.workspaceId, t.id),
                eq(schema.workspaceMembers.userId, other.id),
              ),
            );
          return target.batch(statements);
        };
      },
    }) as typeof base;
    expect(
      await requestAccountDeletion(racing, {
        userId: t.admin.id,
        sessionId,
        confirmEmail: t.admin.email,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "sole_workspace_admin" });
    const [deletions] = await db()
      .select()
      .from(schema.accountDeletions)
      .where(eq(schema.accountDeletions.userId, t.admin.id));
    expect(deletions).toBeUndefined();
  });

  it("removes the memberships with the account and keeps the workspace's artifacts", async () => {
    const t = await team();
    const { artifactId } = await publishAs(t.editor.id, t.id);
    expect(await deletion(t.editor)).toEqual({ ok: true, value: { deleted: true } });
    const memberships = await db()
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, t.id));
    expect(memberships.map((row) => row.userId).sort()).toEqual([t.admin.id, t.member.id].sort());
    const [artifact] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(artifact).toMatchObject({ ownerId: t.id, state: "active" });
    // A member and an editor are never the only admin.
    expect(await deletion(t.member)).toEqual({ ok: true, value: { deleted: true } });
  });
});
