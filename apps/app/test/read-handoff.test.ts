// The app's part of the entry to protected artifacts: GET /read/<id>?state=<nonce>.
// apps/content/test/read-session.test.ts covers the artifact origin's part.
import { env } from "cloudflare:workers";
import { createDb, schema } from "@portifact/db";
import { hashSecret, redeemReadHandoff } from "@portifact/services";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UNAVAILABLE_URL } from "../src/read.ts";
import { createHarness, type Harness } from "./harness.ts";

const ID = "k7d2qm4xab";
const STATE = "n".repeat(43);
const DAY = 86_400_000;
const db = () => createDb(env.DB);

const OWNER_EMAIL = "read-owner@example.com";
const READER_EMAIL = "read-reader@example.com";
const STRANGER_EMAIL = "read-stranger@example.com";

let h: Harness;
const cookies: Record<string, string> = {};

async function userId(email: string): Promise<string> {
  const [user] = await db().select().from(schema.users).where(eq(schema.users.email, email));
  if (!user) throw new Error(`no user ${email}`);
  return user.id;
}

async function seed(overrides: Partial<typeof schema.artifacts.$inferInsert> = {}) {
  await env.DB.exec("DELETE FROM read_handoffs");
  await env.DB.exec("DELETE FROM artifact_readers");
  await env.DB.exec("DELETE FROM artifacts");
  await db()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId: await userId(OWNER_EMAIL),
      type: "site",
      name: "Plan",
      state: "active",
      accessMode: "restricted",
      currentVersionId: "v1",
      expiresAt: Date.now() + 10 * DAY,
      ...overrides,
    });
  await db().insert(schema.artifactReaders).values({ artifactId: ID, email: READER_EMAIL });
}

function read(path: string, cookie?: string, init: RequestInit = {}) {
  return h.request(path, { ...init, headers: cookie ? { cookie } : {}, redirect: "manual" });
}

const entry = (cookie?: string, state = STATE, id = ID) =>
  read(`/read/${id}?state=${state}`, cookie);

async function handoffs() {
  return db().select().from(schema.readHandoffs);
}

function expectNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

beforeAll(async () => {
  h = createHarness();
  for (const email of [OWNER_EMAIL, READER_EMAIL, STRANGER_EMAIL]) {
    cookies[email] = await h.signIn(email);
  }
});

describe("read handoff", () => {
  beforeEach(() => seed());

  it("sends a visitor without a session to sign in and back to the same entry", async () => {
    const response = await entry();
    expect(response.status).toBe(303);
    expectNoStore(response);
    const location = new URL(response.headers.get("location") ?? "", "https://app.portifact.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(`/read/${ID}?state=${STATE}`);
    expect(await handoffs()).toHaveLength(0);
  });

  it("issues a one-use code to an allowed account and sends it to the artifact origin", async () => {
    const response = await entry(cookies[READER_EMAIL]);
    expect(response.status).toBe(303);
    expectNoStore(response);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      `https://${ID}.portifact.dev/__portifact/callback`,
    );
    expect([...location.searchParams.keys()]).toEqual(["code"]);
    const code = location.searchParams.get("code") ?? "";
    // The redirect carries no email, no session and no state.
    expect(location.toString()).not.toContain("example.com");
    expect(location.toString()).not.toContain(STATE);

    const [row] = await handoffs();
    expect(row).toMatchObject({
      codeHash: await hashSecret(code),
      stateHash: await hashSecret(STATE),
      artifactId: ID,
      userId: await userId(READER_EMAIL),
      policyGeneration: 1,
      usedAt: null,
    });

    // The artifact origin redeems it once, for this browser's transaction only.
    const redeem = (state: string) =>
      redeemReadHandoff(db(), { code, artifactId: ID, state, now: Date.now() });
    expect((await redeem("x".repeat(43))).ok).toBe(false);
    expect(await redeem(STATE)).toMatchObject({
      ok: true,
      value: { userId: await userId(READER_EMAIL) },
    });
    expect((await redeem(STATE)).ok).toBe(false);
  });

  it("admits the owner and readers of restricted artifacts and any account otherwise", async () => {
    expect((await entry(cookies[OWNER_EMAIL])).headers.get("location")).toContain("/__portifact/");
    await seed({ accessMode: "authenticated" });
    expect((await entry(cookies[STRANGER_EMAIL])).headers.get("location")).toContain(
      "/__portifact/",
    );
  });

  it("answers a forbidden, missing or unavailable artifact the same way", async () => {
    const answers: (string | null)[] = [];
    answers.push((await entry(cookies[STRANGER_EMAIL])).headers.get("location"));
    answers.push((await entry(cookies[OWNER_EMAIL], STATE, "zzzzzzzzzz")).headers.get("location"));
    for (const overrides of [
      { state: "archived" as const, archivedAt: Date.now() - DAY },
      { state: "suspended" as const },
      { expiresAt: Date.now() - 1 },
      { currentVersionId: null },
    ]) {
      await seed(overrides);
      answers.push((await entry(cookies[OWNER_EMAIL])).headers.get("location"));
    }
    expect(answers).toEqual(answers.map(() => UNAVAILABLE_URL));
    expect(await handoffs()).toHaveLength(0);
  });

  it("stops issuing codes once access is revoked", async () => {
    expect((await entry(cookies[READER_EMAIL])).headers.get("location")).toContain("/__portifact/");
    await db().delete(schema.artifactReaders).where(eq(schema.artifactReaders.artifactId, ID));
    await db()
      .update(schema.artifacts)
      .set({ policyGeneration: 2 })
      .where(eq(schema.artifacts.id, ID));
    const response = await entry(cookies[READER_EMAIL]);
    expect(response.headers.get("location")).toBe(UNAVAILABLE_URL);
    expectNoStore(response);
  });

  it("takes the account from the session, never from the request", async () => {
    const stranger = await userId(STRANGER_EMAIL);
    const response = await read(
      `/read/${ID}?state=${STATE}&userId=${stranger}&user_id=${stranger}`,
      cookies[READER_EMAIL],
    );
    expect(response.headers.get("location")).toContain("/__portifact/");
    const [row] = await handoffs();
    expect(row?.userId).toBe(await userId(READER_EMAIL));
  });

  it("refuses malformed entries without issuing a code", async () => {
    const reader = cookies[READER_EMAIL];
    for (const path of [
      `/read/${ID}`,
      `/read/${ID}?state=short`,
      `/read/${ID}?state=${STATE}&state=${STATE}`,
      `/read/NOT-AN-ID?state=${STATE}`,
    ]) {
      expect((await read(path, reader)).headers.get("location"), path).toBe(UNAVAILABLE_URL);
    }
    const head = await read(`/read/${ID}?state=${STATE}`, reader, { method: "HEAD" });
    expect(head.headers.get("location")).toBe(UNAVAILABLE_URL);
    expect((await read(`/read/${ID}?state=${STATE}`, reader, { method: "POST" })).status).toBe(404);
    expect(await handoffs()).toHaveLength(0);
  });

  it("serves the entry only on the app host", async () => {
    const response = await read(`https://portifact.com/read/${ID}?state=${STATE}`);
    expect(response.status).toBe(404);
  });
});
