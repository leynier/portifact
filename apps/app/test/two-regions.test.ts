// Publishing to an EU workspace through the API (decision 0005, "Two-region audit"): the upload
// session, the artifact and its objects are the EU region's, the presigned URLs target the EU
// jurisdiction's S3 endpoint, and the dashboard's policy allows exactly that endpoint besides the
// default one.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { r2Presigner, storageEndpoint } from "../src/api/presign.ts";
import { dashboardCsp, storageOrigins } from "../src/app-host.ts";
import { tokenClient } from "./api-client.ts";
import { createHarness } from "./harness.ts";

const EU_BUCKET = "portifact-artifacts-eu";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the EU bucket's endpoint", () => {
  it("signs against the jurisdiction's own host, and the default bucket's stays as it was", async () => {
    expect(storageEndpoint("acct")).toBe("https://acct.r2.cloudflarestorage.com");
    expect(storageEndpoint("acct", "eu")).toBe("https://acct.eu.r2.cloudflarestorage.com");
    const presigner = r2Presigner({
      accountId: "acct",
      bucket: EU_BUCKET,
      jurisdiction: "eu",
      accessKeyId: "id",
      secretAccessKey: "secret",
    });
    const url = new URL(
      (await presigner.presignPut("objects/ws/abc", 3, "a".repeat(64), Date.now())).url,
    );
    expect(url.host).toBe("acct.eu.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/${EU_BUCKET}/objects/ws/abc`);
  });

  it("is in the dashboard's policy only where the EU bucket is configured", async () => {
    expect(storageOrigins({ R2_ACCOUNT_ID: "acct", R2_BUCKET_EU: undefined })).toBe(
      "https://acct.r2.cloudflarestorage.com",
    );
    const policy = await dashboardCsp({ ...env, R2_BUCKET_EU: EU_BUCKET });
    expect(policy).toContain(
      `connect-src 'self' ${storageEndpoint(env.R2_ACCOUNT_ID)} ${storageEndpoint(env.R2_ACCOUNT_ID, "eu")}`,
    );
    expect(await dashboardCsp(env)).not.toContain(".eu.r2.cloudflarestorage.com");
  });
});

describe("publishing to an EU workspace through the API", () => {
  it("opens the upload in the EU region, presigns for the EU endpoint and commits there", async () => {
    const h = createHarness({ env: { R2_BUCKET_EU: EU_BUCKET } });
    const admin = await tokenClient(h, `eu-${crypto.randomUUID()}@example.com`);
    const regions = regionsFromEnv(env);
    const slug = `eu-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createWorkspace(regions.global, {
      slug,
      name: "EU",
      adminUserId: admin.userId,
      now: Date.now(),
      region: "eu",
    });
    if (!created.ok) throw new Error(created.message);
    await regions.global
      .insert(schema.ownerPlans)
      .values({ ownerId: created.value.id, plan: "enterprise", grantedBy: "test", updatedAt: 0 });
    const body = "<h1>EU</h1>";
    const hash = await sha256(body);
    const prepared = await admin.call(`/api/v1/publishes?workspace=${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        type: "site",
        name: "EU plan",
        entrypoint: "index.html",
        files: [{ path: "index.html", sha256: hash, size: body.length, contentType: "text/html" }],
      }),
    });
    expect(prepared.status).toBe(201);
    const upload = await prepared.json<{
      uploadId: string;
      artifactId: string;
      uploads: { url: string }[];
    }>();
    expect(new URL(upload.uploads[0]?.url ?? "").host).toBe(
      `${env.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
    );
    // The upload session is the EU database's, so its progress is found there too.
    const progress = await admin.call(`/api/v1/publishes/${upload.uploadId}`);
    expect(progress.status).toBe(200);
    await env.ARTIFACTS_EU.put(`objects/${created.value.id}/${hash}`, body, { sha256: hash });
    const commit = await admin.call(`/api/v1/publishes/${upload.uploadId}/commit`, {
      method: "POST",
    });
    expect(commit.status).toBe(200);
    const inEu = await regions
      .get("eu")
      .db.select({ state: schema.artifacts.state })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, upload.artifactId));
    expect(inEu).toEqual([{ state: "active" }]);
    const inDefault = await regions
      .get("default")
      .db.select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, upload.artifactId));
    expect(inDefault).toEqual([]);
    // The workspace's usage and audit log come from the EU database, its plan from the global one.
    const usage = await admin.call(`/api/v1/usage?workspace=${slug}`);
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ plan: { name: "enterprise" } });
    const audit = await admin.call(`/api/v1/audit?workspace=${slug}`);
    expect(audit.status).toBe(200);
    const events = (await audit.json<{ events: { kind: string }[] }>()).events;
    expect(events.map((event) => event.kind)).toContain("artifact.published");
  });
});
