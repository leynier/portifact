// Calls to Slack's Web API (decision 0025, "Calls to Slack"): every answer class, bounded and
// never followed, against FakeSlack and scripted answers. Nothing here reaches Slack.
import { describe, expect, it } from "vitest";
import { slackAuthTest, slackCall, slackRevoke } from "../src/slack-client.ts";
import { FakeSlack } from "../src/testing/fake-slack.ts";

describe("a call to Slack", () => {
  it("classifies each kind of answer", async () => {
    const token = FakeSlack.botToken();
    const fake = new FakeSlack().bot(token);
    const call = () => slackCall("auth.test", token, {}, { fetch: fake.fetch, timeoutMs: 50 });
    expect((await call()).kind).toBe("ok");
    fake.next("network");
    expect(await call()).toEqual({ kind: "failed" });
    fake.next("hang");
    expect(await call()).toEqual({ kind: "failed" });
    fake.next(new Response("slow down", { status: 429 }));
    expect(await call()).toEqual({ kind: "rate_limited" });
    fake.next(new Response("oops", { status: 500 }));
    expect(await call()).toEqual({ kind: "failed" });
    fake.next(new Response("not json", { status: 200 }));
    expect(await call()).toEqual({ kind: "failed" });
    fake.next(Response.json([1, 2]));
    expect(await call()).toEqual({ kind: "failed" });
    fake.next(new Response("x".repeat(17 * 1024), { status: 200 }));
    expect(await call()).toEqual({ kind: "failed" });
    fake.next(Response.json({ ok: false }));
    expect(await call()).toEqual({ kind: "failed" });
    fake.next(Response.json({ ok: false, error: "missing_scope" }));
    expect(await call()).toEqual({ kind: "rejected" });
    fake.next(new Response(null, { status: 200 }));
    expect(await call()).toEqual({ kind: "failed" });
  });

  it("reads auth.test only for a bot of a Slack workspace with a valid ID", async () => {
    const token = FakeSlack.botToken();
    const fake = new FakeSlack().bot(token, "Acme‮ Corp", "T0ACME01");
    expect(await slackAuthTest(token, { fetch: fake.fetch })).toEqual({
      ok: true,
      team: "Acme Corp",
      teamId: "T0ACME01",
    });
    fake.next(Response.json({ ok: true, bot_id: "B1", team_id: "lower-case" }));
    expect(await slackAuthTest(token, { fetch: fake.fetch })).toEqual({
      ok: false,
      problem: "service_unavailable",
    });
    fake.next(Response.json({ ok: true, bot_id: "B1", team_id: "T1", team: 7 }));
    expect(await slackAuthTest(token, { fetch: fake.fetch })).toEqual({
      ok: true,
      team: "T1",
      teamId: "T1",
    });
    fake.next(Response.json({ ok: false, error: "ratelimited" }));
    expect(await slackAuthTest(token, { fetch: fake.fetch })).toEqual({
      ok: false,
      problem: "rate_limited",
    });
    expect(await slackAuthTest("xoxb-unknown-token-000000", { fetch: fake.fetch })).toEqual({
      ok: false,
      problem: "credential_rejected",
    });
  });

  it("revokes a token, and calls only slack.com with the token as a bearer", async () => {
    const token = FakeSlack.botToken();
    const fake = new FakeSlack().bot(token);
    expect((await slackRevoke(token, { fetch: fake.fetch })).kind).toBe("ok");
    expect(fake.revoked.has(token)).toBe(true);
    expect(fake.requests).toEqual([
      expect.objectContaining({
        url: "https://slack.com/api/auth.revoke",
        method: "POST",
        headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
      }),
    ]);
    expect((await slackRevoke(token, { fetch: fake.fetch })).kind).toBe("rejected");
  });
});
