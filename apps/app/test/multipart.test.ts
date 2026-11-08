import { env } from "cloudflare:workers";
import { PreparedPublish } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { UPLOAD_URL_TTL_SECONDS } from "../src/api/presign.ts";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { approveDevice, pollDeviceToken, requestDeviceCode } from "./flows.ts";
import { createHarness, type Harness } from "./harness.ts";

const MiB = 1024 * 1024;
const SIZE = 12 * MiB;
const MULTIPART = { thresholdBytes: 6 * MiB, partBytes: 5 * MiB };
const ALL = "artifacts:read artifacts:write artifacts:delete offline_access";
const PAGE = new TextEncoder().encode("<h1>Large</h1>");

interface Client {
  userId: string;
  call(path: string, init?: RequestInit): Promise<Response>;
}

async function client(h: Harness, email: string, scope = ALL): Promise<Client> {
  const cookie = await h.signIn(email);
  const device = await requestDeviceCode(h, CLI_CLIENT_ID, scope);
  await approveDevice(h, cookie, device.user_code);
  const tokens = await (await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code)).json<{
    access_token: string;
  }>();
  const call = (path: string, init: RequestInit = {}) =>
    h.request(path, {
      ...init,
      headers: { authorization: `Bearer ${tokens.access_token}`, ...(init.headers ?? {}) },
    });
  const me = await (await call("/api/v1/me")).json<{ userId: string }>();
  return { userId: me.userId, call };
}

function bytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 7) & 255;
  return out;
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, method = "POST", key?: string): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  };
}

async function prepare(c: Client, data: Uint8Array, multipart: boolean | undefined) {
  const response = await c.call(
    "/api/v1/publishes",
    json(
      {
        type: "site",
        name: "Large",
        entrypoint: "index.html",
        files: [
          {
            path: "index.html",
            sha256: await sha256(PAGE),
            size: PAGE.length,
            contentType: "text/html",
          },
          {
            path: "data.bin",
            sha256: await sha256(data),
            size: data.length,
            contentType: "application/octet-stream",
          },
        ],
        ...(multipart === undefined ? {} : { multipart }),
      },
      "POST",
      crypto.randomUUID(),
    ),
  );
  expect(response.status).toBe(201);
  return PreparedPublish.parse(await response.json());
}

async function progress(c: Client, uploadId: string) {
  const response = await c.call(`/api/v1/publishes/${uploadId}`);
  expect(response.status).toBe(200);
  return PreparedPublish.parse(await response.json());
}

/** What a client does with a part URL: here the part lands through the R2 binding. */
async function putPart(url: string, data: Uint8Array, offset: number, size: number) {
  const parsed = new URL(url);
  const key = decodeURIComponent(parsed.pathname.replace(/^\/portifact-artifacts\//, ""));
  const uploadId = parsed.searchParams.get("uploadId") ?? "";
  const partNumber = Number(parsed.searchParams.get("partNumber"));
  return env.ARTIFACTS.resumeMultipartUpload(key, uploadId).uploadPart(
    partNumber,
    data.slice(offset, offset + size),
  );
}

describe("multipart uploads through the API", () => {
  it("signs one URL per part, resumes from reported parts and commits", async () => {
    const h = createHarness({ multipart: MULTIPART });
    const c = await client(h, "multipart@example.test");
    const data = bytes(SIZE);
    const prepared = await prepare(c, data, true);
    const large = prepared.uploads.find((upload) => upload.method === "MULTIPART");
    const small = prepared.uploads.find((upload) => upload.method === "PUT");
    if (large?.method !== "MULTIPART" || !small) throw new Error("unexpected targets");
    expect(large).toMatchObject({ size: SIZE, partSize: 5 * MiB, partCount: 3, doneParts: [] });
    expect(large.parts.map((part) => [part.partNumber, part.offset, part.size])).toEqual([
      [1, 0, 5 * MiB],
      [2, 5 * MiB, 5 * MiB],
      [3, 10 * MiB, 2 * MiB],
    ]);
    const first = large.parts[0];
    if (!first) throw new Error("no part");
    const url = new URL(first.url);
    // Parts go to the session's staging key, never to the object's shared key.
    expect(url.pathname).toBe(
      `/portifact-artifacts/uploads/${c.userId}/${prepared.uploadId}/${large.sha256}`,
    );
    expect(url.searchParams.get("partNumber")).toBe("1");
    expect(url.searchParams.get("uploadId")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_URL_TTL_SECONDS));
    expect(first.url).not.toContain(env.R2_SECRET_ACCESS_KEY);
    expect(first.headers).toEqual({ "content-length": String(5 * MiB) });

    await env.ARTIFACTS.put(`objects/${c.userId}/${small.sha256}`, PAGE, { sha256: small.sha256 });
    const sent = await putPart(first.url, data, first.offset, first.size);
    const report = await c.call(
      `/api/v1/publishes/${prepared.uploadId}/parts`,
      json({ sha256: large.sha256, partNumber: 1, etag: sent.etag }),
    );
    expect(report.status).toBe(204);

    // Interrupted here. Progress says part 1 is done and signs only parts 2 and 3.
    const resumed = await progress(c, prepared.uploadId);
    const again = resumed.uploads.find((upload) => upload.sha256 === large.sha256);
    if (again?.method !== "MULTIPART") throw new Error("not multipart");
    expect(again.doneParts).toEqual([1]);
    expect(again.parts.map((part) => part.partNumber)).toEqual([2, 3]);
    for (const part of again.parts) {
      const stored = await putPart(part.url, data, part.offset, part.size);
      const reported = await c.call(
        `/api/v1/publishes/${prepared.uploadId}/parts`,
        json({ sha256: large.sha256, partNumber: part.partNumber, etag: stored.etag }),
      );
      expect(reported.status).toBe(204);
    }

    const commit = await c.call(`/api/v1/publishes/${prepared.uploadId}/commit`, {
      method: "POST",
    });
    expect(commit.status).toBe(200);
    expect((await env.ARTIFACTS.head(`objects/${c.userId}/${large.sha256}`))?.size).toBe(SIZE);
  });

  it("gives a client that does not ask for multipart one PUT per object", async () => {
    const h = createHarness({ multipart: MULTIPART });
    const c = await client(h, "single@example.test");
    const prepared = await prepare(c, bytes(SIZE), undefined);
    expect(prepared.uploads.map((upload) => upload.method)).toEqual(["PUT", "PUT"]);
  });

  it("validates part reports and keeps them to the upload's owner and the write scope", async () => {
    const h = createHarness({ multipart: MULTIPART });
    const c = await client(h, "parts-owner@example.test");
    const data = bytes(SIZE);
    const prepared = await prepare(c, data, true);
    const large = prepared.uploads.find((upload) => upload.method === "MULTIPART");
    if (!large) throw new Error("no multipart target");
    const path = `/api/v1/publishes/${prepared.uploadId}/parts`;

    expect(
      (await c.call(path, json({ sha256: large.sha256, partNumber: 0, etag: "e" }))).status,
    ).toBe(400);
    expect(
      (await c.call(path, json({ sha256: large.sha256, partNumber: 9, etag: "e" }))).status,
    ).toBe(400);
    expect(
      (await c.call(path, json({ sha256: large.sha256, partNumber: 1, etag: "e", extra: 1 })))
        .status,
    ).toBe(400);

    const other = await client(h, "parts-other@example.test");
    expect(
      (await other.call(path, json({ sha256: large.sha256, partNumber: 1, etag: "e" }))).status,
    ).toBe(404);

    const reader = await client(h, "parts-reader@example.test", "artifacts:read");
    expect(
      (await reader.call(path, json({ sha256: large.sha256, partNumber: 1, etag: "e" }))).status,
    ).toBe(403);

    expect(
      (await c.call(`/api/v1/publishes/${prepared.uploadId}`, { method: "DELETE" })).status,
    ).toBe(204);
    const closed = await c.call(path, json({ sha256: large.sha256, partNumber: 1, etag: "e" }));
    expect(closed.status).toBe(409);
    expect((await closed.json<{ error: { code: string } }>()).error.code).toBe("upload_incomplete");
  });
});
