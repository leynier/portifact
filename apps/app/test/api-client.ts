// An API client for tests: a CLI token for a signed-in user, and a site published with it.
import { env } from "cloudflare:workers";
import { ANNOTATION_LIMITS } from "@portifact/contracts";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { approveDevice, pollDeviceToken, requestDeviceCode } from "./flows.ts";
import type { Harness } from "./harness.ts";

export interface TokenClient {
  /** The session cookie of the same user, as the dashboard would hold it. */
  cookie: string;
  userId: string;
  call(path: string, init?: RequestInit): Promise<Response>;
}

const ALL = "artifacts:read artifacts:write artifacts:delete offline_access";

export async function tokenClient(h: Harness, email: string, scope = ALL): Promise<TokenClient> {
  const cookie = await h.signIn(email);
  const device = await requestDeviceCode(h, CLI_CLIENT_ID, scope);
  await approveDevice(h, cookie, device.user_code);
  const { access_token: token } = await (
    await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code)
  ).json<{ access_token: string }>();
  const call = (path: string, init: RequestInit = {}) =>
    h.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  const { userId } = await (await call("/api/v1/me")).json<{ userId: string }>();
  return { cookie, userId, call };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Publishes a one-page site and returns its artifact ID. */
export async function publishSite(c: TokenClient, name = "Plan"): Promise<string> {
  const body = `<h1>${name}</h1>`;
  const hash = await sha256(body);
  const prepared = await c.call("/api/v1/publishes", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      type: "site",
      name,
      entrypoint: "index.html",
      files: [{ path: "index.html", sha256: hash, size: body.length, contentType: "text/html" }],
    }),
  });
  if (prepared.status !== 201) throw new Error(`prepare failed with ${prepared.status}`);
  const { uploadId, artifactId } = await prepared.json<{ uploadId: string; artifactId: string }>();
  await env.ARTIFACTS.put(`objects/${c.userId}/${hash}`, body, { sha256: hash });
  const commit = await c.call(`/api/v1/publishes/${uploadId}/commit`, { method: "POST" });
  if (commit.status !== 200) throw new Error(`commit failed with ${commit.status}`);
  return artifactId;
}

/**
 * Seeds comments by these accounts on `artifactId` (which none of them owns), long ago, so they
 * are past the human check of their first comments. Tests about something else use it; the
 * human-check tests start from a fresh account instead.
 */
export async function pastHumanCheck(emails: string[], artifactId: string): Promise<void> {
  for (const email of emails) {
    const user = await env.DB.prepare("select id from users where email = ?")
      .bind(email)
      .first<{ id: string }>();
    if (!user) throw new Error(`no account for ${email}`);
    for (let i = 0; i < ANNOTATION_LIMITS.humanCheckedComments; i++) {
      await env.DB.prepare(
        "insert into annotation_events (artifact_id, thread_id, actor_id, write_id, kind, at) values (?, 'seed', ?, ?, 'message_created', 0)",
      )
        .bind(artifactId, user.id, crypto.randomUUID())
        .run();
    }
  }
}
