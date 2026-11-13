// The adversarial review of PR #267: route reproductions that fail without their fixes.
import { env } from "cloudflare:workers";
import { type EditOperation, Plan, SuggestionThreadView } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const db = () => regionsFromEnv(env).get("default").db;
const op: EditOperation = {
  kind: "text",
  target: {
    schema: 1,
    path: "index.html",
    anchor: {
      kind: "text",
      quote: { exact: "draft", prefix: "", suffix: "" },
      position: { start: 5, end: 10 },
    },
  },
  after: "final",
};
let h: Harness;
let owner: TokenClient;
let artifactId: string;
let versionId: string;
const base = () => `/api/v1/artifacts/${artifactId}`;
function session(path: string, method: string, body?: unknown, key = crypto.randomUUID()) {
  return h.request(path, {
    method,
    headers: {
      cookie: owner.cookie,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
  h = createHarness({ env: { SUGGESTIONS_ENABLED: "true" } });
  owner = await tokenClient(
    h,
    `pf267-${crypto.randomUUID()}@example.test`,
    "artifacts:read artifacts:write annotations:read annotations:write offline_access",
  );
  artifactId = await publishSite(owner, "Plan draft");
  await db()
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, artifactId));
  const [row] = await db()
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  versionId = row?.currentVersionId ?? "";
});

// Finding 3: a replayed acceptance answers under the caller's current authorization.
it.each(["suggestion", "draft"] as const)(
  "rechecks access when replaying %s acceptance",
  async (kind) => {
    let prefix: string;
    if (kind === "suggestion") {
      const submitted = await session(`${base()}/suggestions`, "POST", {
        versionId,
        edit: { operations: [op] },
        body: "Better word",
      });
      expect(submitted.status).toBe(201);
      prefix = `${base()}/suggestions/${(await submitted.json<{ id: string }>()).id}`;
    } else {
      const saved = await session(`${base()}/draft`, "PUT", {
        baseVersionId: versionId,
        edit: { operations: [op] },
        baseRevision: null,
        baseIncarnation: null,
      });
      expect(saved.status).toBe(200);
      prefix = `${base()}/draft`;
    }
    const planned = await session(`${prefix}/plan`, "POST");
    expect(planned.status).toBe(200);
    const plan = Plan.parse(await planned.json());
    const path = `${prefix}/${kind === "suggestion" ? "accept" : "publish"}`;
    const key = crypto.randomUUID();
    expect((await session(path, "POST", { digest: plan.digest }, key)).status).toBe(202);
    const other = await tokenClient(h, `pf267-other-${crypto.randomUUID()}@example.test`);
    await db()
      .update(schema.artifacts)
      .set({ ownerId: other.userId })
      .where(eq(schema.artifacts.id, artifactId));
    const fresh = await session(path, "POST", { digest: plan.digest });
    expect(fresh.status).toBe(404);
    const replay = await session(path, "POST", { digest: plan.digest }, key);
    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual(await fresh.json());
  },
);

// Finding 6: submitting answers the suggestion thread view its route table declares.
it("returns the declared SuggestionThreadView from submitting", async () => {
  const key = crypto.randomUUID();
  const body = { versionId, edit: { operations: [op] }, body: "Better word" };
  const submitted = await session(`${base()}/suggestions`, "POST", body, key);
  expect(submitted.status).toBe(201);
  const view = SuggestionThreadView.parse(await submitted.json());
  expect(view).toMatchObject({ kind: "suggestion", suggestion: { state: "pending" } });
  const replayed = await session(`${base()}/suggestions`, "POST", body, key);
  expect(replayed.status).toBe(201);
  expect(SuggestionThreadView.parse(await replayed.json())).toEqual(view);
});

it("refuses a missing or reused idempotency key and a stale version on the viewer's writes", async () => {
  const send = (path: string, body: unknown, key: string | null) =>
    h.request(path, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
        "content-type": "application/json",
        ...(key === null ? {} : { "idempotency-key": key }),
      },
      body: JSON.stringify(body),
    });
  const suggestion = { versionId, edit: { operations: [op] }, body: "Better word" };
  expect((await send(`${base()}/suggestions`, suggestion, null)).status).toBe(400);
  const key = crypto.randomUUID();
  const created = await send(`${base()}/suggestions`, suggestion, key);
  expect(created.status).toBe(201);
  const threadId = (await created.json<{ id: string }>()).id;
  expect((await send(`${base()}/suggestions`, { ...suggestion, body: "Other" }, key)).status).toBe(
    400,
  );
  const stale = await send(
    `${base()}/suggestions`,
    { ...suggestion, versionId: "ver_old" },
    crypto.randomUUID(),
  );
  expect(stale.status).toBe(409);
  const digest = { digest: "0".repeat(64) };
  for (const path of [`${base()}/suggestions/${threadId}/accept`, `${base()}/draft/publish`]) {
    expect((await send(path, digest, null)).status, path).toBe(400);
    const once = crypto.randomUUID();
    const refused = await send(path, digest, once);
    expect(refused.status, path).toBeGreaterThanOrEqual(400);
    // A stored refusal replays as it was; another body under the same key is refused.
    const again = await send(path, digest, once);
    expect(again.status, path).toBe(refused.status);
    expect((await send(path, { digest: "1".repeat(64) }, once)).status, path).toBe(400);
  }
});
