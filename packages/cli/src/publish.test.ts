import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Of } from "./testing/fake-api.ts";
import { type FakeServer, type RecordedRequest, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);

/** A site with files that must be left out next to the ones to publish. */
function site() {
  return h.files("site", {
    "index.html": "<h1>Report</h1>",
    "css/app.css": "h1 { color: teal; }",
    "img/logo.png": PNG,
    ".git/config": "[core]",
    "node_modules/lib/index.js": "module.exports = 1;",
    ".cache/state": "cached",
    ".env": "TOKEN=do-not-upload",
    ".env.example": "TOKEN=",
    "keys/server.pem": "-----BEGIN PRIVATE KEY-----",
    ".DS_Store": "junk",
  });
}

function apiRequests(path: RegExp, method?: string): RecordedRequest[] {
  return server.requests.filter((r) => path.test(r.path) && (!method || r.method === method));
}

function prepareBody(index = 0) {
  const request = apiRequests(/^\/api\/v1\/publishes$/, "POST")[index];
  return request ? JSON.parse(request.body) : undefined;
}

/** No issued token may appear in anything the CLI prints. */
function expectNoSecrets(output: { stdout: string; stderr: string }) {
  for (const token of server.issuedTokens)
    expect(output.stdout + output.stderr).not.toContain(token);
}

describe("portifact publish with the owner's plan", () => {
  // Injected small limits stand in for real sizes: a free plan whose versions hold 20 bytes and
  // a Pro plan whose versions hold 100, with a single 60-byte file between them.
  const file = () => h.files("big", { "data.txt": "x".repeat(60) });

  it("checks a single file against the plan's per-artifact size before uploading", async () => {
    h.signIn();
    server.api.usage.plan.limits.artifactBytes = 20;
    const refused = await h.invoke("publish", join(await file(), "data.txt"));
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("An artifact can hold at most 20 B.");
    expect(apiRequests(/^\/api\/v1\/publishes$/, "POST")).toHaveLength(0);
  });

  it("publishes a single file above the free size within a Pro plan", async () => {
    h.signIn();
    server.api.usage.plan = { ...server.api.usage.plan, name: "pro" };
    server.api.usage.plan.limits.artifactBytes = 100;
    const result = await h.invoke("publish", join(await file(), "data.txt"));
    expect(result.code).toBe(0);
    expect(prepareBody()?.files).toEqual([expect.objectContaining({ path: "data.txt", size: 60 })]);
    expect(apiRequests(/^\/api\/v1\/usage$/, "GET")).toHaveLength(1);
  });

  it("checks private sources against the plan's storage", async () => {
    h.signIn();
    server.api.usage.plan.limits.accountBytes = 30;
    const folder = await site();
    const sources = await h.files("src", { "main.ts": "y".repeat(40) });
    const refused = await h.invoke("publish", folder, "--source", sources);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("An artifact can hold at most 30 B.");
  });

  it("checks only the safety caps in a dry run, which does not know the plan", async () => {
    server.api.usage.plan.limits.artifactBytes = 20;
    const result = await h.invoke("publish", join(await file(), "data.txt"), "--dry-run");
    expect(result.code).toBe(0);
    expect(apiRequests(/./)).toHaveLength(0);
  });
});

describe("portifact publish", () => {
  it("publishes a folder, leaving out version control, dependencies, caches and secrets", async () => {
    h.signIn();
    const folder = await site();

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    const [artifact] = [...server.api.artifacts.values()];
    expect(artifact).toBeDefined();
    expect(result.stdout).toBe(
      [
        `Published version 1 of ${artifact?.id}.`,
        `URL: https://${artifact?.id}.portifact.dev/`,
        "Expires: 2026-12-08 12:00 UTC",
        "",
      ].join("\n"),
    );
    expect(artifact?.access.mode).toBe("restricted");
    expect(artifact?.name).toBe("site");

    const body = prepareBody();
    expect(body).toEqual({
      type: "site",
      name: "site",
      entrypoint: "index.html",
      baseVersionId: null,
      files: [
        {
          path: ".env.example",
          kind: "published",
          sha256: sha256Of("TOKEN="),
          size: 6,
          contentType: "application/octet-stream",
        },
        {
          path: "css/app.css",
          kind: "published",
          sha256: sha256Of("h1 { color: teal; }"),
          size: 19,
          contentType: "text/css; charset=utf-8",
        },
        {
          path: "img/logo.png",
          kind: "published",
          sha256: sha256Of(PNG),
          size: PNG.length,
          contentType: "image/png",
        },
        {
          path: "index.html",
          kind: "published",
          sha256: sha256Of("<h1>Report</h1>"),
          size: 15,
          contentType: "text/html; charset=utf-8",
        },
      ],
      multipart: true,
    });

    // The stored bytes are exactly the local files, and nothing excluded reached storage.
    expect(server.api.stored.get(sha256Of(PNG))).toEqual(PNG);
    expect(server.api.stored.size).toBe(4);
    for (const put of server.api.puts) {
      expect(put.status).toBe(200);
      expect(put.headers.authorization).toBeUndefined();
      expect(put.headers["content-length"]).toBe(String(put.bytes));
      expect(put.headers["x-amz-checksum-sha256"]).toBe(
        Buffer.from(put.sha256, "hex").toString("base64"),
      );
    }

    // The manifest is shown before uploading, with what was left out and why.
    expect(result.stderr).toContain("4 files (52 B) to publish as site:\n");
    expect(result.stderr).toContain("  img/logo.png  12 B\n");
    expect(result.stderr).toContain("Left out 6 entries by default:\n");
    expect(result.stderr).toContain("  .env  (may hold secrets)\n");
    expect(result.stderr).toContain("  keys/server.pem  (may hold secrets)\n");
    expect(result.stderr).toContain("  node_modules  (not published by default)\n");
    expect(result.stderr).toContain("  .git  (not published by default)\n");
    expect(result.stderr).toContain("Prepared version 1. Uploading 4 of 4 files (52 B).\n");
    expect(result.stderr).toContain("Uploaded 4 of 4 (52 B of 52 B).\n");
    expect(result.stderr.indexOf("to publish as site")).toBeLessThan(
      result.stderr.indexOf("Prepared version"),
    );
    expectNoSecrets(result);
  });

  it("prints a stable JSON result with --json and keeps progress on stderr", async () => {
    h.signIn();
    const folder = await h.files("docs", { "index.html": "<p>Hi</p>" });

    const result = await h.invoke("publish", folder, "--json", "--name", "  Quarterly report  ");

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(Object.keys(output)).toEqual([
      "artifactId",
      "versionId",
      "versionNumber",
      "url",
      "expiresAt",
      "uploadId",
      "files",
      "totalBytes",
      "sourceFiles",
      "sourceBytes",
      "sourceOrigin",
      "uploadedFiles",
      "uploadedBytes",
      "workspace",
    ]);
    expect(output).toMatchObject({
      versionNumber: 1,
      url: `https://${output.artifactId}.portifact.dev/`,
      expiresAt: "2026-12-08T12:00:00.000Z",
      files: 1,
      totalBytes: 9,
      uploadedFiles: 1,
      uploadedBytes: 9,
      workspace: null,
    });
    expect(result.stdout.split("\n")).toHaveLength(2);
    expect(result.stderr).toContain("Uploaded 1 of 1");
    expect(prepareBody().name).toBe("Quarterly report");
  });

  it("publishes a single HTML file as the site's index page", async () => {
    h.signIn();
    const folder = await h.files("single", { "informe.html": "<h1>Informe</h1>" });

    const result = await h.invoke("publish", join(folder, "informe.html"), "--json");

    expect(result.code).toBe(0);
    const body = prepareBody();
    expect(body.type).toBe("site");
    expect(body.name).toBe("informe.html");
    expect(body.entrypoint).toBe("index.html");
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
  });

  it("infers markdown and text from the extension and keeps the file name", async () => {
    h.signIn();
    const folder = await h.files("docs", { "plan.md": "# Plan", "notes.TXT": "<b>raw</b>" });

    expect((await h.invoke("publish", join(folder, "plan.md"))).code).toBe(0);
    expect((await h.invoke("publish", join(folder, "notes.TXT"))).code).toBe(0);

    expect(prepareBody(0)).toMatchObject({
      type: "markdown",
      entrypoint: "plan.md",
      files: [{ path: "plan.md", contentType: "text/markdown; charset=utf-8" }],
    });
    expect(prepareBody(1)).toMatchObject({
      type: "text",
      entrypoint: "notes.TXT",
      files: [{ path: "notes.TXT", contentType: "text/plain; charset=utf-8" }],
    });
  });

  it("uses --type for files whose type cannot be inferred and refuses without it", async () => {
    h.signIn();
    const folder = await h.files("logs", { "build.log": "ok" });

    const refused = await h.invoke("publish", join(folder, "build.log"), "--json");
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).error.code).toBe("invalid_input");
    expect(JSON.parse(refused.stdout).error.message).toContain("--type");

    const accepted = await h.invoke("publish", join(folder, "build.log"), "--type", "text");
    expect(accepted.code).toBe(0);
    expect(prepareBody().type).toBe("text");
  });

  it("refuses to publish a folder as markdown or text", async () => {
    h.signIn();
    const folder = await site();

    const result = await h.invoke("publish", folder, "--type", "markdown");

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("A folder can only be published as a site");
    expect(apiRequests(/^\/api\/v1\/publishes/)).toHaveLength(0);
  });

  it("rejects an unknown --type as invalid usage", async () => {
    const result = await h.invoke("publish", ".", "--type", "zip");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Allowed choices are site, markdown, text");
  });

  it("uploads only the objects the API asks for", async () => {
    h.signIn();
    const folder = await site();
    // The account already stores the logo from an earlier publish.
    server.api.stored.set(sha256Of(PNG), PNG);

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ files: 4, uploadedFiles: 3 });
    expect(server.api.puts.map((put) => put.sha256)).not.toContain(sha256Of(PNG));
    expect(server.api.puts).toHaveLength(3);
  });

  it("commits without uploading when every object is already stored", async () => {
    h.signIn();
    const folder = await h.files("same", { "index.html": "<p>Same</p>" });
    server.api.stored.set(sha256Of("<p>Same</p>"), Buffer.from("<p>Same</p>"));

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    expect(server.api.puts).toHaveLength(0);
    expect(result.stderr).toContain("Every file is already stored, so nothing needs uploading.");
  });

  it("publishes a new version on top of the current one, keeping its name and access", async () => {
    h.signIn();
    const existing = server.api.seed({
      name: "Launch plan",
      access: {
        mode: "public",
        readers: [],
        indexable: false,
        embeddable: false,
        bar: true,
        commentVisibility: "owner",
        readerCommentVisibility: [],
      },
    });
    const baseVersionId = existing.currentVersionId;
    const folder = await h.files("v2", { "index.html": "<p>v2</p>" });

    const result = await h.invoke("publish", folder, "--artifact", existing.id, "--json");

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ artifactId: existing.id, versionNumber: 2 });
    expect(prepareBody()).toMatchObject({
      artifactId: existing.id,
      name: "Launch plan",
      type: "site",
      baseVersionId,
    });
    // Publishing never touches the access policy.
    expect(apiRequests(/\/access$/)).toHaveLength(0);
    expect(server.api.artifacts.get(existing.id)?.access.mode).toBe("public");
  });

  it("takes the type of the artifact it updates and refuses a different one", async () => {
    h.signIn();
    const existing = server.api.seed({ type: "markdown" });
    const folder = await h.files("doc", { "readme.txt": "# Title" });

    const inferred = await h.invoke(
      "publish",
      join(folder, "readme.txt"),
      "--artifact",
      existing.id,
    );
    expect(inferred.code).toBe(0);
    expect(prepareBody().type).toBe("markdown");

    const conflicting = await h.invoke(
      "publish",
      join(folder, "readme.txt"),
      "--artifact",
      existing.id,
      "--type",
      "text",
    );
    expect(conflicting.code).toBe(2);
    expect(conflicting.stderr).toContain("This artifact is a markdown");
    expect(apiRequests(/^\/api\/v1\/publishes$/)).toHaveLength(1);
  });

  it("reports an artifact that does not exist and a malformed ID", async () => {
    h.signIn();
    const folder = await h.files("v2", { "index.html": "x" });

    const missing = await h.invoke("publish", folder, "--artifact", "aaaaaaaaaa", "--json");
    expect(missing.code).toBe(5);
    expect(JSON.parse(missing.stdout)).toEqual({
      error: { code: "not_found", message: "Artifact not found." },
    });

    const malformed = await h.invoke("publish", folder, "--artifact", "../etc");
    expect(malformed.code).toBe(2);
    expect(malformed.stderr).toContain("is not an artifact ID");
  });

  it("reports a version conflict with its own exit code", async () => {
    h.signIn();
    const existing = server.api.seed();
    const folder = await h.files("v2", { "index.html": "x" });
    // Another publish moved the artifact between the read and the prepare.
    server.faults.push({
      method: "POST",
      path: /^\/api\/v1\/publishes$/,
      effect: () => {
        existing.currentVersionId = "ver_other";
      },
    });

    const result = await h.invoke("publish", folder, "--artifact", existing.id, "--json");

    expect(result.code).toBe(6);
    expect(JSON.parse(result.stdout).error.code).toBe("version_conflict");
  });

  it("reports an archived artifact with the conflict exit code", async () => {
    h.signIn();
    const existing = server.api.seed({ state: "archived", expiresAt: null });
    const folder = await h.files("v2", { "index.html": "x" });

    const result = await h.invoke("publish", folder, "--artifact", existing.id, "--json");

    expect(result.code).toBe(6);
    expect(JSON.parse(result.stdout).error.code).toBe("artifact_archived");
  });

  it("retries a prepare whose answer was lost with the same idempotency key", async () => {
    h.signIn();
    const folder = await h.files("retry", { "index.html": "<p>Retry</p>" });
    server.faults.push({ method: "POST", path: /^\/api\/v1\/publishes$/, drop: "after" });

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(0);
    const prepares = apiRequests(/^\/api\/v1\/publishes$/, "POST");
    expect(prepares).toHaveLength(2);
    const keys = prepares.map((r) => r.headers["idempotency-key"]);
    expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(keys[1]).toBe(keys[0]);
    // The retry got the stored answer back: one upload session, one artifact.
    expect(server.api.sessions.size).toBe(1);
    expect(server.api.artifacts.size).toBe(1);
    expect(h.sleeps).toContain(1000);
  });

  it("uses a new idempotency key for each publish", async () => {
    h.signIn();
    const folder = await h.files("twice", { "index.html": "<p>Twice</p>" });

    await h.invoke("publish", folder);
    await h.invoke("publish", folder);

    const keys = apiRequests(/^\/api\/v1\/publishes$/, "POST").map(
      (r) => r.headers["idempotency-key"],
    );
    expect(new Set(keys).size).toBe(2);
    expect(server.api.artifacts.size).toBe(2);
  });

  it("gives up on a prepare that keeps failing, without leaving an upload behind", async () => {
    h.signIn();
    const folder = await h.files("down", { "index.html": "x" });
    for (let i = 0; i < 3; i++) {
      server.faults.push({ method: "POST", path: /^\/api\/v1\/publishes$/, drop: "before" });
    }

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("network_error");
    expect(server.api.sessions.size).toBe(0);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("does not retry a prepare the server refused", async () => {
    h.signIn();
    const folder = await h.files("quota", { "index.html": "x" });
    server.faults.push({
      method: "POST",
      path: /^\/api\/v1\/publishes$/,
      reply: {
        status: 429,
        body: { error: { code: "quota_exceeded", message: "You reached 50 active artifacts." } },
      },
    });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(7);
    expect(result.stderr).toContain("Error: You reached 50 active artifacts.");
    expect(apiRequests(/^\/api\/v1\/publishes$/, "POST")).toHaveLength(1);
  });

  it("resumes with fresh URLs when storage says a URL expired", async () => {
    h.signIn();
    const folder = await h.files("resume", { "index.html": "<p>Resume</p>" });
    server.faults.push({
      method: "PUT",
      path: /^\/r2\//,
      reply: { status: 403, body: "Request has expired" },
    });

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(0);
    expect(apiRequests(/^\/api\/v1\/publishes\/[^/]+$/, "GET")).toHaveLength(1);
    const puts = server.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(server.api.stored.has(sha256Of("<p>Resume</p>"))).toBe(true);
  });

  it("renews URLs that are about to expire before using them", async () => {
    h.signIn();
    server.api.urlTtlMs = 10_000;
    const folder = await h.files("late", { "a.html": "a", "index.html": "i", "b.css": "b" });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    // Every worker needed fresh URLs, and one request renewed them for all.
    const renewals = apiRequests(/^\/api\/v1\/publishes\/[^/]+$/, "GET");
    expect(renewals.length).toBeGreaterThanOrEqual(1);
    expect(renewals.length).toBeLessThanOrEqual(3);
    expect(server.api.puts.every((put) => put.status === 200)).toBe(true);
    expect(server.api.stored.size).toBe(3);
  });

  it("skips an object the server no longer needs after renewing the URLs", async () => {
    h.signIn();
    const folder = await h.files("gone", { "index.html": "<p>Gone</p>" });
    const sha = sha256Of("<p>Gone</p>");
    server.faults.push({
      method: "PUT",
      path: /^\/r2\//,
      reply: { status: 403, body: "Request has expired" },
      // Meanwhile another publish stored the same bytes.
      effect: () => server.api.stored.set(sha, Buffer.from("<p>Gone</p>")),
    });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("retries an upload after a transient storage failure", async () => {
    h.signIn();
    const folder = await h.files("flaky", { "index.html": "<p>Flaky</p>" });
    server.faults.push({
      method: "PUT",
      path: /^\/r2\//,
      reply: { status: 503, body: "SlowDown" },
    });
    server.faults.push({ method: "PUT", path: /^\/r2\//, drop: "before" });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(0);
    expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("cancels the upload when storage refuses a file", async () => {
    h.signIn();
    const folder = await site();
    for (let i = 0; i < 4; i++) {
      server.faults.push({
        method: "PUT",
        path: /^\/r2\//,
        reply: { status: 400, body: "BadDigest" },
      });
    }

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.error.code).toBe("upload_failed");
    expect(output.error.message).toMatch(/^Could not upload .+\. If it changed while publishing/);
    const [session] = [...server.api.sessions.values()];
    expect(session?.state).toBe("aborted");
    expect(apiRequests(/^\/api\/v1\/publishes\/[^/]+$/, "DELETE")).toHaveLength(1);
    expect(apiRequests(/\/commit$/)).toHaveLength(0);
    expect(server.api.artifacts.size).toBe(0);
    expect(result.stderr).toContain("Cancelled the upload and released its reservation.");
  });

  it("cancels the upload when the commit fails", async () => {
    h.signIn();
    const folder = await h.files("incomplete", { "index.html": "x" });
    server.faults.push({
      method: "POST",
      path: /\/commit$/,
      reply: {
        status: 409,
        body: { error: { code: "upload_incomplete", message: "Some files are missing." } },
      },
    });

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(6);
    expect(result.stderr).toContain("Error: Some files are missing.");
    expect([...server.api.sessions.values()][0]?.state).toBe("aborted");
  });

  it("says so when the upload cannot be cancelled either", async () => {
    h.signIn();
    const folder = await h.files("stuck", { "index.html": "x" });
    server.faults.push({ method: "PUT", path: /^\/r2\//, reply: { status: 400, body: "Bad" } });
    for (let i = 0; i < 3; i++) {
      server.faults.push({
        method: "DELETE",
        path: /^\/api\/v1\/publishes\//,
        reply: { status: 500 },
      });
    }

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Could not cancel the upload. Its reservation is released within 24 hours.",
    );
  });

  it("retries a commit whose answer was lost and gets the same result", async () => {
    h.signIn();
    const folder = await h.files("commit", { "index.html": "x" });
    server.faults.push({ method: "POST", path: /\/commit$/, drop: "after" });

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(0);
    expect(apiRequests(/\/commit$/)).toHaveLength(2);
    expect(JSON.parse(result.stdout).versionNumber).toBe(1);
  });

  it("refuses symbolic links inside a folder before contacting the server", async () => {
    h.signIn();
    const folder = await h.files("links", { "index.html": "x" });
    await symlink("/etc/passwd", join(folder, "passwd"));

    const result = await h.invoke("publish", folder);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("passwd is a symbolic link");
    expect(apiRequests(/^\/api\/v1\/publishes/)).toHaveLength(0);
  });

  it("refuses a path that is itself a symbolic link", async () => {
    const folder = await h.files("real", { "index.html": "x" });
    const link = join(h.workspace, "link");
    await symlink(folder, link);

    const result = await h.invoke("publish", link, "--dry-run");

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("is a symbolic link");
  });

  it.skipIf(process.platform === "win32")("refuses special files such as pipes", async () => {
    const folder = await h.files("special", { "index.html": "x" });
    execFileSync("mkfifo", [join(folder, "pipe")]);

    const inFolder = await h.invoke("publish", folder, "--dry-run");
    expect(inFolder.code).toBe(2);
    expect(inFolder.stderr).toContain("pipe is not a regular file or folder");

    const direct = await h.invoke("publish", join(folder, "pipe"), "--dry-run");
    expect(direct.code).toBe(2);
  });

  it("refuses to publish a secret or excluded file named directly", async () => {
    const folder = await h.files("secrets", { ".env.local": "KEY=1", id_ed25519: "key" });

    for (const name of [".env.local", "id_ed25519"]) {
      const result = await h.invoke("publish", join(folder, name), "--type", "text", "--dry-run");
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("looks like a file that holds secrets");
    }
    await mkdir(join(folder, "node_modules"));
    await writeFile(join(folder, "node_modules", "x.txt"), "x");
    const excluded = await h.invoke("publish", join(folder, "node_modules"), "--dry-run");
    expect(excluded.code).toBe(2);
    expect(excluded.stderr).toContain("is excluded by default");
  });

  it("requires the entry page and accepts another one with --entry", async () => {
    h.signIn();
    const folder = await h.files("docs-site", { "docs/start.html": "<p>Start</p>" });

    const missing = await h.invoke("publish", folder);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("The entry page index.html is not among the files");

    const custom = await h.invoke("publish", folder, "--entry", "./docs//start.html");
    expect(custom.code).toBe(0);
    expect(prepareBody().entrypoint).toBe("docs/start.html");
  });

  it("refuses paths the server would refuse: reserved, colliding or empty", async () => {
    const reserved = await h.files("reserved", {
      "index.html": "x",
      "__portifact/bridge.js": "x",
    });
    const result = await h.invoke("publish", reserved, "--dry-run");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("reserved");

    if (process.platform === "linux") {
      const colliding = await h.files("colliding", { "index.html": "x", "INDEX.html": "y" });
      const collision = await h.invoke("publish", colliding, "--dry-run");
      expect(collision.code).toBe(2);
      expect(collision.stderr).toContain("collides with another file");
    }

    const empty = await h.files("empty", { ".env": "x", "node_modules/a.js": "x" });
    const nothing = await h.invoke("publish", empty, "--dry-run");
    expect(nothing.code).toBe(2);
    expect(nothing.stderr).toContain("has no files to publish");

    const absent = await h.invoke("publish", join(h.workspace, "absent"), "--dry-run");
    expect(absent.code).toBe(2);
    expect(absent.stderr).toContain("does not exist");
  });

  it("prints the manifest with --dry-run without signing in or uploading", async () => {
    const folder = await site();

    const text = await h.invoke("publish", folder, "--dry-run");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("4 files (52 B) to publish as site:\n");
    expect(text.stdout).toContain("  index.html  15 B\n");
    expect(text.stdout).toContain("  .env  (may hold secrets)\n");
    expect(text.stderr).toBe("Dry run: nothing was uploaded.\n");

    const json = await h.invoke("publish", folder, "--dry-run", "--json");
    expect(json.code).toBe(0);
    const output = JSON.parse(json.stdout);
    expect(output).toEqual({
      dryRun: true,
      type: "site",
      name: "site",
      entrypoint: "index.html",
      totalBytes: 52,
      files: expect.any(Array),
      excluded: [
        { path: ".cache", reason: "default" },
        { path: ".DS_Store", reason: "default" },
        { path: ".env", reason: "secret" },
        { path: ".git", reason: "default" },
        { path: "keys/server.pem", reason: "secret" },
        { path: "node_modules", reason: "default" },
      ].sort((a, b) => (a.path < b.path ? -1 : 1)),
    });
    expect(output.files[0]).toEqual({
      path: ".env.example",
      size: 6,
      sha256: sha256Of("TOKEN="),
      contentType: "application/octet-stream",
    });
    expect(server.requests).toHaveLength(0);
  });

  it("asks to sign in before publishing", async () => {
    const folder = await h.files("anon", { "index.html": "x" });

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe("unauthenticated");
  });

  it("reports a session without the publishing scope", async () => {
    h.signIn(["artifacts:read", "offline_access"]);
    const folder = await h.files("scope", { "index.html": "x" });

    const result = await h.invoke("publish", folder, "--json");

    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: "forbidden",
      message:
        "This device's session does not allow that action. Run `portifact login` to sign in again.",
    });
  });
});
