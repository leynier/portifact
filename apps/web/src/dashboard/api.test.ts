import { describe, expect, it } from "vitest";
import { ApiFailure, dashboardApi, type FetchLike } from "./api.ts";
import { artifact } from "./test-support.tsx";

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
    const page = { items: [artifact("k7d2qm4xab")], nextCursor: "c2" };
    const { api, calls } = client(() => Response.json(page));
    expect(await api.listArtifacts()).toEqual(page);
    await api.listArtifacts("c2");
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/artifacts", "/api/v1/artifacts?cursor=c2"]);
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "same-origin" });
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
    const sessions = [{ user: { email: "ada@example.test", name: null } }, null];
    const { api, calls } = client(() => Response.json(sessions.shift()));
    expect(await api.account()).toEqual({ email: "ada@example.test", name: "" });
    expect(await api.account()).toBeNull();
    expect(calls[0]?.path).toBe("/api/auth/get-session");
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
});
