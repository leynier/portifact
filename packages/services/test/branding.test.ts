// The owner's brand on the viewer's bar (premium plan P9): who manages it, the plan that allows
// it, the logo's storage and its R2 object, what the viewer and the content Worker get, the
// operator's suspension, and the brand going with its owner.
import { env } from "cloudflare:test";
import {
  BRAND_LOGO_PATH,
  type BrandUpdate,
  brandLogoKey,
  planRequiredMessage,
  type WorkspaceRole,
} from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { type Actor, personalActor } from "@portifact/domain";
import { jpeg, png, text } from "@portifact/domain/testing/images";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  advanceAccountDeletion,
  exportAccount,
  requestAccountDeletion,
} from "../src/account-data.ts";
import { actorOn, resolveActor } from "../src/actors.ts";
import { applyTombstones } from "../src/backups.ts";
import {
  brandLogoUrl,
  deleteBrand,
  findBrandLogo,
  getBrandSettings,
  readBrandLogo,
  reinstateBrand,
  removeBrandLogo,
  setBrandLogo,
  showBrand,
  suspendBrand,
  updateBrand,
} from "../src/branding.ts";
import { archiveArtifact } from "../src/lifecycle.ts";
import { runJob } from "../src/outbox.ts";
import { getViewerArtifact } from "../src/viewer.ts";
import { DAY, db, grantPlan, NOW, publishSite, racing, session, user, value } from "./fixtures.ts";

const OWN = ["app.portifact.test", "portifact-content.test"];
const BRAND: BrandUpdate = {
  name: "Acme",
  accentColor: "#1a2b3c",
  link: "https://acme.example.com",
};

async function paid(): Promise<{ id: string; email: string; actor: Actor }> {
  const owner = await user("Ada");
  await grantPlan(owner.id, "pro");
  return { ...owner, actor: personalActor(owner.id) };
}

async function stored(ownerId: string): Promise<number> {
  const [row] = await db()
    .select({ bytes: schema.accountUsage.storedBytes })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId));
  return row?.bytes ?? 0;
}

async function deleteJobs(ownerId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "delete_objects"), eq(schema.outbox.subject, ownerId)));
}

async function branded(actor: Actor, update = BRAND) {
  return value(await updateBrand(db(), { actor, update, blockedHosts: OWN, now: NOW }));
}

async function workspace(roles: Partial<Record<WorkspaceRole, string>>) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const creator = roles.admin ?? roles.editor ?? roles.member ?? "nobody";
  await db()
    .insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: creator, updatedAt: NOW });
  for (const [role, userId] of Object.entries(roles)) {
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId, role: role as WorkspaceRole, updatedAt: NOW });
  }
  return id;
}

const refusedOnPlan = {
  ok: false,
  code: "plan_required",
  message: planRequiredMessage("branding"),
};

describe("who manages a brand and which plan allows it", () => {
  it("refuses setting a brand or a logo on free with plan_required, and allows them on pro", async () => {
    const owner = await user("Free");
    const actor = personalActor(owner.id);
    expect(await updateBrand(db(), { actor, update: BRAND, blockedHosts: OWN, now: NOW })).toEqual(
      refusedOnPlan,
    );
    expect(await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: png(), now: NOW })).toEqual(
      refusedOnPlan,
    );
    // Reading says what the plan lacks, never with the caller's plan.
    expect(value(await getBrandSettings(db(), { actor, now: NOW }))).toEqual({
      available: false,
      lowestPlan: "pro",
      suspended: false,
      brand: null,
    });

    await grantPlan(owner.id, "pro");
    const settings = await branded(actor);
    expect(settings).toMatchObject({
      available: true,
      brand: {
        name: "Acme",
        accentColor: "#1a2b3c",
        link: "https://acme.example.com/",
        logo: null,
      },
    });
  });

  it("lets only a workspace's admins manage its brand, by the workspace's plan", async () => {
    const [admin, editor, member, stranger] = await Promise.all([
      user("Admin"),
      user("Editor"),
      user("Member"),
      user("Stranger"),
    ]);
    const ws = await workspace({ admin: admin.id, editor: editor.id, member: member.id });
    const as = async (id: string) => value(await actorOn(db().global, id, ws)) as Actor;

    // The admin's own paid plan does not reach a free workspace.
    await grantPlan(admin.id, "enterprise");
    expect(
      await updateBrand(db(), {
        actor: await as(admin.id),
        update: BRAND,
        blockedHosts: OWN,
        now: NOW,
      }),
    ).toEqual(refusedOnPlan);

    await grantPlan(ws, "team");
    expect((await branded(await as(admin.id))).brand?.name).toBe("Acme");
    const forbidden = {
      ok: false,
      code: "forbidden",
      message: "Your role on this workspace does not allow this.",
    };
    for (const id of [editor.id, member.id]) {
      const actor = await as(id);
      expect(await getBrandSettings(db(), { actor, now: NOW })).toEqual(forbidden);
      expect(
        await updateBrand(db(), { actor, update: BRAND, blockedHosts: OWN, now: NOW }),
      ).toEqual(forbidden);
      expect(await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: png(), now: NOW })).toEqual(
        forbidden,
      );
      expect(await removeBrandLogo(db(), { actor, now: NOW })).toEqual(forbidden);
      expect(await deleteBrand(db(), { actor, now: NOW })).toEqual(forbidden);
    }
    // Someone with no role gets exactly what an owner that does not exist gives.
    const missing = await resolveActor(db().global, stranger.id, `ws_${"0".repeat(32)}`);
    expect(await resolveActor(db().global, stranger.id, ws)).toEqual(missing);
    expect(missing).toEqual({ ok: false, code: "not_found", message: "Not found." });
  });

  it("checks the name and link and keeps them normalized", async () => {
    const { actor } = await paid();
    expect(
      await updateBrand(db(), {
        actor,
        update: { ...BRAND, name: "Portifact Support" },
        blockedHosts: OWN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await updateBrand(db(), {
        actor,
        update: { ...BRAND, link: "https://app.portifact.test/login" },
        blockedHosts: OWN,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      code: "invalid_input",
      message: "link: Link to your own site, not to Portifact.",
    });
    const saved = await branded(actor, { name: "  Acme   Labs ", accentColor: null, link: " " });
    expect(saved.brand).toMatchObject({ name: "Acme Labs", accentColor: null, link: null });
    // A second save changes the same row.
    const again = await branded(actor, { ...BRAND, accentColor: "#ffffff" });
    expect(again.brand).toMatchObject({ name: "Acme", accentColor: "#ffffff" });
  });
});

describe("the logo", () => {
  it("needs the brand first, and refuses bad bytes before storing anything", async () => {
    const { id, actor } = await paid();
    expect(await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: png(), now: NOW })).toEqual({
      ok: false,
      code: "invalid_input",
      message: "logo: Save the brand's name before adding a logo.",
    });
    await branded(actor);
    expect(
      await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: text("<svg/>"), now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await deleteJobs(id)).toEqual([]);
    expect((await env.ARTIFACTS.list({ prefix: `brands/${id}/` })).objects).toEqual([]);
    expect(await stored(id)).toBe(0);
  });

  it("stores the logo in R2, counts it in storage and releases the old one on replace", async () => {
    const { id, actor } = await paid();
    await publishSite(id);
    await branded(actor);
    const before = await stored(id);
    const first = png({ width: 64, height: 32 });
    const settings = value(
      await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: first, now: NOW }),
    );
    const sha = settings.brand?.logo?.sha256 as string;
    expect(settings.brand?.logo).toEqual({
      sha256: sha,
      type: "image/png",
      width: 64,
      height: 32,
      bytes: first.length,
    });
    expect(await stored(id)).toBe(before + first.length);
    const object = await env.ARTIFACTS.get(brandLogoKey(id, sha));
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array(await (object as R2ObjectBody).arrayBuffer())).toEqual(first);

    // The same bytes again change nothing.
    expect(
      value(await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: first, now: NOW })).brand?.logo
        ?.sha256,
    ).toBe(sha);
    expect(await stored(id)).toBe(before + first.length);

    const second = jpeg({ width: 300, height: 100 });
    const replaced = value(
      await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: second, now: NOW }),
    );
    expect(replaced.brand?.logo).toMatchObject({ type: "image/jpeg", width: 300, height: 100 });
    expect(await stored(id)).toBe(before + second.length);
    // The old key is in a delete job; running every job deletes it and keeps the one named.
    const jobs = await deleteJobs(id);
    expect(jobs.flatMap((job) => (job.payload as { keys: string[] }).keys)).toContain(
      brandLogoKey(id, sha),
    );
    for (const job of jobs) {
      expect(await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "delete_objects" }, NOW)).toBe(
        "done",
      );
    }
    expect(await env.ARTIFACTS.head(brandLogoKey(id, sha))).toBeNull();
    const current = replaced.brand?.logo?.sha256 as string;
    expect(await env.ARTIFACTS.head(brandLogoKey(id, current))).not.toBeNull();

    // Removing it releases the bytes and deletes the object through its job.
    const removed = value(await removeBrandLogo(db(), { actor, now: NOW }));
    expect(removed.brand?.logo).toBeNull();
    expect(await stored(id)).toBe(before);
    for (const job of await deleteJobs(id)) {
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "delete_objects" }, NOW);
    }
    expect(await env.ARTIFACTS.head(brandLogoKey(id, current))).toBeNull();
    // Removing again is a no-op.
    expect(value(await removeBrandLogo(db(), { actor, now: NOW })).brand?.logo).toBeNull();
  });

  it("keeps a logo uploaded again while its old delete job waits", async () => {
    const { id, actor } = await paid();
    await branded(actor);
    const logo = png();
    const sha = value(await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: logo, now: NOW }))
      .brand?.logo?.sha256 as string;
    await removeBrandLogo(db(), { actor, now: NOW });
    await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: logo, now: NOW });
    for (const job of await deleteJobs(id)) {
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "delete_objects" }, NOW);
    }
    expect(await env.ARTIFACTS.head(brandLogoKey(id, sha))).not.toBeNull();
  });

  it("refuses a logo that does not fit in the owner's storage", async () => {
    const { id, actor } = await paid();
    await publishSite(id);
    await branded(actor);
    // The database's limit is the safety net: leave fewer bytes than the logo needs.
    await db()
      .update(schema.accountUsage)
      .set({ bytesLimit: (await stored(id)) + 10 })
      .where(eq(schema.accountUsage.ownerId, id));
    expect(await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: png(), now: NOW })).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "logo: Your storage is full (25 GB on your plan). Delete something first.",
    });
    expect(value(await getBrandSettings(db(), { actor, now: NOW })).brand?.logo).toBeNull();
    // Its bytes went to R2 first; the safety-net job deletes them because nothing names them.
    const [job] = await deleteJobs(id);
    await runJob(db(), env.ARTIFACTS, { id: job?.id as number, topic: "delete_objects" }, NOW);
    expect((await env.ARTIFACTS.list({ prefix: `brands/${id}/` })).objects).toEqual([]);
  });

  it("answers a conflict when the brand changed between reading and writing", async () => {
    const { actor } = await paid();
    await branded(actor);
    const raced = racing(() => branded(actor, { ...BRAND, name: "Changed" }));
    expect(await setBrandLogo(raced, env.ARTIFACTS, { actor, bytes: png(), now: NOW })).toEqual({
      ok: false,
      code: "version_conflict",
      message: "The brand changed meanwhile. Reload the page and try again.",
    });
    expect(value(await getBrandSettings(db(), { actor, now: NOW })).brand).toMatchObject({
      name: "Changed",
      logo: null,
    });
  });

  it("is read back for the preview by its admins only", async () => {
    const { actor } = await paid();
    await branded(actor);
    expect(await readBrandLogo(db(), env.ARTIFACTS, { actor })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const bytes = png();
    await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes, now: NOW });
    const read = value(await readBrandLogo(db(), env.ARTIFACTS, { actor }));
    expect(read.type).toBe("image/png");
    expect(new Uint8Array(await new Response(read.body).arrayBuffer())).toEqual(bytes);
  });
});

describe("what the viewer and the logo route get", () => {
  async function brandedArtifact() {
    const owner = await paid();
    const { artifactId } = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "public" })
      .where(eq(schema.artifacts.id, artifactId));
    await branded(owner.actor);
    const sha = value(
      await setBrandLogo(db(), env.ARTIFACTS, { actor: owner.actor, bytes: png(), now: NOW }),
    ).brand?.logo?.sha256 as string;
    return { owner, artifactId, sha };
  }

  it("brands the viewer of a paid owner's artifact for every visitor allowed to see it", async () => {
    const { owner, artifactId, sha } = await brandedArtifact();
    const expected = {
      name: "Acme",
      accentColor: "#1a2b3c",
      link: "https://acme.example.com/",
      logo: { sha256: sha, width: 64, height: 32 },
    };
    for (const userId of [null, owner.id, (await user("Reader")).id]) {
      const found = value(
        await getViewerArtifact(db(), { customDomains: true, artifactId, userId, now: NOW }),
      );
      expect(found.brand, String(userId)).toEqual(expected);
    }
    expect(await findBrandLogo(db(), { artifactId, sha256: sha, now: NOW })).toEqual({
      key: brandLogoKey(owner.id, sha),
      type: "image/png",
    });
    expect(brandLogoUrl("https://a.portifact.dev", sha)).toBe(
      `https://a.portifact.dev${BRAND_LOGO_PATH}${sha}`,
    );
  });

  it("shows the default bar once the plan lapses, and the brand again when it returns", async () => {
    const { owner, artifactId, sha } = await brandedArtifact();
    await grantPlan(owner.id, "pro", { validUntil: NOW - 1 });
    expect(
      value(
        await getViewerArtifact(db(), { customDomains: true, artifactId, userId: null, now: NOW }),
      ).brand,
    ).toBeNull();
    expect(await findBrandLogo(db(), { artifactId, sha256: sha, now: NOW })).toBeNull();
    // The brand is kept, unused, and the owner can still see and delete it.
    const kept = value(await getBrandSettings(db(), { actor: owner.actor, now: NOW }));
    expect(kept).toMatchObject({ available: false, brand: { name: "Acme" } });
    await grantPlan(owner.id, "pro");
    expect(
      value(
        await getViewerArtifact(db(), { customDomains: true, artifactId, userId: null, now: NOW }),
      ).brand?.name,
    ).toBe("Acme");
  });

  it("shows the default bar for a suspended brand, which its owner cannot delete", async () => {
    const { owner, artifactId, sha } = await brandedArtifact();
    expect(
      value(await suspendBrand(db(), { ownerId: owner.id, reason: "impersonation", now: NOW })),
    ).toEqual({
      suspended: true,
    });
    expect(
      value(await suspendBrand(db(), { ownerId: owner.id, reason: "phishing", now: NOW })),
    ).toEqual({
      suspended: false,
    });
    expect(
      value(
        await getViewerArtifact(db(), { customDomains: true, artifactId, userId: null, now: NOW }),
      ).brand,
    ).toBeNull();
    expect(await findBrandLogo(db(), { artifactId, sha256: sha, now: NOW })).toBeNull();
    expect(value(await getBrandSettings(db(), { actor: owner.actor, now: NOW })).suspended).toBe(
      true,
    );
    expect(await deleteBrand(db(), { actor: owner.actor, now: NOW })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await showBrand(db(), owner.id, NOW)).toMatchObject({
      suspendedAt: NOW,
      suspensionReason: "impersonation",
      shown: false,
    });
    expect(value(await reinstateBrand(db(), { ownerId: owner.id, now: NOW }))).toEqual({
      reinstated: true,
    });
    expect(value(await reinstateBrand(db(), { ownerId: owner.id, now: NOW }))).toEqual({
      reinstated: false,
    });
    expect(
      value(
        await getViewerArtifact(db(), { customDomains: true, artifactId, userId: null, now: NOW }),
      ).brand?.name,
    ).toBe("Acme");
    const nobody = `u_${crypto.randomUUID()}`;
    expect(await suspendBrand(db(), { ownerId: nobody, reason: "spam", now: NOW })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await reinstateBrand(db(), { ownerId: nobody, now: NOW })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("serves only the current logo of a servable artifact", async () => {
    const { owner, artifactId, sha } = await brandedArtifact();
    expect(await findBrandLogo(db(), { artifactId, sha256: "f".repeat(64), now: NOW })).toBeNull();
    expect(await findBrandLogo(db(), { artifactId, sha256: "../../x", now: NOW })).toBeNull();
    const other = await publishSite((await user("Other")).id);
    expect(
      await findBrandLogo(db(), { artifactId: other.artifactId, sha256: sha, now: NOW }),
    ).toBeNull();
    // An expired artifact is not servable.
    const expiry = (
      await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, artifactId))
    )[0]?.expiresAt as number;
    expect(await findBrandLogo(db(), { artifactId, sha256: sha, now: expiry })).toBeNull();
    value(await archiveArtifact(db(), { userId: owner.id, artifactId, now: NOW }));
    expect(await findBrandLogo(db(), { artifactId, sha256: sha, now: NOW })).toBeNull();
  });

  it("never brands an owner without a brand, with no extra read", async () => {
    const owner = await paid();
    const { artifactId } = await publishSite(owner.id);
    expect(
      value(
        await getViewerArtifact(db(), {
          customDomains: true,
          artifactId,
          userId: owner.id,
          now: NOW,
        }),
      ).brand,
    ).toBeNull();
  });
});

describe("the brand goes with its owner", () => {
  it("is in the account export, kept whatever the plan", async () => {
    const { id, actor } = await paid();
    await branded(actor);
    await grantPlan(id, "free");
    const exported = value(await exportAccount(db(), { userId: id, now: NOW }));
    expect(exported.account.brand).toMatchObject({
      name: "Acme",
      link: "https://acme.example.com/",
    });
  });

  it("is erased with its logo when the account is deleted", async () => {
    const owner = await paid();
    await branded(owner.actor);
    const sha = value(
      await setBrandLogo(db(), env.ARTIFACTS, { actor: owner.actor, bytes: png(), now: NOW }),
    ).brand?.logo?.sha256 as string;
    const sid = await session(owner.id, NOW);
    value(
      await requestAccountDeletion(regionsFromEnv(env), {
        userId: owner.id,
        sessionId: sid,
        confirmEmail: owner.email,
        now: NOW,
      }),
    );
    for (let i = 0; i < 5; i += 1) {
      if ((await advanceAccountDeletion(regionsFromEnv(env), owner.id, NOW + DAY)) !== "pending")
        break;
    }
    expect(await showBrand(db(), owner.id, NOW)).toMatchObject({ brand: null });
    expect(await env.ARTIFACTS.head(brandLogoKey(owner.id, sha))).toBeNull();
  });

  it("is deleted again when a restore brings back a deleted account's brand", async () => {
    const owner = await paid();
    await branded(owner.actor);
    // A restore brought back only the brand of an account deleted since.
    await db().delete(schema.users).where(eq(schema.users.id, owner.id));
    const applied = await applyTombstones(
      db(),
      [{ kind: "account", id: owner.id, deletedAt: NOW }],
      NOW,
    );
    expect(applied.accounts).toBe(1);
    expect(await advanceAccountDeletion(regionsFromEnv(env), owner.id, NOW)).toBe("finished");
    expect(await showBrand(db(), owner.id, NOW)).toMatchObject({ brand: null });
  });

  it("is deleted by its owner on any plan, releasing the logo", async () => {
    const { id, actor } = await paid();
    await branded(actor);
    const bytes = png();
    await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes, now: NOW });
    expect(await stored(id)).toBe(bytes.length);
    await grantPlan(id, "free");
    expect(value(await deleteBrand(db(), { actor, now: NOW }))).toEqual({
      available: false,
      lowestPlan: "pro",
      suspended: false,
      brand: null,
    });
    expect(await stored(id)).toBe(0);
    expect(await deleteJobs(id)).toHaveLength(2);
    // Deleting nothing is fine too.
    expect(value(await deleteBrand(db(), { actor, now: NOW })).brand).toBeNull();
  });

  it("answers a conflict when deleting a brand that changed meanwhile", async () => {
    const { actor } = await paid();
    await branded(actor);
    const raced = racing(() => branded(actor, { ...BRAND, name: "Changed" }));
    expect(await deleteBrand(raced, { actor, now: NOW })).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
  });
});
