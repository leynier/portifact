// GET /api/v1/artifacts/:id/page-text, the text of a page for "Suggest a text change" (decision
// 0027). The service's rules are tested in packages/services/test/page-text.test.ts.
import { env } from "cloudflare:workers";
import { PageText } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness } from "./harness.ts";

const db = () => regionsFromEnv(env).get("default").db;
const SCOPES = "artifacts:read artifacts:write annotations:read annotations:write offline_access";

let h: Harness;
let owner: TokenClient;
let artifactId: string;
const url = (path = "index.html") =>
  `/api/v1/artifacts/${artifactId}/page-text?path=${encodeURIComponent(path)}`;

function read(path: string, cookie = owner.cookie, harness = h) {
  return harness.request(path, { headers: { cookie, "sec-fetch-site": "same-origin" } });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
  h = createHarness({ env: { SUGGESTIONS_ENABLED: "true" } });
  owner = await tokenClient(h, `page-text-${crypto.randomUUID()}@example.test`, SCOPES);
  artifactId = await publishSite(owner, "Plan text");
  await db()
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, artifactId));
});

describe("GET .../page-text", () => {
  it("gives the shown text of a page of the current version", async () => {
    const response = await read(url());
    expect(response.status).toBe(200);
    expect(PageText.parse(await response.json())).toMatchObject({
      state: "ready",
      path: "index.html",
      text: "Plan text",
    });
  });

  it("needs a path", async () => {
    expect((await read(`/api/v1/artifacts/${artifactId}/page-text`)).status).toBe(400);
  });

  it("refuses bearer tokens", async () => {
    expect((await owner.call(url())).status).toBe(403);
  });

  it("answers a stranger like a missing artifact", async () => {
    const stranger = await tokenClient(h, `stranger-${crypto.randomUUID()}@example.test`, SCOPES);
    expect((await read(url(), stranger.cookie)).status).toBe(404);
    expect((await read("/api/v1/artifacts/a_missing/page-text?path=index.html")).status).toBe(404);
  });

  it("answers 404 while suggestions are switched off", async () => {
    expect((await read(url(), owner.cookie, createHarness())).status).toBe(404);
  });
});
