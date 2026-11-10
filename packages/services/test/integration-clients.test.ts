// The calls to GitHub and Linear (decision 0018) against scripted answers of the fake: how each
// answer of a credential check, an issue creation and a lookup is read, so every failure class
// reaches the person in the words it should. Nothing here reaches a real service.
import { describe, expect, it } from "vitest";
import { checkCredential, createIssue, findIssue } from "../src/integration-clients.ts";
import { FakeIssueTrackers } from "../src/testing/fake-issue-trackers.ts";

const TOKEN = "github-token-for-the-client-tests-0001";
const KEY = "linear-key-for-the-client-tests-00001";
const TEAM = "6f1d4c3a-1b2c-4d5e-8f90-0a1b2c3d4e5f";

function fake() {
  return new FakeIssueTrackers()
    .github(TOKEN, "octo-bot", ["Acme/Site"])
    .linear(KEY, "Lin Bot", [{ id: TEAM, name: "Engineering", key: "ENG" }]);
}

const gql = (errors: unknown[], status = 200) => Response.json({ errors }, { status });

describe("checking a GitHub token", () => {
  it("keeps GitHub's own spelling of a repository named in another case", async () => {
    const f = fake();
    expect(await checkCredential("github", TOKEN, ["acme/site"], { fetch: f.fetch })).toEqual({
      ok: true,
      identity: "octo-bot",
      targets: [{ id: "Acme/Site", name: "Acme/Site" }],
    });
  });

  it.each([
    [new Response("forbidden", { status: 403 }), "missing_permission"],
    [new Response("busy", { status: 503 }), "service_unavailable"],
    [Response.json({ message: "API rate limit exceeded" }, { status: 403 }), "rate_limited"],
    [Response.json({}), "service_unavailable"],
    [new Response("not json", { status: 200 }), "service_unavailable"],
  ])("reads the account answer %#", async (answer, problem) => {
    const f = fake().next(answer);
    expect(await checkCredential("github", TOKEN, ["acme/site"], { fetch: f.fetch })).toEqual({
      ok: false,
      problem,
      target: null,
    });
  });

  it.each([
    [Response.json({ message: "Bad credentials" }, { status: 401 }), "credential_rejected"],
    [new Response("busy", { status: 502 }), "service_unavailable"],
    [new Response(null, { status: 429, headers: { "retry-after": "5" } }), "rate_limited"],
    [new Response("gone", { status: 410 }), "target_unreachable"],
    [new Response("teapot", { status: 418 }), "service_unavailable"],
  ])("reads a repository answer %#", async (answer, problem) => {
    const f = fake();
    f.next(Response.json({ login: "octo-bot" }), answer);
    expect(await checkCredential("github", TOKEN, ["acme/site"], { fetch: f.fetch })).toEqual({
      ok: false,
      problem,
      target: "acme/site",
    });
  });

  it("keeps the admin's spelling when GitHub names no repository", async () => {
    const f = fake().next(
      Response.json({ login: "octo-bot" }),
      Response.json({ has_issues: true }),
    );
    expect(await checkCredential("github", TOKEN, ["acme/site"], { fetch: f.fetch })).toMatchObject(
      {
        targets: [{ id: "acme/site" }],
      },
    );
  });

  it("gives up on a slow or endless answer, and on a network error", async () => {
    const endless = new Response(new ReadableStream({ start() {} }), { status: 200 });
    const slowBody = fake().next(endless);
    expect(
      await checkCredential("github", TOKEN, ["acme/site"], {
        fetch: slowBody.fetch,
        timeoutMs: 20,
      }),
    ).toEqual({ ok: false, problem: "service_unavailable", target: null });
    const hang = fake().next("hang");
    expect(
      await checkCredential("github", TOKEN, ["acme/site"], { fetch: hang.fetch, timeoutMs: 20 }),
    ).toEqual({ ok: false, problem: "service_unavailable", target: null });
    const down = fake().next("network");
    expect(
      await checkCredential("github", TOKEN, ["acme/site"], { fetch: down.fetch }),
    ).toMatchObject({
      ok: false,
      problem: "service_unavailable",
    });
  });
});

describe("checking a Linear key", () => {
  it.each([
    [
      gql([{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }], 400),
      "credential_rejected",
    ],
    [gql([{ message: "x", extensions: { type: "forbidden" } }]), "missing_permission"],
    [gql([{ message: "x", extensions: { code: "RATELIMITED" } }]), "rate_limited"],
    [gql([{ message: "x", extensions: { code: "INVALID_INPUT" } }]), "service_unavailable"],
    [gql([{ message: "x" }]), "service_unavailable"],
    [Response.json({ data: { viewer: { name: "Lin" } } }), "service_unavailable"],
    [Response.json({ data: { teams: { nodes: [] } } }), "service_unavailable"],
  ])("reads the answer %#", async (answer, problem) => {
    const f = fake().next(answer);
    expect(await checkCredential("linear", KEY, [TEAM], { fetch: f.fetch })).toEqual({
      ok: false,
      problem,
      target: null,
    });
  });

  it("skips teams it cannot read and refuses a team it does not see", async () => {
    const f = fake().next(
      Response.json({
        data: {
          viewer: { name: "Lin" },
          teams: { nodes: [{ id: 7, name: "Bad" }, { id: TEAM }, null, { id: TEAM, name: "Eng" }] },
        },
      }),
    );
    expect(await checkCredential("linear", KEY, [TEAM], { fetch: f.fetch })).toEqual({
      ok: true,
      identity: "Lin",
      targets: [{ id: TEAM, name: "Eng" }],
    });
    const missing = fake().next(
      Response.json({ data: { viewer: { name: "Lin" }, teams: { nodes: [] } } }),
    );
    expect(await checkCredential("linear", KEY, [TEAM], { fetch: missing.fetch })).toEqual({
      ok: false,
      problem: "target_unreachable",
      target: TEAM,
    });
  });

  it("treats an empty list of errors as an answer", async () => {
    const f = fake().next(gql([]));
    expect(await checkCredential("linear", KEY, [TEAM], { fetch: f.fetch })).toMatchObject({
      ok: false,
      problem: "service_unavailable",
    });
  });
});

describe("creating an issue", () => {
  const input = { target: "acme/site", title: "T", body: "B" };

  it.each([
    [new Response(null, { status: 201 })],
    [Response.json({ html_url: "https://github.com/acme/site/issues/1" }, { status: 201 })],
    [Response.json({ number: 1 }, { status: 201 })],
  ])("refuses a GitHub answer without a usable issue %#", async (answer) => {
    const f = fake().next(answer);
    expect(await createIssue("github", TOKEN, input, { fetch: f.fetch })).toEqual({
      kind: "failed",
      verdict: { outcome: "failed", retryable: false, failure: "invalid_response" },
    });
  });

  it("refuses a Linear answer whose identifier is not one", async () => {
    const f = fake().next(
      Response.json({ data: { issueCreate: { success: true, issue: { identifier: "eng-1" } } } }),
    );
    expect(
      await createIssue("linear", KEY, { ...input, target: TEAM }, { fetch: f.fetch }),
    ).toMatchObject({
      kind: "failed",
      verdict: { failure: "invalid_response" },
    });
  });

  it("refuses a team the key cannot write to", async () => {
    const f = fake();
    expect(
      await createIssue(
        "linear",
        KEY,
        { ...input, target: "00000000-0000-4000-8000-000000000000" },
        { fetch: f.fetch },
      ),
    ).toMatchObject({ kind: "failed", verdict: { failure: "target_unreachable" } });
  });
});

describe("looking for a lost issue", () => {
  const lookup = { target: "acme/site", reference: "ti_x", identity: "octo-bot" };

  it("reports a refused or unreadable lookup instead of answering absent", async () => {
    for (const answer of [
      new Response("busy", { status: 503 }),
      Response.json({ not: "a list" }),
    ]) {
      const f = fake().next(answer);
      expect((await findIssue("github", TOKEN, lookup, { fetch: f.fetch })).kind).toBe("failed");
    }
    for (const answer of [
      gql([{ message: "x", extensions: { code: "RATELIMITED" } }]),
      Response.json({ data: {} }),
    ]) {
      const f = fake().next(answer);
      expect(
        (await findIssue("linear", KEY, { ...lookup, target: TEAM }, { fetch: f.fetch })).kind,
      ).toBe("failed");
    }
  });

  it("answers absent when nothing carries the reference", async () => {
    const f = fake();
    expect(await findIssue("github", TOKEN, lookup, { fetch: f.fetch })).toEqual({
      kind: "absent",
    });
    expect(await findIssue("linear", KEY, { ...lookup, target: TEAM }, { fetch: f.fetch })).toEqual(
      {
        kind: "absent",
      },
    );
  });
});
