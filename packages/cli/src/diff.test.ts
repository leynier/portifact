import { PLANS, planRequiredMessage } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
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

const onPro = () => {
  server.api.usage.plan = {
    ...server.api.usage.plan,
    name: "pro",
    limits: { ...PLANS.pro.limits },
    features: [...PLANS.pro.features],
  };
};

/** A site with two versions: index.html changed, a file moved, a binary changed, a source added. */
function history() {
  const artifact = server.api.seed({ currentVersionId: null, versions: 0 });
  const v1 = server.api.seedVersion(artifact, {
    published: {
      "index.html": "<h1>One</h1>\n<p>same</p>\n",
      "old.txt": "moved\n",
      "logo.png": Buffer.from([1, 2, 3]),
    },
  });
  h.advance(60_000);
  const v2 = server.api.seedVersion(artifact, {
    published: {
      "index.html": "<h1>Two</h1>\n<p>same</p>\n",
      "new.txt": "moved\n",
      "logo.png": Buffer.from([1, 2, 4]),
    },
    source: { "notes.md": "notes\n" },
  });
  return { artifact, v1, v2 };
}

describe("portifact diff", () => {
  it("prints the files that changed between two versions, by number", async () => {
    h.signIn();
    onPro();
    const { artifact } = history();
    const result = await h.invoke("diff", artifact.id, "1", "v2");
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe(
      `Version 1 to 2 of ${artifact.id}: 2 added, 1 removed, 2 changed and 0 unchanged files.`,
    );
    expect(lines[1]).toMatch(/^CHANGE +KIND +PATH +BEFORE +AFTER$/);
    expect(result.stdout).toMatch(/changed +published +index\.html +25 B +25 B/);
    expect(result.stdout).toMatch(/added +published +new\.txt +- +6 B/);
    expect(result.stdout).toMatch(/removed +published +old\.txt +6 B +-/);
    expect(result.stdout).toMatch(/added +source +notes\.md/);
  });

  it("prints the summary as JSON with every page, and follows the cursor", async () => {
    h.signIn();
    onPro();
    const artifact = server.api.seed({ currentVersionId: null, versions: 0 });
    const many = (tag: string) =>
      Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}.txt`, `${tag} ${i}\n`]));
    server.api.seedVersion(artifact, { published: many("a") });
    const v2 = server.api.seedVersion(artifact, { published: many("b") });
    const result = await h.invoke("diff", artifact.id, "1", v2.id, "--json");
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.counts).toEqual({ added: 0, removed: 0, changed: 501, unchanged: 0 });
    expect(body.files).toHaveLength(501);
    expect(body.nextCursor).toBeNull();
    expect(server.requests.filter((r) => /\/diff\//.test(r.path))).toHaveLength(2);
  });

  it("prints a unified diff of one file with --file", async () => {
    h.signIn();
    onPro();
    const { artifact } = history();
    const result = await h.invoke("diff", artifact.id, "1", "current", "--file", "index.html");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "--- a/index.html (v1)",
        "+++ b/index.html (v2)",
        "@@ -1,2 +1,2 @@",
        "-<h1>One</h1>",
        "+<h1>Two</h1>",
        " <p>same</p>",
        "",
      ].join("\n"),
    );
    const json = await h.invoke("diff", artifact.id, "1", "2", "--file", "index.html", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({
      path: "index.html",
      change: "changed",
      diff: { status: "text", added: 1, removed: 1, nextCursor: null },
    });
  });

  it("diffs a private source with --source and says why there is no line diff", async () => {
    h.signIn();
    onPro();
    const { artifact } = history();
    const source = await h.invoke("diff", artifact.id, "1", "2", "--file", "notes.md", "--source");
    expect(source.stdout).toContain("+notes");
    const binary = await h.invoke("diff", artifact.id, "1", "2", "--file", "logo.png");
    expect(binary.code).toBe(0);
    expect(binary.stdout).toBe(
      "logo.png (changed) is not text, so there is no line diff. Size before: 3 B, after: 3 B.\n",
    );
  });

  it("refuses on free with the API's plan_required and exits 7", async () => {
    h.signIn();
    const { artifact } = history();
    const result = await h.invoke("diff", artifact.id, "1", "2", "--json");
    expect(result.code).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "plan_required", message: planRequiredMessage("versionDiff") },
    });
  });

  it("reports a version that is not retained and a missing file", async () => {
    h.signIn();
    onPro();
    const { artifact } = history();
    const missing = await h.invoke("diff", artifact.id, "1", "9", "--json");
    expect(JSON.parse(missing.stdout).error.code).toBe("not_found");
    const file = await h.invoke("diff", artifact.id, "1", "2", "--file", "nope.txt", "--json");
    expect(JSON.parse(file.stdout)).toEqual({
      error: { code: "not_found", message: "Neither version has this file." },
    });
    const bad = await h.invoke("diff", "not an id", "1", "2");
    expect(bad.code).not.toBe(0);
  });

  it("states the owner's retention after the version table", async () => {
    h.signIn();
    onPro();
    const { artifact } = history();
    const result = await h.invoke("versions", artifact.id);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      "The owner's plan keeps 50 previous versions for 90 days after each is replaced.",
    );
  });
});
