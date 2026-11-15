// The adapters of comment attachments (decision 0029): the upload route behind
// `ATTACHMENTS_ENABLED`, session only; naming files on a new thread or reply, session only; the
// download link for people's tokens and the same answer from the MCP tool. The services' rules are
// tested in packages/services; these tests prove the wiring, the boundaries and the parity.
import { env } from "cloudflare:workers";
import {
  AnnotationThreadView,
  ATTACHMENT_LIMITS,
  AttachmentLink,
  PreparedAttachment,
} from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { attachmentKey } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { UPLOAD_URL_TTL_SECONDS } from "../src/api/presign.ts";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { callTool, connect, mcpToken } from "./mcp-helpers.ts";

const db = () => regionsFromEnv(env).get("default").db;
const ON = { ATTACHMENTS_ENABLED: "true" };
const SCOPES = "artifacts:read artifacts:write annotations:read annotations:write offline_access";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);

let h: Harness;
let owner: TokenClient;
let ownerEmail: string;
let artifactId: string;
let versionId: string;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A request from the dashboard's own pages with the session cookie. */
function session(
  path: string,
  cookie: string,
  init: { method?: string; body?: unknown; key?: string } = {},
) {
  return h.request(path, {
    method: init.method ?? "GET",
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.key ? { "idempotency-key": init.key } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const base = () => `/api/v1/artifacts/${artifactId}/annotations`;

async function prepare(cookie = owner.cookie) {
  return session(`${base()}/attachments`, cookie, {
    method: "POST",
    body: { name: "shot.png", size: PNG.length, sha256: await sha256(PNG) },
  });
}

/** Prepares an upload through the route and puts its bytes where the presigned PUT would. */
async function uploaded(cookie = owner.cookie): Promise<string> {
  const response = await prepare(cookie);
  expect(response.status).toBe(201);
  const body = PreparedAttachment.parse(await response.json());
  expect(body.upload.headers["x-amz-checksum-sha256"]).toBeTruthy();
  await env.ARTIFACTS.put(attachmentKey(artifactId, body.attachment.id), PNG, {
    sha256: await sha256(PNG),
  });
  return body.attachment.id;
}

function threadBody(attachments?: string[]) {
  return {
    versionId,
    target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
    body: "See the screenshot",
    ...(attachments ? { attachments } : {}),
  };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
  h = createHarness({ env: ON });
  ownerEmail = `att-owner-${crypto.randomUUID()}@example.test`;
  owner = await tokenClient(h, ownerEmail, SCOPES);
  artifactId = await publishSite(owner, "Plan");
  await db()
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, artifactId));
  const [row] = await db()
    .select({ v: schema.artifacts.currentVersionId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  versionId = row?.v ?? "";
});

describe("attachment routes", () => {
  it("uploads from the session, attaches to a thread and gives the same link to the API and MCP", async () => {
    const id = await uploaded();
    const created = await session(`${base()}/threads`, owner.cookie, {
      method: "POST",
      key: crypto.randomUUID(),
      body: threadBody([id]),
    });
    expect(created.status).toBe(201);
    const thread = AnnotationThreadView.parse(await created.json());
    expect(thread.messages[0]?.attachments?.[0]).toMatchObject({
      id,
      name: "shot.png",
      contentType: "image/png",
      size: PNG.length,
    });

    const viaApi = await owner.call(`${base()}/attachments/${id}`);
    expect(viaApi.status).toBe(200);
    expect(viaApi.headers.get("cache-control")).toBe("no-store");
    const link = AttachmentLink.parse(await viaApi.json());
    const url = new URL(link.url);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      "attachment; filename*=UTF-8''shot.png",
    );
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");

    const client = await connect(h, await mcpToken(h, ownerEmail, SCOPES));
    const tool = await callTool(client, "get_annotation_attachment", {
      artifactId,
      attachmentId: id,
    });
    const viaTool = AttachmentLink.parse(tool.structuredContent);
    expect(viaTool.attachment).toEqual(link.attachment);
    expect(new URL(viaTool.url).pathname).toBe(url.pathname);
  });

  it("answers a stranger and a missing file like a missing one, on both paths", async () => {
    const id = await uploaded();
    await session(`${base()}/threads`, owner.cookie, {
      method: "POST",
      key: crypto.randomUUID(),
      body: threadBody([id]),
    });
    const strangerEmail = `att-stranger-${crypto.randomUUID()}@example.test`;
    const stranger = await tokenClient(h, strangerEmail, SCOPES);
    const viaApi = await stranger.call(`${base()}/attachments/${id}`);
    expect(viaApi.status).toBe(404);
    const missing = await owner.call(`${base()}/attachments/nope`);
    expect(missing.status).toBe(404);
    const client = await connect(h, await mcpToken(h, strangerEmail, SCOPES));
    const tool = await callTool(client, "get_annotation_attachment", {
      artifactId,
      attachmentId: id,
    });
    expect(tool.structuredContent).toMatchObject({ error: { code: "not_found" } });
  });

  it("adds files only from the dashboard's session", async () => {
    const bearer = await owner.call(`${base()}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a.png", size: PNG.length, sha256: await sha256(PNG) }),
    });
    expect(bearer.status).toBe(403);
    const id = await uploaded();
    const named = await owner.call(`${base()}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(threadBody([id])),
    });
    expect(named.status).toBe(403);
    // Without files, a token still comments as before.
    const plain = await owner.call(`${base()}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(threadBody()),
    });
    expect(plain.status).toBe(201);
  });

  it("refuses bad uploads at the boundary", async () => {
    const big = await session(`${base()}/attachments`, owner.cookie, {
      method: "POST",
      body: { name: "a.png", size: 11 * 1024 * 1024, sha256: "a".repeat(64) },
    });
    expect(big.status).toBe(400);
    const badName = await session(`${base()}/attachments`, owner.cookie, {
      method: "POST",
      body: { name: "../a.png", size: 10, sha256: "a".repeat(64) },
    });
    expect(badName.status).toBe(400);
    const extra = await session(`${base()}/attachments`, owner.cookie, {
      method: "POST",
      body: { name: "a.png", size: 10, sha256: "a".repeat(64), contentType: "image/png" },
    });
    expect(extra.status).toBe(400);
  });
});

describe("upload links and the final cleanup", () => {
  it("deletes a removed file's bytes a second time only after any upload link expired", () => {
    expect(ATTACHMENT_LIMITS.finalCleanupDelayMs).toBeGreaterThan(UPLOAD_URL_TTL_SECONDS * 1000);
  });
});

describe("switched off", () => {
  it("adds nothing and registers no tool, but keeps a stored file readable", async () => {
    const id = await uploaded();
    await session(`${base()}/threads`, owner.cookie, {
      method: "POST",
      key: crypto.randomUUID(),
      body: threadBody([id]),
    });
    h = createHarness();
    expect((await prepare()).status).toBe(404);
    const named = await session(`${base()}/threads`, owner.cookie, {
      method: "POST",
      key: crypto.randomUUID(),
      body: threadBody([id]),
    });
    expect(named.status).toBe(400);
    expect((await owner.call(`${base()}/attachments/${id}`)).status).toBe(200);
    const client = await connect(h, await mcpToken(h, ownerEmail, SCOPES));
    await expect(
      callTool(client, "get_annotation_attachment", { artifactId, attachmentId: id }),
    ).rejects.toThrow(/not found/);
  });
});
