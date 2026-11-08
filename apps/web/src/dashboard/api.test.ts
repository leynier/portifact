import { UNTRUSTED_ANNOTATIONS_NOTICE } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { ApiFailure, dashboardApi, type FetchLike } from "./api.ts";
import { artifact, DEFAULT_ACTIVITY } from "./test-support.tsx";

function client(answer: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { path: string; init: RequestInit }[] = [];
  let signedOut = 0;
  const fetch: FetchLike = async (path, init = {}) => {
    calls.push({ path, init });
    return answer(path, init);
  };
  const api = dashboardApi({ fetch, onUnauthenticated: () => (signedOut += 1) });
  return { api, calls, signedOut: () => signedOut };
}

async function failure(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiFailure) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("dashboard API client", () => {
  it("lists artifacts with the cursor, same-origin credentials and validated output", async () => {
    const page = {
      items: [{ ...artifact("k7d2qm4xab"), activity: DEFAULT_ACTIVITY }],
      nextCursor: "c2",
    };
    const { api, calls } = client(() => Response.json(page));
    expect(await api.listArtifacts()).toEqual(page);
    await api.listArtifacts("c2");
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/artifacts", "/api/v1/artifacts?cursor=c2"]);
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "same-origin" });
    // An item without its activity is not the documented shape.
    const old = client(() => Response.json({ items: [artifact("k7d2qm4xab")], nextCursor: null }));
    expect((await failure(old.api.listArtifacts())).code).toBe("unexpected");
  });

  it("sends only the filters given, so the API applies them", async () => {
    const { api, calls } = client(() => Response.json({ items: [], nextCursor: null }));
    await api.listArtifacts(undefined, { search: "plan & notes", state: "archived" });
    await api.listArtifacts("c2", {
      type: "site",
      access: "public",
      annotations: "open",
      search: "",
    });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/artifacts?search=plan+%26+notes&state=archived",
      "/api/v1/artifacts?cursor=c2&type=site&access=public&annotations=open",
    ]);
  });

  it("lists the threads of a version and exports them as JSON or Markdown", async () => {
    const exported = {
      notice: UNTRUSTED_ANNOTATIONS_NOTICE,
      exportedAt: "2026-11-08T12:00:00.000Z",
      artifact: {
        id: "k7d2qm4xab",
        name: "Plan",
        type: "site",
        annotations: "open",
        currentVersionId: "v1",
      },
      threads: [],
    };
    const { api, calls } = client((path) => {
      if (path.includes("format=markdown")) {
        return new Response("# Plan\n", { headers: { "content-type": "text/markdown" } });
      }
      if (path.includes("/export")) return Response.json(exported);
      return Response.json({ error: { code: "forbidden", message: "x" } }, { status: 403 });
    });
    expect((await failure(api.listAnnotations("k7d2qm4xab", undefined, "all"))).code).toBe(
      "forbidden",
    );
    await failure(api.listAnnotations("k7d2qm4xab", "9", "v1"));
    await failure(api.listAnnotations("k7d2qm4xab"));

    const json = await api.exportAnnotations("k7d2qm4xab", { format: "json", version: "all" });
    expect(json.fileName).toBe("k7d2qm4xab-annotations.json");
    expect(JSON.parse(await json.blob.text())).toEqual(exported);
    const markdown = await api.exportAnnotations("k7d2qm4xab", {
      format: "markdown",
      version: "current",
      state: "open",
    });
    expect(markdown.fileName).toBe("k7d2qm4xab-annotations.md");
    expect(await markdown.blob.text()).toBe("# Plan\n");
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/artifacts/k7d2qm4xab/annotations?version=all",
      "/api/v1/artifacts/k7d2qm4xab/annotations?cursor=9&version=v1",
      "/api/v1/artifacts/k7d2qm4xab/annotations",
      "/api/v1/artifacts/k7d2qm4xab/annotations/export?format=json&version=all",
      "/api/v1/artifacts/k7d2qm4xab/annotations/export?format=markdown&version=current&state=open",
    ]);
    expect(calls.at(-1)?.init.headers).toMatchObject({ accept: "text/markdown" });
  });

  it("refuses an export whose JSON is not an annotations export", async () => {
    const { api } = client(() => Response.json({ threads: "nope" }));
    expect(
      (await failure(api.exportAnnotations("k7d2qm4xab", { format: "json", version: "current" })))
        .code,
    ).toBe("unexpected");
  });

  it("sends lifecycle actions to their routes", async () => {
    const result = { state: "archived", expiresAt: null, purgeAt: "2027-05-08T12:00:00.000Z" };
    const { api, calls } = client(() => Response.json(result));
    expect(await api.lifecycle("k7d2qm4xab", "archive")).toEqual(result);
    await api.lifecycle("k7d2qm4xab", "renew");
    await api.lifecycle("k7d2qm4xab", "restore");
    await api.lifecycle("k7d2qm4xab", "delete");
    expect(calls.map((c) => `${c.init.method} ${c.path}`)).toEqual([
      "POST /api/v1/artifacts/k7d2qm4xab/archive",
      "POST /api/v1/artifacts/k7d2qm4xab/renew",
      "POST /api/v1/artifacts/k7d2qm4xab/restore",
      "DELETE /api/v1/artifacts/k7d2qm4xab",
    ]);
  });

  it("escapes artifact IDs in paths", async () => {
    const { api, calls } = client(() => Response.json(artifact("k7d2qm4xab")));
    await api.getArtifact("../me");
    expect(calls[0]?.path).toBe("/api/v1/artifacts/..%2Fme");
  });

  it("maps documented error codes and reports a lost session", async () => {
    const { api, signedOut } = client((path) =>
      path.endsWith("/restore")
        ? Response.json({ error: { code: "quota_exceeded", message: "x" } }, { status: 429 })
        : Response.json({ error: "invalid_token" }, { status: 401 }),
    );
    const quota = await failure(api.lifecycle("k7d2qm4xab", "restore"));
    expect([quota.code, quota.status]).toEqual(["quota_exceeded", 429]);
    expect(signedOut()).toBe(0);
    const lost = await failure(api.listArtifacts());
    expect(lost.code).toBe("unauthenticated");
    expect(signedOut()).toBe(1);
  });

  it("treats unknown errors, invalid bodies and lost connections as failures", async () => {
    const answers = [
      () => new Response("<html>", { status: 502 }),
      () => Response.json({ items: "nope" }),
      () => {
        throw new TypeError("offline");
      },
    ];
    const { api } = client(() => (answers.shift() as () => Response)());
    expect((await failure(api.listArtifacts())).code).toBe("unexpected");
    expect((await failure(api.listArtifacts())).code).toBe("unexpected");
    const offline = await failure(api.listArtifacts());
    expect([offline.code, offline.status, offline.name]).toEqual(["network", 0, "ApiFailure"]);
  });

  it("reads the signed-in account, or null without a session", async () => {
    const sessions = [
      { user: { email: "ada@example.test", name: null } },
      { user: { email: "ada@example.test", name: "Ada", createdAt: "2026-11-01T12:00:00.000Z" } },
      null,
    ];
    const { api, calls } = client(() => Response.json(sessions.shift()));
    expect(await api.account()).toEqual({ email: "ada@example.test", name: "", createdAt: null });
    expect(await api.account()).toEqual({
      email: "ada@example.test",
      name: "Ada",
      createdAt: "2026-11-01T12:00:00.000Z",
    });
    expect(await api.account()).toBeNull();
    expect(calls[0]?.path).toBe("/api/auth/get-session");
  });

  it("reads the account's usage", async () => {
    const usage = {
      activeArtifacts: { used: 1, limit: 50 },
      storage: { used: 10, limit: 2_500_000_000, reserved: 0 },
      publishesLast24h: { used: 1, limit: 100 },
      newFilesLast24h: { used: 1, limit: 10_000 },
      newBytesLast24h: { used: 10, limit: 5_000_000_000 },
      newObjectsThisMonth: { used: 1, limit: 100_000, resetsAt: "2026-12-01T00:00:00.000Z" },
      openUploads: { used: 0, limit: 2 },
      trafficThisMonth: {
        requests: { used: 5, limit: 1_000_000 },
        bytes: { used: 500, limit: 25_000_000_000 },
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
      versionLimits: { publishedBytes: 250_000_000, files: 1_000, documentBytes: 5_000_000 },
      publicAccessFrom: "2026-09-08T12:00:00.000Z",
      // Both the platform's protection and the account's traffic quota can block at once.
      blocks: [
        { reason: "capacity", stops: "publishing", message: "Paused", until: null },
        {
          reason: "traffic",
          stops: "serving",
          message: "Used up",
          until: "2026-12-01T00:00:00.000Z",
        },
      ],
    };
    const { api, calls } = client(() => Response.json(usage));
    expect(await api.usage()).toEqual(usage);
    expect(calls[0]).toMatchObject({ path: "/api/v1/usage", init: { method: "GET" } });
  });

  it("signs out with a same-origin JSON POST and reports failures", async () => {
    const answers = [
      () => Response.json({ success: true }),
      () => new Response(null, { status: 403 }),
      () => {
        throw new TypeError("offline");
      },
    ];
    const { api, calls } = client(() => (answers.shift() as () => Response)());
    await api.signOut();
    expect(calls[0]).toMatchObject({
      path: "/api/auth/sign-out",
      init: { method: "POST", credentials: "same-origin", body: "{}" },
    });
    expect((await failure(api.signOut())).code).toBe("unexpected");
    expect((await failure(api.signOut())).code).toBe("network");
  });

  it("reads and changes the access policy with a JSON PATCH", async () => {
    const policy = {
      mode: "restricted",
      readers: ["ana@example.com"],
      indexable: false,
      embeddable: false,
      policyGeneration: 3,
    };
    const { api, calls } = client(() => Response.json(policy));
    expect(await api.getAccess("k7d2qm4xab")).toEqual(policy);
    expect(await api.updateAccess("k7d2qm4xab", { addReaders: ["ana@example.com"] })).toEqual(
      policy,
    );
    expect(calls[0]).toMatchObject({
      path: "/api/v1/artifacts/k7d2qm4xab/access",
      init: { method: "GET", headers: { accept: "application/json" } },
    });
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[1]).toMatchObject({
      path: "/api/v1/artifacts/k7d2qm4xab/access",
      init: {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: '{"addReaders":["ana@example.com"]}',
      },
    });
  });

  it("reads sign-in methods, sessions and connected apps, and ends them by their routes", async () => {
    const at = "2026-11-08T12:00:00.000Z";
    const answers: Record<string, unknown> = {
      "GET /api/auth/list-accounts": [
        { id: "a1", providerId: "github", accountId: "42", createdAt: at, userId: "u" },
      ],
      "GET /api/v1/account/sessions": {
        items: [{ current: true, userAgent: null, createdAt: at, lastActiveAt: at, expiresAt: at }],
      },
      "POST /api/v1/account/sessions/sign-out-others": { signedOut: 2 },
      "GET /api/v1/account/apps": { items: [] },
      "DELETE /api/v1/account/apps/mcp%2Fclient": { clientId: "mcp/client", disconnected: true },
    };
    const { api, calls } = client((path, init) => Response.json(answers[`${init.method} ${path}`]));
    expect(await api.signInMethods()).toEqual([{ provider: "github", connectedAt: at }]);
    expect((await api.browserSessions()).items).toHaveLength(1);
    expect(await api.signOutOtherSessions()).toEqual({ signedOut: 2 });
    expect(await api.connectedApps()).toEqual({ items: [] });
    expect(await api.disconnectApp("mcp/client")).toEqual({
      clientId: "mcp/client",
      disconnected: true,
    });
    expect(calls).toHaveLength(5);
  });
});
